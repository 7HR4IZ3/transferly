/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import QRCode from "qrcode";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  Copy,
  Download,
  FileIcon,
  LinkIcon,
  Lock,
  Plus,
  Shield,
  Wifi,
  XIcon,
} from "./icons";
import { collectSignalFrame, createSignalFrames, type SignalFrameBucket } from "../lib/signal";
import { createPeerConnection, descriptionToSignal, signalToDescription, waitForIceGatheringComplete } from "../lib/webrtc";

type Workspace = "send" | "receive";
type ScanKind = "offer" | "answer";
type ConnectionStatus =
  | "idle"
  | "preparing"
  | "waiting"
  | "connecting"
  | "sending"
  | "receiving"
  | "complete"
  | "error";
type FileStatus = "queued" | "sending" | "sent" | "error";
type IncomingStatus = "receiving" | "complete" | "error";

type SelectedFile = {
  id: string;
  file: File;
  progress: number;
  status: FileStatus;
};

type IncomingFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  received: number;
  progress: number;
  status: IncomingStatus;
  downloadUrl?: string;
};

type IncomingRecord = IncomingFile & {
  chunks: BlobPart[];
};

type ControlMessage =
  | {
      type: "transfer-start";
      totalFiles: number;
      totalBytes: number;
    }
  | {
      type: "file-start";
      id: string;
      name: string;
      size: number;
      mime: string;
    }
  | {
      type: "file-end";
      id: string;
    }
  | {
      type: "transfer-end";
    }
  | {
      type: "ready";
    }
  | {
      type: "transfer-ack";
    }
  | {
      type: "cancel";
      reason?: string;
    };

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const CHUNK_SIZE = 64 * 1024;
const CHANNEL_HIGH_WATER_MARK = 2 * 1024 * 1024;
const CHANNEL_LOW_WATER_MARK = 512 * 1024;

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, unitIndex);
  return value >= 10 || unitIndex === 0 ? value.toFixed(0) + " " + units[unitIndex] : value.toFixed(1) + " " + units[unitIndex];
}

function formatFileKind(name: string) {
  const extension = name.split(".").pop()?.slice(0, 4).toUpperCase();
  return extension || "FILE";
}

function makeId(prefix: string) {
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}

function connectionLabel(status: ConnectionStatus) {
  switch (status) {
    case "preparing":
      return "Preparing";
    case "waiting":
      return "Waiting for peer";
    case "connecting":
      return "Connecting";
    case "sending":
      return "Sending";
    case "receiving":
      return "Receiving";
    case "complete":
      return "Complete";
    case "error":
      return "Needs attention";
    default:
      return "Ready";
  }
}

function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
  return Promise.resolve();
}

function waitForChannelBuffer(channel: RTCDataChannel) {
  if (channel.bufferedAmount <= CHANNEL_HIGH_WATER_MARK) {
    return Promise.resolve();
  }

  channel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER_MARK;

  return new Promise<void>((resolve, reject) => {
    let interval = 0;
    const timeout = window.setTimeout(() => finish(new Error("The connection stopped accepting file data.")), 30_000);
    const finish = (error?: Error) => {
      channel.removeEventListener("bufferedamountlow", release);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const release = () => finish();
    const handleClose = () => finish(new Error("The peer disconnected while the file was sending."));
    const handleError = () => finish(new Error("The browser reported a problem sending file data."));

    channel.addEventListener("bufferedamountlow", release);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
    interval = window.setInterval(() => {
      if (channel.readyState !== "open") handleClose();
      else if (channel.bufferedAmount <= CHANNEL_LOW_WATER_MARK) release();
    }, 80);
  });
}

function waitForControlMessage(channel: RTCDataChannel, expectedType: "ready" | "transfer-ack") {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("The receiver did not respond in time.")), 60_000);
    const finish = (error?: Error) => {
      channel.removeEventListener("message", handleMessage);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data) as ControlMessage;
        if (message.type === expectedType) finish();
        else if (message.type === "cancel") finish(new Error(message.reason || "The receiver cancelled this transfer."));
      } catch {
        // Ignore unrelated control data and keep waiting for the expected response.
      }
    };
    const handleClose = () => finish(new Error("The peer disconnected before confirming the transfer."));
    const handleError = () => finish(new Error("The browser reported a problem with the direct connection."));

    channel.addEventListener("message", handleMessage);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function HomeView({
  online,
  onStart,
  canInstall,
  onInstall,
}: {
  online: boolean;
  onStart: (workspace: Workspace) => void;
  canInstall: boolean;
  onInstall: () => void;
}) {
  return (
    <section className="hero">
      <p className="eyebrow">Private file transfer</p>
      <div className="hero-grid">
        <div>
          <h1>
            Move files.
            <br />
            Keep the <em>cloud out.</em>
          </h1>
        </div>
        <p className="hero-copy">
          A direct browser-to-browser transfer. Your files move between devices, not through a storage bucket.
          <span className="hero-note">
            <Wifi size={16} />
            <strong>Works offline on the same Wi-Fi or hotspot.</strong>
          </span>
        </p>
      </div>

      <div className="action-grid">
        <button className="action-card send" onClick={() => onStart("send")} type="button">
          <span className="action-card-top">
            <span>
              <span className="action-card-kicker">Start here</span>
              <h2>Send files</h2>
            </span>
            <span className="action-icon">
              <ArrowUp size={21} />
            </span>
          </span>
          <span className="action-card-bottom">
            <span>Choose files and show a QR code.</span>
            <span className="arrow-link">
              <ArrowRight size={18} />
            </span>
          </span>
        </button>

        <button className="action-card receive" onClick={() => onStart("receive")} type="button">
          <span className="action-card-top">
            <span>
              <span className="action-card-kicker">Join a transfer</span>
              <h2>Receive files</h2>
            </span>
            <span className="action-icon">
              <ArrowDown size={21} />
            </span>
          </span>
          <span className="action-card-bottom">
            <span>Scan the sender&apos;s QR code with your camera.</span>
            <span className="arrow-link">
              <ArrowRight size={18} />
            </span>
          </span>
        </button>
      </div>

      <div className="why-row">
        <div className="why-card">
          <strong>No account</strong>
          <p>Open the app and start. There is nothing to sign up for.</p>
        </div>
        <div className="why-card">
          <strong>
            <Wifi size={15} /> {online ? "Ready to cache" : "Offline-ready"}
          </strong>
          <p>{online ? "The app can refresh its local shell." : "The cached app can still open."}</p>
        </div>
        <div className="why-card">
          <strong>
            <Lock size={15} /> Direct channel
          </strong>
          <p>No cloud copy is created while files are moving.</p>
        </div>
      </div>

      {canInstall ? (
        <div className="browser-note">
          <p>
            <strong>Make it easier to use offline.</strong> Install Transferly on this device.
          </p>
          <button className="button secondary" onClick={onInstall} type="button">
            Install app
          </button>
        </div>
      ) : null}
    </section>
  );
}

function QrDisplay({
  frames,
  onCopy,
}: {
  frames: string[];
  onCopy: () => void;
}) {
  const [frameState, setFrameState] = useState({ source: frames, index: 0 });
  const [imageUrl, setImageUrl] = useState("");
  const [imageFrame, setImageFrame] = useState("");
  const safeFrameIndex = frameState.source === frames && frames.length ? frameState.index % frames.length : 0;

  useEffect(() => {
    if (frames.length <= 1) return;
    const interval = window.setInterval(() => {
      setFrameState((current) => {
        const currentIndex = current.source === frames ? current.index : 0;
        return { source: frames, index: (currentIndex + 1) % frames.length };
      });
    }, 1_400);
    return () => window.clearInterval(interval);
  }, [frames]);

  useEffect(() => {
    let active = true;
    const currentFrame = frames[safeFrameIndex] ?? "";

    if (!currentFrame) {
      return () => {
        active = false;
      };
    }

    QRCode.toDataURL(currentFrame, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: "L",
      color: { dark: "#171715", light: "#ffffff" },
    })
      .then((url) => {
        if (active) {
          setImageUrl(url);
          setImageFrame(currentFrame);
        }
      })
      .catch(() => {
        if (active) setImageFrame("");
      });

    return () => {
      active = false;
    };
  }, [frames, safeFrameIndex]);

  return (
    <figure className="qr-card">
      {imageUrl && imageFrame === (frames[safeFrameIndex] ?? "") ? (
        <img alt="Pairing code" src={imageUrl} />
      ) : (
        <span className="empty-state">Preparing pairing code…</span>
      )}
      <figcaption>
        {frames.length > 1
          ? "Hold this screen steady. The code changes automatically."
          : "Hold this screen up to the other device."}
      </figcaption>
      <button className="text-button" onClick={onCopy} type="button">
        <Copy size={14} /> Copy code instead
      </button>
    </figure>
  );
}

function QrScannerPanel({
  onComplete,
  onCancel,
}: {
  onComplete: (signal: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<{ stop: () => void; destroy: () => void } | null>(null);
  const frameMapRef = useRef(new Map<string, SignalFrameBucket>());
  const onCompleteRef = useRef(onComplete);
  const [status, setStatus] = useState("Requesting camera access…");
  const [error, setError] = useState("");

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let active = true;

    const setupScanner = async () => {
      try {
        const qrModule = await import("qr-scanner");
        const QrScanner = qrModule.default;
        QrScanner.WORKER_PATH = "/qr-scanner-worker.min.js";

        if (!videoRef.current) return;

        const scanner = new QrScanner(
          videoRef.current,
          (result) => {
            const raw = typeof result === "string" ? result : (result as { data: string }).data;
            const collected = collectSignalFrame(frameMapRef.current, raw);

            if (collected.signal && active) {
              active = false;
              scanner.stop();
              scanner.destroy();
              onCompleteRef.current(collected.signal);
            } else if (active && collected.total > 1) {
              setStatus("Reading the pairing code…");
              if (collected.error) setError(collected.error);
            }
          },
          {
            preferredCamera: "environment",
            maxScansPerSecond: 5,
            highlightScanRegion: false,
            returnDetailedScanResult: true,
          },
        );

        scannerRef.current = scanner;
        await scanner.start();
        if (active) setStatus("Point the camera at the pairing code.");
      } catch {
        if (active) {
          setStatus("Camera scanning is unavailable.");
          setError("Allow camera access or use the copy/paste option below.");
        }
      }
    };

    void setupScanner();

    return () => {
      active = false;
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  return (
    <div className="scanner">
      <video autoPlay muted playsInline ref={videoRef} />
      <div className="scanner-overlay">
        <span className="scanner-frame" />
      </div>
      <div className="scanner-controls">
        <p>{status}</p>
        <button className="button secondary" onClick={onCancel} type="button">
          Close
        </button>
      </div>
      {error ? <p className="scanner-error">{error}</p> : null}
    </div>
  );
}

export default function TransferlyApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [online, setOnline] = useState(true);
  const [serviceWorkerReady, setServiceWorkerReady] = useState(false);
  const [storageLabel, setStorageLabel] = useState("Checking local storage");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState("");
  const [signalKind, setSignalKind] = useState<ScanKind | null>(null);
  const [signalFrames, setSignalFrames] = useState<string[]>([]);
  const [senderSignal, setSenderSignal] = useState("");
  const [senderAnswerInput, setSenderAnswerInput] = useState("");
  const [receiverSignal, setReceiverSignal] = useState("");
  const [receiverOfferInput, setReceiverOfferInput] = useState("");
  const [scannerKind, setScannerKind] = useState<ScanKind | null>(null);
  const [bytesSent, setBytesSent] = useState(0);
  const [incomingFiles, setIncomingFiles] = useState<IncomingFile[]>([]);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const incomingRecordsRef = useRef(new Map<string, IncomingRecord>());
  const expectedIncomingFilesRef = useRef<number | null>(null);
  const transferFinishedRef = useRef(false);

  const totalBytes = useMemo(() => files.reduce((total, item) => total + item.file.size, 0), [files]);
  const totalReceivedBytes = useMemo(() => incomingFiles.reduce((total, item) => total + item.size, 0), [incomingFiles]);
  const totalIncomingProgress = useMemo(
    () => incomingFiles.reduce((total, item) => total + item.received, 0),
    [incomingFiles],
  );

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setServiceWorkerReady(true))
        .catch(() => setServiceWorkerReady(false));
    }

    if (navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then((estimate) => {
          const usage = estimate.usage ?? 0;
          const quota = estimate.quota ?? 0;
          setStorageLabel(quota ? formatBytes(usage) + " used of " + formatBytes(quota) : "Browser-managed");
        })
        .catch(() => setStorageLabel("Browser-managed"));
    }
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
    };
  }, []);

  const cleanupPeer = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
  }, []);

  useEffect(() => {
    return () => cleanupPeer();
  }, [cleanupPeer]);

  const clearIncomingFiles = useCallback(() => {
    setIncomingFiles((current) => {
      current.forEach((file) => {
        if (file.downloadUrl) URL.revokeObjectURL(file.downloadUrl);
      });
      return [];
    });
    incomingRecordsRef.current.clear();
  }, []);

  const resetWorkspace = useCallback(() => {
    cleanupPeer();
    clearIncomingFiles();
    setWorkspace(null);
    setFiles([]);
    setDragging(false);
    setConnectionStatus("idle");
    setError("");
    setSignalKind(null);
    setSignalFrames([]);
    setSenderSignal("");
    setSenderAnswerInput("");
    setReceiverSignal("");
    setReceiverOfferInput("");
    setScannerKind(null);
    setBytesSent(0);
    expectedIncomingFilesRef.current = null;
    transferFinishedRef.current = false;
  }, [cleanupPeer, clearIncomingFiles]);

  const startWorkspace = useCallback(
    (nextWorkspace: Workspace) => {
      resetWorkspace();
      setWorkspace(nextWorkspace);
    },
    [resetWorkspace],
  );

  const addFiles = useCallback((list: FileList | File[]) => {
    const nextFiles = Array.from(list).map((file) => ({
      id: makeId("file"),
      file,
      progress: 0,
      status: "queued" as FileStatus,
    }));

    setFiles((current) => {
      const existing = new Set(current.map((item) => item.file.name + ":" + item.file.size + ":" + item.file.lastModified));
      return [
        ...current,
        ...nextFiles.filter((item) => !existing.has(item.file.name + ":" + item.file.size + ":" + item.file.lastModified)),
      ];
    });
  }, []);

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) addFiles(event.target.files);
      event.target.value = "";
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const sendFilesOverChannel = useCallback(async (channel: RTCDataChannel, queue: SelectedFile[]) => {
    transferFinishedRef.current = false;
    try {
      const receiverReady = waitForControlMessage(channel, "ready");
      channel.send(
        JSON.stringify({
          type: "transfer-start",
          totalFiles: queue.length,
          totalBytes,
        } satisfies ControlMessage),
      );
      await receiverReady;

      let completedBytes = 0;
      let lastUpdate = 0;

      for (const item of queue) {
        setFiles((current) => current.map((entry) => (entry.id === item.id ? { ...entry, status: "sending" } : entry)));
        channel.send(
          JSON.stringify({
            type: "file-start",
            id: item.id,
            name: item.file.name,
            size: item.file.size,
            mime: item.file.type || "application/octet-stream",
          } satisfies ControlMessage),
        );

        let offset = 0;
        while (offset < item.file.size) {
          if (channel.readyState !== "open") throw new Error("The peer disconnected before the file finished.");
          await waitForChannelBuffer(channel);
          const chunk = await item.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
          channel.send(chunk);
          offset += chunk.byteLength;
          const now = Date.now();
          if (now - lastUpdate > 90 || offset === item.file.size) {
            lastUpdate = now;
            setBytesSent(completedBytes + offset);
            setFiles((current) =>
              current.map((entry) =>
                entry.id === item.id ? { ...entry, progress: item.file.size ? (offset / item.file.size) * 100 : 100 } : entry,
              ),
            );
          }
        }

        completedBytes += item.file.size;
        channel.send(JSON.stringify({ type: "file-end", id: item.id } satisfies ControlMessage));
        setBytesSent(completedBytes);
        setFiles((current) =>
          current.map((entry) => (entry.id === item.id ? { ...entry, progress: 100, status: "sent" } : entry)),
        );
      }

      channel.send(JSON.stringify({ type: "transfer-end" } satisfies ControlMessage));
      await waitForControlMessage(channel, "transfer-ack");
      transferFinishedRef.current = true;
      setConnectionStatus("complete");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The file transfer could not finish.");
      setConnectionStatus("error");
      setFiles((current) => current.map((entry) => (entry.status === "sending" ? { ...entry, status: "error" } : entry)));
    }
  }, [totalBytes]);

  const attachSenderChannel = useCallback(
    (channel: RTCDataChannel, queue: SelectedFile[]) => {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER_MARK;
      let started = false;
      const openTimeout = window.setTimeout(() => {
        if (!started && channel.readyState !== "open") {
          setConnectionStatus("error");
          setError("The receiver did not connect. Scan the sender code again and try once more.");
        }
      }, 120_000);
      const handleOpen = () => {
        if (started) return;
        started = true;
        window.clearTimeout(openTimeout);
        setConnectionStatus("sending");
        void sendFilesOverChannel(channel, queue);
      };
      const handleClose = () => {
        window.clearTimeout(openTimeout);
        if (!transferFinishedRef.current) {
          setConnectionStatus("error");
          setError("The connection closed before the transfer finished.");
        }
      };
      const handleError = () => {
        window.clearTimeout(openTimeout);
        setConnectionStatus("error");
        setError("The browser reported a problem with the direct connection.");
      };
      channel.addEventListener("open", handleOpen);
      channel.addEventListener("close", handleClose);
      channel.addEventListener("error", handleError);
      if (channel.readyState === "open") handleOpen();
    },
    [sendFilesOverChannel],
  );

  const createOffer = useCallback(async () => {
    if (!files.length) {
      setError("Choose at least one file first.");
      return;
    }

    cleanupPeer();
    setError("");
    setConnectionStatus("preparing");
    setSignalKind(null);
    setBytesSent(0);

    try {
      const peer = createPeerConnection();
      peerRef.current = peer;
      peer.addEventListener("connectionstatechange", () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === "failed") {
          setConnectionStatus("error");
          setError("The devices could not establish a direct connection. Keep both devices on the same Wi-Fi or hotspot and try again.");
        } else if (peer.connectionState === "closed" && !transferFinishedRef.current) {
          setConnectionStatus("error");
          setError("The direct connection closed before the transfer finished.");
        }
      });
      const channel = peer.createDataChannel("transferly-files", { ordered: true });
      channelRef.current = channel;
      attachSenderChannel(channel, files);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);

      const signal = descriptionToSignal(peer.localDescription ?? offer);
      setSenderSignal(signal);
      setSignalFrames(createSignalFrames(signal));
      setSignalKind("offer");
      setConnectionStatus("waiting");
    } catch (offerError) {
      setError(offerError instanceof Error ? offerError.message : "The browser could not prepare a pairing code.");
      setConnectionStatus("error");
    }
  }, [attachSenderChannel, cleanupPeer, files]);

  const applySenderAnswer = useCallback(
    async (rawSignal: string) => {
      if (!rawSignal.trim()) {
        setError("Paste the receiver answer or scan it with the camera.");
        return;
      }

      const peer = peerRef.current;
      if (!peer) {
        setError("Create a sender pairing code first.");
        return;
      }

      try {
        setError("");
        await peer.setRemoteDescription(signalToDescription(rawSignal));
        setSignalKind(null);
        setSignalFrames([]);
        setConnectionStatus("connecting");
      } catch (answerError) {
        setError(answerError instanceof Error ? answerError.message : "That receiver answer could not be used.");
        setConnectionStatus("error");
      }
    },
    [],
  );

  const handleIncomingMessage = useCallback(async (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      const activeFile = Array.from(incomingRecordsRef.current.values()).find((file) => file.status === "receiving");
      if (!activeFile) return;

      const chunk = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      const byteLength = chunk instanceof ArrayBuffer ? chunk.byteLength : 0;
      activeFile.chunks.push(chunk as BlobPart);
      activeFile.received += byteLength;
      setIncomingFiles((current) =>
        current.map((file) =>
          file.id === activeFile.id
            ? { ...file, received: activeFile.received, progress: activeFile.size ? (activeFile.received / activeFile.size) * 100 : 0 }
            : file,
        ),
      );
      return;
    }

    let message: ControlMessage;
    try {
      message = JSON.parse(event.data) as ControlMessage;
    } catch {
      return;
    }

    if (message.type === "transfer-start") {
      expectedIncomingFilesRef.current = message.totalFiles;
      setConnectionStatus("receiving");
      if (channelRef.current?.readyState === "open") {
        channelRef.current.send(JSON.stringify({ type: "ready" } satisfies ControlMessage));
      }
      return;
    }

    if (message.type === "file-start") {
      const record: IncomingRecord = {
        id: message.id,
        name: message.name,
        size: message.size,
        mime: message.mime,
        received: 0,
        progress: 0,
        status: "receiving",
        chunks: [],
      };
      incomingRecordsRef.current.set(record.id, record);
      setIncomingFiles((current) => [
        ...current.filter((file) => file.id !== record.id),
        {
          id: record.id,
          name: record.name,
          size: record.size,
          mime: record.mime,
          received: 0,
          progress: 0,
          status: "receiving",
        },
      ]);
      return;
    }

    if (message.type === "file-end") {
      const record = incomingRecordsRef.current.get(message.id);
      if (!record) return;
      if (record.received !== record.size) {
        record.status = "error";
        setConnectionStatus("error");
        setError(`The file ${record.name} arrived incomplete. Ask the sender to try again.`);
        if (channelRef.current?.readyState === "open") {
          channelRef.current.send(JSON.stringify({ type: "cancel", reason: "A file arrived incomplete." } satisfies ControlMessage));
        }
        return;
      }
      const blob = new Blob(record.chunks, { type: record.mime });
      const downloadUrl = URL.createObjectURL(blob);
      record.status = "complete";
      record.progress = 100;
      record.downloadUrl = downloadUrl;
      setIncomingFiles((current) =>
        current.map((file) =>
          file.id === message.id ? { ...file, received: record.size, progress: 100, status: "complete", downloadUrl } : file,
        ),
      );
      return;
    }

    if (message.type === "transfer-end") {
      const records = Array.from(incomingRecordsRef.current.values());
      const expectedFiles = expectedIncomingFilesRef.current;
      if (
        (expectedFiles !== null && records.length !== expectedFiles) ||
        records.some((record) => record.status !== "complete")
      ) {
        setConnectionStatus("error");
        setError("The transfer ended before every file was received.");
        return;
      }

      if (channelRef.current?.readyState === "open") {
        channelRef.current.send(JSON.stringify({ type: "transfer-ack" } satisfies ControlMessage));
      }
      transferFinishedRef.current = true;
      setConnectionStatus("complete");
      return;
    }

    if (message.type === "cancel") {
      setError(message.reason || "The sender cancelled this transfer.");
      setConnectionStatus("error");
    }
  }, []);

  const attachReceiverChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = "arraybuffer";
      let messageQueue = Promise.resolve();
      const handleOpen = () => setConnectionStatus("receiving");
      const handleMessage = (event: MessageEvent) => {
        // Keep control messages behind the preceding binary chunks. This is
        // important because Blob -> ArrayBuffer conversion is asynchronous.
        messageQueue = messageQueue
          .then(() => handleIncomingMessage(event))
          .catch((messageError: unknown) => {
            setConnectionStatus("error");
            setError(messageError instanceof Error ? messageError.message : "The receiver could not process the file data.");
          });
      };
      const handleClose = () => {
        if (!transferFinishedRef.current) {
          setConnectionStatus("error");
          setError("The connection closed before the transfer finished.");
        }
      };
      const handleError = () => {
        setConnectionStatus("error");
        setError("The browser reported a problem with the direct connection.");
      };
      channel.addEventListener("open", handleOpen);
      channel.addEventListener("message", handleMessage);
      channel.addEventListener("close", handleClose);
      channel.addEventListener("error", handleError);
      if (channel.readyState === "open") handleOpen();
    },
    [handleIncomingMessage],
  );

  const createAnswerFromOffer = useCallback(
    async (rawSignal: string) => {
      if (!rawSignal.trim()) {
        setError("Paste the sender offer or scan it with the camera.");
        return;
      }

      cleanupPeer();
      setError("");
      setConnectionStatus("preparing");
      setSignalKind(null);
      transferFinishedRef.current = false;

      try {
        const peer = createPeerConnection();
        peerRef.current = peer;
        peer.addEventListener("connectionstatechange", () => {
          if (peerRef.current !== peer) return;
          if (peer.connectionState === "failed") {
            setConnectionStatus("error");
            setError("The devices could not establish a direct connection. Keep both devices on the same Wi-Fi or hotspot and try again.");
          } else if (peer.connectionState === "closed" && !transferFinishedRef.current) {
            setConnectionStatus("error");
            setError("The direct connection closed before the transfer finished.");
          }
        });
        peer.addEventListener("datachannel", (event) => {
          channelRef.current = event.channel;
          attachReceiverChannel(event.channel);
        });

        await peer.setRemoteDescription(signalToDescription(rawSignal));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await waitForIceGatheringComplete(peer);

        const signal = descriptionToSignal(peer.localDescription ?? answer);
        setReceiverSignal(signal);
        setSignalFrames(createSignalFrames(signal));
        setSignalKind("answer");
        setConnectionStatus("waiting");
      } catch (offerError) {
        setError(offerError instanceof Error ? offerError.message : "That sender offer could not be used.");
        setConnectionStatus("error");
      }
    },
    [attachReceiverChannel, cleanupPeer],
  );

  const handleScanComplete = useCallback(
    (signal: string) => {
      const currentKind = scannerKind;
      setScannerKind(null);

      if (currentKind === "offer") {
        setReceiverOfferInput(signal);
        void createAnswerFromOffer(signal);
      } else if (currentKind === "answer") {
        setSenderAnswerInput(signal);
        void applySenderAnswer(signal);
      }
    },
    [applySenderAnswer, createAnswerFromOffer, scannerKind],
  );

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }, [installPrompt]);

  const cancelTransfer = useCallback(() => {
    if (channelRef.current?.readyState === "open") {
      channelRef.current.send(JSON.stringify({ type: "cancel", reason: "Transfer cancelled by the user." } satisfies ControlMessage));
    }
    transferFinishedRef.current = true;
    cleanupPeer();
    setConnectionStatus("idle");
    setSignalKind(null);
    setSignalFrames([]);
  }, [cleanupPeer]);

  const renderSenderOfferActions = () => (
    <div className="signal-layout">
      <QrDisplay frames={signalFrames} onCopy={() => void copyText(senderSignal)} />
      <div className="signal-tools">
        <div className="signal-intro">
          <span className="signal-step">1</span>
          <div>
            <p className="section-kicker">Receiver scans</p>
            <h2>Show this to the receiver</h2>
            <p className="signal-help">Keep this screen open. The receiver will show a reply code next.</p>
          </div>
        </div>

        <button className="button soft wide-button" onClick={() => setScannerKind("answer")} type="button">
          <Camera size={17} /> Scan receiver reply
        </button>

        <details className="fallback-panel">
          <summary>Use a text code instead</summary>
          <div className="fallback-content">
            <p>Copy the receiver&apos;s reply code and paste it here if scanning is not available.</p>
            <label className="signal-label">
              <span>Receiver reply code</span>
              <textarea
                className="signal-input"
                onChange={(event) => setSenderAnswerInput(event.target.value)}
                placeholder="Paste the reply code"
                value={senderAnswerInput}
              />
            </label>
            <button className="button secondary" onClick={() => void applySenderAnswer(senderAnswerInput)} type="button">
              <LinkIcon size={16} /> Connect and send
            </button>
          </div>
        </details>

        <button className="text-button cancel-button" onClick={cancelTransfer} type="button">
          Cancel pairing
        </button>
      </div>
    </div>
  );

  const renderReceiverAnswerActions = () => (
    <div className="signal-layout">
      <QrDisplay frames={signalFrames} onCopy={() => void copyText(receiverSignal)} />
      <div className="signal-tools">
        <div className="signal-intro">
          <span className="signal-step">2</span>
          <div>
            <p className="section-kicker">Sender scans</p>
            <h2>Show this reply to the sender</h2>
            <p className="signal-help">The sender scans this screen. The direct connection will start automatically.</p>
          </div>
        </div>

        <div className="answer-note">
          <Check size={18} />
          <span>Offer received. Your answer is ready.</span>
        </div>

        <details className="fallback-panel">
          <summary>Send the code another way</summary>
          <div className="fallback-content">
            <p>Copy this reply code and send it to the sender.</p>
            <button className="button secondary" onClick={() => void copyText(receiverSignal)} type="button">
              <Copy size={16} /> Copy reply code
            </button>
          </div>
        </details>

        <button className="text-button cancel-button" onClick={cancelTransfer} type="button">
          Cancel pairing
        </button>
      </div>
    </div>
  );

  const renderSendingWorkspace = () => {
    const sendProgress = totalBytes ? Math.min(100, (bytesSent / totalBytes) * 100) : 0;

    if (signalKind === "offer" && connectionStatus === "waiting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Local pairing</p>
              <h2>Connect to the receiver</h2>
              <p>Both devices should be on the same Wi-Fi network or hotspot. The receiver scans first.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Waiting for scan
            </span>
          </div>
          {renderSenderOfferActions()}
        </div>
      );
    }

    if (connectionStatus === "sending" || connectionStatus === "connecting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Direct channel</p>
              <h2>{connectionStatus === "connecting" ? "Opening the connection…" : "Files are moving"}</h2>
              <p>Keep this tab open until the progress reaches 100%.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> {connectionLabel(connectionStatus)}
            </span>
          </div>
          <div className="transfer-summary">
            <div className="stat">
              <span>Sent</span>
              <strong>{formatBytes(bytesSent)}</strong>
            </div>
            <div className="stat">
              <span>Remaining</span>
              <strong>{formatBytes(Math.max(0, totalBytes - bytesSent))}</strong>
            </div>
            <div className="stat">
              <span>Progress</span>
              <strong>{sendProgress.toFixed(0)}%</strong>
            </div>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: sendProgress + "%" }} />
          </div>
          <div className="file-list">
            {files.map((item) => (
              <FileRow key={item.id} file={item.file} progress={item.progress} status={item.status} />
            ))}
          </div>
        </div>
      );
    }

    if (connectionStatus === "complete") {
      return (
        <div className="workspace-card">
          <div className="complete-card">
            <p className="section-kicker">Transfer finished</p>
            <h2>Everything made it across.</h2>
            <p>{files.length} {files.length === 1 ? "file was" : "files were"} sent directly to the receiving browser.</p>
            <button className="button" onClick={() => startWorkspace("send")} type="button">
              Send something else <ArrowRight size={15} />
            </button>
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Choose files</p>
              <h2>What are you sending?</h2>
              <p>Files stay in this browser until you connect to the receiver.</p>
            </div>
            {files.length ? <span className="mode-pill">{files.length} selected</span> : null}
          </div>
          <input className="sr-only" id="file-picker" multiple onChange={handleFileInput} type="file" />
          <div
            className={"dropzone" + (dragging ? " dragging" : "")}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div className="dropzone-content">
              <span className="dropzone-icon">
                <Plus size={22} />
              </span>
              <h3>Drop files here</h3>
              <p>or pick files from this device. Multiple files are supported.</p>
              <label className="button" htmlFor="file-picker">
                <FileIcon size={15} /> Choose files
              </label>
            </div>
          </div>
          {files.length ? (
            <div className="file-list">
              {files.map((item) => (
                <FileRow
                  key={item.id}
                  file={item.file}
                  onRemove={() => setFiles((current) => current.filter((entry) => entry.id !== item.id))}
                  progress={item.progress}
                  status={item.status}
                />
              ))}
            </div>
          ) : null}
          {files.length ? (
            <div className="inline-actions" style={{ marginTop: 16 }}>
              <button className="button soft" disabled={connectionStatus === "preparing"} onClick={() => void createOffer()} type="button">
                <Camera size={16} /> Show QR code
              </button>
              <span className="mini-label">{formatBytes(totalBytes)} total</span>
            </div>
          ) : null}
        </div>
        <div className="browser-note">
          <p>
            <strong>Local mode.</strong> No account, upload API, or cloud storage is involved.
          </p>
          <span className="mini-label">
            {serviceWorkerReady ? "Offline shell ready" : "Preparing offline shell"}
          </span>
        </div>
      </>
    );
  };

  const renderReceivingWorkspace = () => {
    if (signalKind === "answer" && connectionStatus === "waiting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Reply ready</p>
              <h2>Let the sender scan</h2>
              <p>Keep this screen open while the sender scans your reply.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Waiting for scan
            </span>
          </div>
          {renderReceiverAnswerActions()}
        </div>
      );
    }

    if (connectionStatus === "receiving" || connectionStatus === "connecting") {
      const progress = totalReceivedBytes ? (totalIncomingProgress / totalReceivedBytes) * 100 : 0;
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Direct channel</p>
              <h2>Files are arriving</h2>
              <p>Keep this tab open. Downloads become available as each file completes.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> {connectionLabel(connectionStatus)}
            </span>
          </div>
          <div className="transfer-summary">
            <div className="stat">
              <span>Received</span>
              <strong>{formatBytes(totalIncomingProgress)}</strong>
            </div>
            <div className="stat">
              <span>Files</span>
              <strong>{incomingFiles.length}</strong>
            </div>
            <div className="stat">
              <span>Progress</span>
              <strong>{progress.toFixed(0)}%</strong>
            </div>
          </div>
          <div className="incoming-list">
            {incomingFiles.map((file) => (
              <IncomingRow key={file.id} file={file} />
            ))}
          </div>
        </div>
      );
    }

    if (connectionStatus === "complete") {
      return (
        <div className="workspace-card">
          <div className="complete-card">
            <p className="section-kicker">Transfer finished</p>
            <h2>Your files are ready.</h2>
            <p>
              {incomingFiles.length} {incomingFiles.length === 1 ? "file is" : "files are"} available locally. Download them
              before closing this tab.
            </p>
            <button className="button" onClick={() => startWorkspace("receive")} type="button">
              Receive more <ArrowRight size={15} />
            </button>
          </div>
          <div className="incoming-list" style={{ marginTop: 12 }}>
            {incomingFiles.map((file) => (
              <IncomingRow key={file.id} file={file} />
            ))}
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Scan to connect</p>
              <h2>Ready to receive</h2>
              <p>Point your camera at the sender&apos;s QR code. Transferly builds the reply for you.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Waiting for sender
            </span>
          </div>
          <button className="button soft wide-button" onClick={() => setScannerKind("offer")} type="button">
            <Camera size={17} /> Scan sender QR
          </button>
          <p className="action-hint">Allow camera access when your browser asks.</p>

          <details className="fallback-panel">
            <summary>Camera not available?</summary>
            <div className="fallback-content">
              <p>Ask the sender to copy their pairing code and send it to you.</p>
              <label className="signal-label">
                <span>Sender pairing code</span>
                <textarea
                  className="signal-input"
                  onChange={(event) => setReceiverOfferInput(event.target.value)}
                  placeholder="Paste the pairing code"
                  value={receiverOfferInput}
                />
              </label>
              <button className="button secondary" onClick={() => void createAnswerFromOffer(receiverOfferInput)} type="button">
                <LinkIcon size={16} /> Use code
              </button>
            </div>
          </details>
        </div>
        <div className="browser-note">
          <p>
            <strong>Local mode.</strong> Both devices need the same Wi-Fi network or hotspot.
          </p>
          <span className="mini-label">{storageLabel}</span>
        </div>
      </>
    );
  };

  return (
    <main className="app-shell">
      <header className="site-header">
        <button className="brand" onClick={resetWorkspace} type="button">
          <span className="brand-mark">+</span>
          <span>transferly</span>
        </button>
        <div className="top-actions">
          {installPrompt ? (
            <button className="text-button" onClick={() => void handleInstall()} type="button">
              Install
            </button>
          ) : null}
          <span className="status-pill">
            <span className={"status-dot" + (online ? "" : " offline")} />
            {online ? "Online, cache can update" : "Offline, cached shell"}
          </span>
        </div>
      </header>

      {workspace === null ? (
        <HomeView canInstall={Boolean(installPrompt)} onInstall={() => void handleInstall()} onStart={startWorkspace} online={online} />
      ) : (
        <section className="workspace">
          <div className="workspace-header">
            <div>
              <button className="back-button" onClick={resetWorkspace} type="button">
                <ArrowLeft size={15} /> Back to Transferly
              </button>
              <h1 className="workspace-title">{workspace === "send" ? "Send files." : "Receive files."}</h1>
              <p className="workspace-subtitle">
                {workspace === "send"
                  ? "Choose files, pair with another browser, and watch them move directly."
                  : "Pair with a sender, then save the files this browser receives."}
              </p>
              <div className="step-indicator">
                <span className={"step" + (connectionStatus === "idle" ? " active" : "")}>
                  <span className="step-number">1</span> {workspace === "send" ? "Choose" : "Pair"}
                </span>
                <span className="step-separator" />
                <span className={"step" + (signalKind ? " active" : "")}>
                  <span className="step-number">2</span> Connect
                </span>
                <span className="step-separator" />
                <span className={"step" + (connectionStatus === "sending" || connectionStatus === "receiving" || connectionStatus === "complete" ? " active" : "")}>
                  <span className="step-number">3</span> Transfer
                </span>
              </div>
            </div>
            <span className="mode-pill">
              <Shield size={14} /> Direct, no cloud copy
            </span>
          </div>

          {error ? (
            <div className="alert">
              <XIcon size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <div style={{ marginTop: error ? 12 : 0 }}>{workspace === "send" ? renderSendingWorkspace() : renderReceivingWorkspace()}</div>

          {scannerKind ? (
            <div className="workspace-card">
              <div className="section-heading">
              <div>
                  <p className="section-kicker">Camera pairing</p>
                  <h2>Scan the {scannerKind === "offer" ? "sender QR" : "receiver reply"}</h2>
                  <p>Hold the other screen steady. Transferly reads the full code automatically.</p>
                </div>
                <span className="mode-pill">
                  <Camera size={14} /> Camera on
                </span>
              </div>
              <QrScannerPanel onCancel={() => setScannerKind(null)} onComplete={handleScanComplete} />
            </div>
          ) : null}
        </section>
      )}

      <footer className="footer-bar">
        <span>Transferly, direct by design</span>
        <span>{serviceWorkerReady ? "Offline shell active" : "Offline shell loading"} | {storageLabel}</span>
      </footer>
    </main>
  );
}

function FileRow({
  file,
  progress,
  status,
  onRemove,
}: {
  file: File;
  progress: number;
  status: FileStatus;
  onRemove?: () => void;
}) {
  return (
    <div className="file-row">
      <span className="file-type">{formatFileKind(file.name)}</span>
      <div className="file-meta">
        <p className="file-name" title={file.name}>{file.name}</p>
        <p className="file-size">{formatBytes(file.size)} | {status === "sent" ? "Sent" : status === "sending" ? "Sending" : status === "error" ? "Failed" : "Ready"}</p>
        {status === "sending" ? (
          <div className="file-progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: progress + "%" }} />
            </div>
          </div>
        ) : null}
      </div>
      {status === "sent" ? <Check size={18} /> : onRemove ? <button aria-label={"Remove " + file.name} className="file-remove" onClick={onRemove} type="button"><XIcon size={16} /></button> : null}
    </div>
  );
}

function IncomingRow({ file }: { file: IncomingFile }) {
  return (
    <div className="incoming-row">
      <span className="file-type">{formatFileKind(file.name)}</span>
      <div className="file-meta">
        <p className="file-name" title={file.name}>{file.name}</p>
        <p className="file-size">
          {file.status === "complete" ? formatBytes(file.size) + " | Ready to download" : formatBytes(file.received) + " of " + formatBytes(file.size)}
        </p>
        {file.status === "receiving" ? (
          <div className="file-progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: file.progress + "%" }} />
            </div>
          </div>
        ) : null}
      </div>
      {file.downloadUrl ? (
        <a className="download-button" download={file.name} href={file.downloadUrl}>
          <Download size={14} /> Save
        </a>
      ) : file.status === "complete" ? (
        <Check size={18} />
      ) : null}
    </div>
  );
}
