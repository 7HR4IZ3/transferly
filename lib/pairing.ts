/**
 * Client side of 6-digit pairing.
 *
 * Every device claims a random 6-digit code. The server only ever sees
 * SHA-256(code) as a mailbox id plus AES-GCM ciphertext; the AES key is derived
 * from the code itself, so only someone who knows the code can read or write
 * meaningful messages for that mailbox.
 */

export type SignalMessage =
  // request: "can I connect?" · accept / decline: the code owner's reply · cancel: requester gave up
  | { kind: "request" | "accept" | "decline" | "cancel"; from: string }
  | { kind: "offer"; from: string; sid: string; sdp: string }
  | { kind: "answer"; from: string; sid: string; sdp: string };

const CODE_LENGTH = 6;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

export function isValidCode(value: string) {
  return new RegExp("^\\d{" + CODE_LENGTH + "}$").test(value);
}

export function formatCode(code: string) {
  return code.slice(0, 3) + " " + code.slice(3);
}

export function randomToken(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function generateCode() {
  // Rejection sampling keeps every code equally likely.
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return String(buffer[0] % 1_000_000).padStart(CODE_LENGTH, "0");
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function mailboxId(code: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode("transferly/mailbox/v1:" + code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function codeKey(code: string) {
  let key = keyCache.get(code);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode("transferly/key/v1"), iterations: 150_000 },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keyCache.set(code, key);
  }
  return key;
}

async function seal(code: string, message: SignalMessage) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await codeKey(code), encoder.encode(JSON.stringify(message)));
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(cipher), iv.length);
  return toBase64Url(packed);
}

async function open(code: string, sealed: string): Promise<SignalMessage | null> {
  try {
    const packed = fromBase64Url(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, await codeKey(code), packed.slice(12));
    const message = JSON.parse(decoder.decode(plain)) as SignalMessage;
    if (!isValidCode(message.from)) return null;
    if (message.kind === "offer" || message.kind === "answer") {
      if (typeof message.sdp !== "string" || typeof message.sid !== "string") return null;
    } else if (!["request", "accept", "decline", "cancel"].includes(message.kind)) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}

export class PairingError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Pairing backend. When NEXT_PUBLIC_SIGNAL_URL points at the Cloudflare Worker
 * (see /worker), each device keeps one WebSocket open and messages arrive
 * instantly. Otherwise the app falls back to polling this site's /api/signal.
 */
export const SIGNAL_URL = (process.env.NEXT_PUBLIC_SIGNAL_URL ?? "").replace(/\/$/, "");

async function postJson(url: string, body: Record<string, unknown>) {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new PairingError("You appear to be offline.", 0);
  } finally {
    clearTimeout(timer);
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; messages?: string[] } & Record<string, unknown>;
  if (!response.ok) throw new PairingError(data.error || "Pairing failed.", response.status);
  return data;
}

const call = (body: Record<string, unknown>) => postJson("/api/signal", body);

/** Open the owner's WebSocket to the Worker. Resolves "ready", or "taken" if the code is in use. */
function openSocket(id: string, secret: string) {
  return new Promise<{ socket: WebSocket; status: "ready" | "taken"; early: string[] }>((resolve, reject) => {
    const socket = new WebSocket(SIGNAL_URL.replace(/^http/, "ws") + "/ws?id=" + id + "&secret=" + encodeURIComponent(secret));
    const early: string[] = [];
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(new PairingError("You appear to be offline.", 0));
    };
    const timer = setTimeout(fail, 8000);
    socket.onmessage = (event) => {
      let data: { type?: string; message?: string };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return; // "pong"
      }
      if (!settled && (data.type === "ready" || data.type === "taken")) {
        settled = true;
        clearTimeout(timer);
        resolve({ socket, status: data.type, early });
      } else if (data.type === "message" && typeof data.message === "string") {
        early.push(data.message);
      }
    };
    socket.onerror = fail;
    socket.onclose = fail;
  });
}

type MailboxHandlers = {
  onMessage: (message: SignalMessage) => void;
  /** The code is no longer valid (expired or taken over); get a new one. */
  onLost: () => void;
};

const POLL_MS = 1200;

export class Mailbox {
  private handlers: MailboxHandlers | null = null;
  private buffered: string[] = [];
  private decrypting: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private released = false;
  private retries = 0;

  private constructor(
    readonly code: string,
    private id: string,
    private secret: string,
    private socket: WebSocket | null,
  ) {
    if (socket) this.attach(socket);
  }

  /** Credentials proving this device owns its code (used to request relay access). */
  get auth() {
    return { id: this.id, secret: this.secret };
  }

  static async claim() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = generateCode();
      const id = await mailboxId(code);
      const secret = randomToken();
      try {
        let mailbox: Mailbox;
        if (SIGNAL_URL) {
          const { socket, status, early } = await openSocket(id, secret);
          if (status === "taken") {
            socket.close();
            continue;
          }
          mailbox = new Mailbox(code, id, secret, socket);
          mailbox.buffered.push(...early);
        } else {
          await call({ action: "claim", id, secret });
          mailbox = new Mailbox(code, id, secret, null);
        }
        void codeKey(code); // warm the key so the first message decrypts quickly
        return mailbox;
      } catch (error) {
        if (!(error instanceof PairingError) || error.status !== 409) throw error;
      }
    }
    throw new PairingError("Could not reserve a code. Try again.", 409);
  }

  /** Start delivering decrypted messages. Safe to call again after stop(). */
  start(handlers: MailboxHandlers) {
    this.handlers = handlers;
    const waiting = this.buffered.splice(0);
    waiting.forEach((sealed) => this.deliver(sealed));
    if (!this.socket && !this.released) this.schedulePoll(0);
  }

  /** Stop delivering (the code stays reserved). */
  stop() {
    this.handlers = null;
    clearTimeout(this.timer);
  }

  /** Give the code up for good. */
  release() {
    this.released = true;
    this.stop();
    clearInterval(this.keepAlive);
    if (this.socket) {
      try {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send("release");
      } catch {
        // Closing anyway.
      }
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
      return;
    }
    const body = JSON.stringify({ action: "release", id: this.id, secret: this.secret });
    if (!navigator.sendBeacon?.("/api/signal", body)) {
      void fetch("/api/signal", { method: "POST", body, keepalive: true }).catch(() => undefined);
    }
  }

  /** Encrypt a message with the recipient's code and drop it in their mailbox. */
  static async send(toCode: string, message: SignalMessage) {
    const id = await mailboxId(toCode);
    const sealed = await seal(toCode, message);
    try {
      if (SIGNAL_URL) await postJson(SIGNAL_URL + "/send", { id, message: sealed });
      else await call({ action: "send", id, message: sealed });
    } catch (error) {
      if (error instanceof PairingError && error.status === 404) {
        throw new PairingError("No device is using that code. Check it and try again.", 404);
      }
      throw error;
    }
  }

  private deliver(sealed: string) {
    if (!this.handlers) {
      this.buffered.push(sealed);
      return;
    }
    // Decrypt in order so a request is never handled after the answer that follows it.
    this.decrypting = this.decrypting.then(async () => {
      const message = await open(this.code, sealed);
      if (message) this.handlers?.onMessage(message);
    });
  }

  // --- WebSocket backend ---

  private attach(socket: WebSocket) {
    socket.onmessage = (event) => {
      let data: { type?: string; message?: string };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return; // "pong"
      }
      if (data.type === "message" && typeof data.message === "string") this.deliver(data.message);
    };
    socket.onerror = null;
    socket.onclose = () => this.reconnect();
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);
    this.retries = 0;
  }

  private reconnect() {
    clearInterval(this.keepAlive);
    if (this.released) return;
    const delay = Math.min(15_000, 1000 * 2 ** this.retries);
    this.retries += 1;
    this.timer = setTimeout(async () => {
      if (this.released) return;
      try {
        const { socket, status, early } = await openSocket(this.id, this.secret);
        if (this.released) {
          socket.close();
          return;
        }
        if (status === "taken") {
          socket.close();
          this.handlers?.onLost();
          return;
        }
        this.socket = socket;
        this.attach(socket);
        early.forEach((sealed) => this.deliver(sealed));
      } catch {
        this.reconnect();
      }
    }, delay);
  }

  // --- Polling backend (fallback) ---

  private schedulePoll(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.handlers || this.released) return;
      try {
        const { messages = [] } = await call({ action: "poll", id: this.id, secret: this.secret });
        messages.forEach((sealed) => this.deliver(sealed));
      } catch (error) {
        if (error instanceof PairingError && error.status === 410) {
          this.handlers?.onLost();
          return;
        }
      }
      if (this.handlers && !this.released) this.schedulePoll(document.hidden ? POLL_MS * 3 : POLL_MS);
    }, delay);
  }
}

/** Tell the Worker how many bytes went through the relay (for the monthly budget). */
export function reportRelayUsage(bytes: number) {
  if (!SIGNAL_URL || bytes <= 0) return;
  const body = JSON.stringify({ bytes });
  const blob = new Blob([body], { type: "text/plain" });
  if (!navigator.sendBeacon?.(SIGNAL_URL + "/usage", blob)) {
    void fetch(SIGNAL_URL + "/usage", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(
      () => undefined,
    );
  }
}
