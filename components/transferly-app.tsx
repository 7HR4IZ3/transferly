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
import { collectSignalFrame, createSignalFrames } from "../lib/signal";
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

  return new Promise<void>((resolve) => {
    let interval = 0;
    const release = () => {
      channel.removeEventListener("bufferedamountlow", release);
      window.clearInterval(interval);
      resolve();
    };

    channel.addEventListener("bufferedamountlow", release);
    interval = window.setInterval(() => {
      if (channel.bufferedAmount <= CHANNEL_LOW_WATER_MARK) release();
    }, 80);
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
      <p className="eyebrow">Private by default · local first</p>
      <div className="hero-grid">
        <div>
          <h1>
            Move files.
            <br />
            Keep the <em>cloud out.</em>
          </h1>
          <div className="capability-row" aria-label="Transferly capabilities">
            <span className="capability">No account</span>
            <span className="capability">No upload queue</span>
            <span className="capability">Works offline</span>
          </div>
        </div>
        <p className="hero-copy">
          Transferly creates a direct browser-to-browser connection. Your files move between devices, not through a
          storage bucket.
          <br />
          <br />
          <strong>For offline transfers, keep both devices on the same Wi-Fi network or hotspot.</strong>
        </p>
      </div>

      <div className="action-grid">
        <button className="action-card send" onClick={() => onStart("send")} type="button">
          <span className="action-card-top">
            <span>
              <span className="action-card-kicker">I have the files</span>
              <h2>Send something</h2>
            </span>
            <span className="action-icon">
              <ArrowUp size={21} />
            </span>
          </span>
          <span className="action-card-bottom">
            <span>Choose files, pair with another browser, and send directly.</span>
            <span className="arrow-link">
              <ArrowRight size={18} />
            </span>
          </span>
        </button>

        <button className="action-card receive" onClick={() => onStart("receive")} type="button">
          <span className="action-card-top">
            <span>
              <span className="action-card-kicker">I am receiving</span>
              <h2>Receive files</h2>
            </span>
            <span className="action-icon">
              <ArrowDown size={21} />
            </span>
          </span>
          <span className="action-card-bottom">
            <span>Scan or paste a pairing code and save the files locally.</span>
            <span className="arrow-link">
              <ArrowRight size={18} />
            </span>
          </span>
        </button>
      </div>

      <div className="why-row">
        <div className="why-card">
          <strong>One clean promise</strong>
          <p>Transferly does not create a cloud copy of the files you select.</p>
        </div>
        <div className="why-card">
          <strong>
            <Wifi size={15} /> {online ? "Online now" : "Offline now"}
          </strong>
          <p>{online ? "The app can update its offline shell." : "The cached app is still ready to open."}</p>
        </div>
        <div className="why-card">
          <strong>
            <Lock size={15} /> Direct channel
          </strong>
          <p>WebRTC encrypts the browser-to-browser data channel.</p>
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
  const [frameIndex, setFrameIndex] = useState(0);
  const [imageUrl, setImageUrl] = useState("");
  const safeFrameIndex = frames.length ? frameIndex % frames.length : 0;

  useEffect(() => {
    if (frames.length <= 1) return;
    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 900);
    return () => window.clearInterval(interval);
  }, [frames.length]);

  useEffect(() => {
    let active = true;
    const currentFrame = frames[safeFrameIndex] ?? "";

    if (!currentFrame) {
      return () => {
        active = false;
      };
    }

    QRCode.toDataURL(currentFrame, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#171715", light: "#ffffff" },
    })
      .then((url) => {
        if (active) setImageUrl(url);
      })
      .catch(() => {
        if (active) setImageUrl("");
      });

    return () => {
      active = false;
    };
  }, [frames, safeFrameIndex]);

  return (
    <figure className="qr-card">
      {imageUrl ? <img alt="Pairing code" src={imageUrl} /> : <span className="empty-state">Preparing pairing code…</span>}
      <figcaption>
        {frames.length > 1
          ? "Hold this screen up to the other device. The code cycles through multiple frames."
          : "Show this code to the other device, or use copy/paste below."}
      </figcaption>
      {frames.length > 1 ? (
        <span className="frame-count">
          Frame {frameIndex + 1} of {frames.length}
        </span>
      ) : null}
      <button className="text-button" onClick={onCopy} type="button">
        <Copy size={14} /> Copy full code
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
  const frameMapRef = useRef(new Map<string, Map<number, string>>());
  const onCompleteRef = useRef(onComplete);
  const [status, setStatus] = useState("Requesting camera access…");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 1 });

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
            setProgress({ current: collected.progress, total: collected.total });

            if (collected.signal && active) {
              active = false;
              scanner.stop();
              scanner.destroy();
              onCompleteRef.current(collected.signal);
            }
          },
          {
            preferredCamera: "environment",
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
        <p>
          {status}
          {progress.total > 1 ? " " + progress.current + "/" + progress.total + " frames captured." : ""}
        </p>
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
      channel.send(
        JSON.stringify({
          type: "transfer-start",
          totalFiles: queue.length,
          totalBytes,
        } satisfies ControlMessage),
      );

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
      channel.addEventListener("open", () => {
        setConnectionStatus("sending");
        void sendFilesOverChannel(channel, queue);
      });
      channel.addEventListener("close", () => {
        if (!transferFinishedRef.current) {
          setConnectionStatus("error");
          setError("The connection closed before the transfer finished.");
        }
      });
      channel.addEventListener("error", () => {
        setConnectionStatus("error");
        setError("The browser reported a problem with the direct connection.");
      });
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
      setConnectionStatus("receiving");
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
      channel.addEventListener("open", () => setConnectionStatus("receiving"));
      channel.addEventListener("message", (event) => void handleIncomingMessage(event));
      channel.addEventListener("close", () => {
        if (!transferFinishedRef.current) {
          setConnectionStatus("error");
          setError("The connection closed before the transfer finished.");
        }
      });
      channel.addEventListener("error", () => {
        setConnectionStatus("error");
        setError("The browser reported a problem with the direct connection.");
      });
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

  const renderSignalActions = (kind: ScanKind) => {
    const isOffer = kind === "offer";
    const rawSignal = isOffer ? senderSignal : receiverSignal;

    return (
      <div className="signal-layout">
        <QrDisplay
          frames={signalFrames}
          onCopy={() => void copyText(rawSignal)}
        />
        <div className="signal-tools">
          <div>
            <p className="section-kicker">{isOffer ? "Step 2 · receiver pairs" : "Step 3 · sender confirms"}</p>
            <h2>{isOffer ? "Show this pairing code" : "Send this answer back"}</h2>
            <p className="signal-help">
              {isOffer
                ? "The other device should scan this code, then create an answer."
                : "The sender should scan this code or paste it into the sender screen."}
            </p>
          </div>

          <div className="inline-actions">
            <button
              className="button secondary"
              onClick={() => void copyText(rawSignal)}
              type="button"
            >
              <Copy size={15} /> Copy code
            </button>
            <button
              className="button secondary"
              onClick={() => setScannerKind(isOffer ? "answer" : "offer")}
              type="button"
            >
              <Camera size={15} /> {isOffer ? "Scan answer" : "Scan offer"}
            </button>
          </div>

          <label>
            {isOffer ? "Paste the receiver answer here" : "Paste the sender offer here"}
            <textarea
              className="signal-input"
              onChange={(event) => (isOffer ? setSenderAnswerInput(event.target.value) : setReceiverOfferInput(event.target.value))}
              placeholder={isOffer ? "TL1.…" : "TL1.…"}
              value={isOffer ? senderAnswerInput : receiverOfferInput}
            />
          </label>

          <div className="inline-actions">
            <button
              className="button soft"
              onClick={() => void (isOffer ? applySenderAnswer(senderAnswerInput) : createAnswerFromOffer(receiverOfferInput))}
              type="button"
            >
              <LinkIcon size={15} /> {isOffer ? "Connect and send" : "Create answer"}
            </button>
            <button className="button danger" onClick={cancelTransfer} type="button">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSendingWorkspace = () => {
    const sendProgress = totalBytes ? Math.min(100, (bytesSent / totalBytes) * 100) : 0;

    if (signalKind === "offer" && connectionStatus === "waiting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Local pairing</p>
              <h2>Pair with the receiving browser</h2>
              <p>Both devices should be on the same Wi-Fi network or hotspot. The code only describes how to connect.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Waiting
            </span>
          </div>
          {renderSignalActions("offer")}
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
              <p className="section-kicker">Step 1 · choose files</p>
              <h2>What are you sending?</h2>
              <p>Files stay in this browser until the direct channel is open.</p>
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
                <LinkIcon size={15} /> Create pairing code
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
    if (signalKind === "offer" && connectionStatus === "waiting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Local pairing</p>
              <h2>Send the offer to this browser</h2>
              <p>Scan the sender&apos;s code or paste it below. The sender will receive an answer next.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Ready
            </span>
          </div>
          {renderSignalActions("offer")}
        </div>
      );
    }

    if (signalKind === "answer" && connectionStatus === "waiting") {
      return (
        <div className="workspace-card">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Answer ready</p>
              <h2>Return this code to the sender</h2>
              <p>Once the sender scans or pastes it, the direct channel will open here.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Waiting
            </span>
          </div>
          {renderSignalActions("answer")}
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
              <p className="section-kicker">Step 1 · pair with sender</p>
              <h2>Ready to receive</h2>
              <p>Scan the sender&apos;s cycling QR code, or paste the complete pairing code below.</p>
            </div>
            <span className="mode-pill">
              <span className="status-dot" /> Local mode
            </span>
          </div>
          <div className="inline-actions" style={{ marginBottom: 16 }}>
            <button className="button soft" onClick={() => setScannerKind("offer")} type="button">
              <Camera size={15} /> Scan sender code
            </button>
          </div>
          <label className="signal-tools">
            <span>Paste the sender offer</span>
            <textarea
              className="signal-input"
              onChange={(event) => setReceiverOfferInput(event.target.value)}
              placeholder="TL1.…"
              value={receiverOfferInput}
            />
          </label>
          <div className="inline-actions" style={{ marginTop: 12 }}>
            <button className="button" onClick={() => void createAnswerFromOffer(receiverOfferInput)} type="button">
              <LinkIcon size={15} /> Create answer
            </button>
          </div>
        </div>
        <div className="browser-note">
          <p>
            <strong>Offline-ready.</strong> The app can pair locally without an internet connection once both devices are
            on the same network.
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
            {online ? "Online · cache can update" : "Offline · cached shell"}
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
              <Shield size={14} /> Direct · no cloud copy
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
                  <h2>Scan the {scannerKind === "offer" ? "sender offer" : "receiver answer"}</h2>
                  <p>The scanner collects all QR frames automatically when the code is longer than one screen.</p>
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
        <span>Transferly · direct by design</span>
        <span>{serviceWorkerReady ? "Offline shell active" : "Offline shell loading"} · {storageLabel}</span>
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
        <p className="file-size">{formatBytes(file.size)} · {status === "sent" ? "Sent" : status === "sending" ? "Sending" : status === "error" ? "Failed" : "Ready"}</p>
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
          {file.status === "complete" ? formatBytes(file.size) + " · Ready to download" : formatBytes(file.received) + " of " + formatBytes(file.size)}
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
