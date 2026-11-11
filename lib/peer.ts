/**
 * A direct, two-way WebRTC link between two browsers.
 *
 * Two pre-negotiated data channels are used, one per direction, so both
 * people can send files at the same time without interleaving chunks.
 * File bytes travel only over this DTLS-encrypted link — never via the server.
 */

export type LinkState = "connecting" | "open" | "closed" | "failed";

export type Transfer = {
  id: string;
  direction: "out" | "in";
  name: string;
  size: number;
  bytes: number;
  status: "queued" | "active" | "done" | "failed";
  url?: string;
};

type Control =
  | { t: "file"; id: string; name: string; size: number; mime: string }
  | { t: "end"; id: string }
  | { t: "ack"; id: string };

type Handlers = {
  onState: (state: LinkState) => void;
  onTransfer: (transfer: Transfer) => void;
};

const DEFAULT_CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PROGRESS_INTERVAL = 100;

const FALLBACK_ICE: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
let iceCache: { servers: RTCIceServer[]; at: number } | null = null;

/**
 * STUN + (if configured on the server) TURN relay servers. Cached for 10
 * minutes. Returns no servers when offline, so local pairing doesn't wait
 * on unreachable hosts.
 */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return [];
  if (iceCache && Date.now() - iceCache.at < 10 * 60_000) return iceCache.servers;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch("/api/ice", { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    const data = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (response.ok && Array.isArray(data.iceServers) && data.iceServers.length) {
      iceCache = { servers: data.iceServers, at: Date.now() };
      return data.iceServers;
    }
  } catch {
    // Fall through to public STUN.
  }
  return FALLBACK_ICE;
}

function waitForIce(pc: RTCPeerConnection, timeoutMs = 5000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

let counter = 0;
const newId = () => Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

export class PeerLink {
  private pc: RTCPeerConnection;
  private outChannel: RTCDataChannel;
  private inChannel: RTCDataChannel;
  private state: LinkState = "connecting";
  private queue: { transfer: Transfer; file: File }[] = [];
  private pumping = false;
  private pendingAcks = new Map<string, Transfer>();
  private incoming: { transfer: Transfer; mime: string; chunks: ArrayBuffer[]; lastEmit: number } | null = null;

  constructor(
    readonly initiator: boolean,
    private handlers: Handlers,
    iceServers: RTCIceServer[] = [],
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    // Initiator sends on 0 and receives on 1; the answerer mirrors that.
    const channelA = this.pc.createDataChannel("a", { negotiated: true, id: 0, ordered: true });
    const channelB = this.pc.createDataChannel("b", { negotiated: true, id: 1, ordered: true });
    [this.outChannel, this.inChannel] = initiator ? [channelA, channelB] : [channelB, channelA];

    for (const channel of [channelA, channelB]) {
      channel.binaryType = "arraybuffer";
      channel.addEventListener("open", () => this.checkOpen());
      channel.addEventListener("close", () => this.setState("closed"));
      channel.addEventListener("message", (event) => this.handleMessage(event));
    }
    this.outChannel.bufferedAmountLowThreshold = LOW_WATER;

    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    this.pc.addEventListener("connectionstatechange", () => {
      const state = this.pc.connectionState;
      clearTimeout(dropTimer);
      if (state === "failed") this.setState("failed");
      else if (state === "closed") this.setState("closed");
      // "disconnected" can recover on its own; give it a moment before giving up.
      else if (state === "disconnected" && this.state === "open") dropTimer = setTimeout(() => this.close(), 8000);
    });
  }

  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    return this.pc.localDescription!.sdp;
  }

  async acceptOffer(sdp: string) {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    return this.pc.localDescription!.sdp;
  }

  async acceptAnswer(sdp: string) {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  /** Which kinds of route each side offered (host = LAN, srflx = public IP, relay = TURN). */
  describeCandidates() {
    const types = (sdp = "") => [...new Set([...sdp.matchAll(/ typ (\w+)/g)].map((match) => match[1]))].join(", ") || "none";
    return "local: " + types(this.pc.localDescription?.sdp) + " · remote: " + types(this.pc.remoteDescription?.sdp);
  }

  get isOpen() {
    return this.state === "open";
  }

  send(files: File[]) {
    for (const file of files) {
      const transfer: Transfer = { id: newId(), direction: "out", name: file.name, size: file.size, bytes: 0, status: "queued" };
      this.queue.push({ transfer, file });
      this.handlers.onTransfer(transfer);
    }
    void this.pump();
  }

  close() {
    this.setState("closed");
    this.pc.close();
  }

  private setState(next: LinkState) {
    if (this.state === next || this.state === "closed" || this.state === "failed") return;
    this.state = next;
    if (next === "open") void this.pump();
    else this.failInFlight();
    this.handlers.onState(next);
  }

  private checkOpen() {
    if (this.outChannel.readyState === "open" && this.inChannel.readyState === "open") this.setState("open");
  }

  private failInFlight() {
    const failed = [...this.queue.map((entry) => entry.transfer), ...this.pendingAcks.values()];
    if (this.incoming) failed.push(this.incoming.transfer);
    this.queue = [];
    this.pendingAcks.clear();
    this.incoming = null;
    for (const transfer of failed) this.handlers.onTransfer({ ...transfer, status: "failed" });
  }

  private sendControl(message: Control) {
    if (this.outChannel.readyState === "open") this.outChannel.send(JSON.stringify(message));
  }

  private waitForBuffer() {
    const channel = this.outChannel;
    if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        channel.removeEventListener("bufferedamountlow", finish);
        channel.removeEventListener("close", finish);
        if (channel.readyState === "open") resolve();
        else reject(new Error("closed"));
      };
      channel.addEventListener("bufferedamountlow", finish);
      channel.addEventListener("close", finish);
    });
  }

  private async pump() {
    if (this.pumping || !this.isOpen) return;
    this.pumping = true;
    const chunkSize = Math.min(DEFAULT_CHUNK, this.pc.sctp?.maxMessageSize || DEFAULT_CHUNK);

    try {
      while (this.queue.length && this.isOpen) {
        const { transfer, file } = this.queue[0];
        let current: Transfer = { ...transfer, status: "active" };
        this.handlers.onTransfer(current);
        this.sendControl({ t: "file", id: transfer.id, name: file.name, size: file.size, mime: file.type || "application/octet-stream" });

        let offset = 0;
        let lastEmit = 0;
        while (offset < file.size) {
          await this.waitForBuffer();
          const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
          this.outChannel.send(chunk);
          offset += chunk.byteLength;
          const now = performance.now();
          if (now - lastEmit > PROGRESS_INTERVAL) {
            lastEmit = now;
            current = { ...current, bytes: offset };
            this.handlers.onTransfer(current);
          }
        }

        this.sendControl({ t: "end", id: transfer.id });
        this.queue.shift();
        current = { ...current, bytes: file.size };
        this.pendingAcks.set(transfer.id, current);
        this.handlers.onTransfer(current);
      }
    } catch {
      // The link closed mid-transfer; setState() has already marked items as failed.
    } finally {
      this.pumping = false;
    }
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") {
      const incoming = this.incoming;
      if (!incoming) return;
      incoming.chunks.push(event.data as ArrayBuffer);
      incoming.transfer.bytes += (event.data as ArrayBuffer).byteLength;
      const now = performance.now();
      if (now - incoming.lastEmit > PROGRESS_INTERVAL) {
        incoming.lastEmit = now;
        this.handlers.onTransfer({ ...incoming.transfer });
      }
      return;
    }

    let message: Control;
    try {
      message = JSON.parse(event.data) as Control;
    } catch {
      return;
    }

    if (message.t === "file") {
      const transfer: Transfer = { id: message.id, direction: "in", name: message.name, size: message.size, bytes: 0, status: "active" };
      this.incoming = { transfer, mime: message.mime, chunks: [], lastEmit: 0 };
      this.handlers.onTransfer({ ...transfer });
    } else if (message.t === "end" && this.incoming?.transfer.id === message.id) {
      const { transfer, chunks, mime } = this.incoming;
      this.incoming = null;
      if (transfer.bytes !== transfer.size) {
        this.handlers.onTransfer({ ...transfer, status: "failed" });
        return;
      }
      const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
      this.handlers.onTransfer({ ...transfer, status: "done", url });
      this.sendControl({ t: "ack", id: transfer.id });
    } else if (message.t === "ack") {
      const transfer = this.pendingAcks.get(message.id);
      if (transfer) {
        this.pendingAcks.delete(message.id);
        this.handlers.onTransfer({ ...transfer, status: "done" });
      }
    }
  }
}
