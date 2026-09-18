const SIGNAL_PREFIX = "TL2";
const LEGACY_SIGNAL_PREFIX = "TL1";
const FRAME_PREFIX = "TLQ2";
const DEFAULT_FRAME_SIZE = 700;

export type SignalDescription = {
  type: RTCSdpType;
  sdp: string;
};

export type SignalFrame = {
  sessionId: string;
  index: number;
  total: number;
  checksum: string;
  payload: string;
};

export type SignalFrameBucket = {
  total: number;
  checksum: string;
  frames: Map<number, string>;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;

  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  return (randomId ? randomId.replace(/-/g, "").slice(0, 8) : Math.random().toString(36).slice(2, 10)).toUpperCase();
}

function checksumSignal(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function hasSignalPrefix(value: string) {
  return value.startsWith(SIGNAL_PREFIX + ".") || value.startsWith(LEGACY_SIGNAL_PREFIX + ".");
}

export function encodeSignal(description: SignalDescription) {
  const json = JSON.stringify(description);
  return SIGNAL_PREFIX + "." + bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeSignal(value: string): SignalDescription {
  const trimmed = value.trim();
  const encoded = trimmed.startsWith(SIGNAL_PREFIX + ".")
    ? trimmed.slice(SIGNAL_PREFIX.length + 1)
    : trimmed.startsWith(LEGACY_SIGNAL_PREFIX + ".")
      ? trimmed.slice(LEGACY_SIGNAL_PREFIX.length + 1)
    : trimmed;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as Partial<SignalDescription>;

    if ((parsed.type !== "offer" && parsed.type !== "answer") || typeof parsed.sdp !== "string") {
      throw new Error("The signal does not contain a valid WebRTC description.");
    }

    return { type: parsed.type, sdp: parsed.sdp };
  } catch {
    throw new Error("That pairing code is invalid or incomplete.");
  }
}

export function createSignalFrames(signal: string, frameSize = DEFAULT_FRAME_SIZE) {
  const sessionId = createId();
  const safeFrameSize = Math.max(300, Math.floor(frameSize));
  const total = Math.max(1, Math.ceil(signal.length / safeFrameSize));
  const checksum = checksumSignal(signal);

  return Array.from({ length: total }, (_, offset) => {
    const index = offset + 1;
    const payload = signal.slice(offset * safeFrameSize, index * safeFrameSize);
    return FRAME_PREFIX + "|" + sessionId + "|" + index + "|" + total + "|" + checksum + "|" + payload;
  });
}

export function parseSignalFrame(raw: string): SignalFrame | null {
  const parts = raw.trim().split("|");

  if (parts.length < 6 || parts[0] !== FRAME_PREFIX) {
    return null;
  }

  const index = Number(parts[2]);
  const total = Number(parts[3]);

  if (
    !parts[1] ||
    !parts[4] ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    index > total ||
    total > 256
  ) {
    return null;
  }

  return {
    sessionId: parts[1],
    index,
    total,
    checksum: parts[4],
    payload: parts.slice(5).join("|"),
  };
}

export function collectSignalFrame(frames: Map<string, SignalFrameBucket>, raw: string) {
  const parsed = parseSignalFrame(raw);

  if (!parsed) {
    const trimmed = raw.trim();
    return {
      signal: hasSignalPrefix(trimmed) ? trimmed : null,
      progress: 1,
      total: 1,
    };
  }

  const existing = frames.get(parsed.sessionId);
  if (existing && (existing.total !== parsed.total || existing.checksum !== parsed.checksum)) {
    frames.delete(parsed.sessionId);
  }

  const bucket = frames.get(parsed.sessionId) ?? {
    total: parsed.total,
    checksum: parsed.checksum,
    frames: new Map<number, string>(),
  };
  bucket.frames.set(parsed.index, parsed.payload);
  frames.set(parsed.sessionId, bucket);

  const progress = bucket.frames.size;

  if (progress < bucket.total) {
    return { signal: null, progress, total: bucket.total };
  }

  const signal = Array.from({ length: bucket.total }, (_, index) => bucket.frames.get(index + 1) ?? "").join("");
  if (checksumSignal(signal) !== bucket.checksum) {
    return {
      signal: null,
      progress,
      total: bucket.total,
      error: "One part of the pairing code was misread. Keep the sender screen steady.",
    };
  }

  return { signal, progress: bucket.total, total: bucket.total };
}
