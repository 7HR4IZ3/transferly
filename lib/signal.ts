const SIGNAL_PREFIX = "TL1";
const FRAME_PREFIX = "TLQ1";
const DEFAULT_FRAME_SIZE = 1150;

export type SignalDescription = {
  type: RTCSdpType;
  sdp: string;
};

export type SignalFrame = {
  sessionId: string;
  index: number;
  total: number;
  payload: string;
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
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function encodeSignal(description: SignalDescription) {
  const json = JSON.stringify(description);
  return SIGNAL_PREFIX + "." + bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeSignal(value: string): SignalDescription {
  const trimmed = value.trim();
  const encoded = trimmed.startsWith(SIGNAL_PREFIX + ".")
    ? trimmed.slice(SIGNAL_PREFIX.length + 1)
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
  const total = Math.max(1, Math.ceil(signal.length / frameSize));

  return Array.from({ length: total }, (_, offset) => {
    const index = offset + 1;
    const payload = signal.slice(offset * frameSize, index * frameSize);
    return FRAME_PREFIX + "|" + sessionId + "|" + index + "|" + total + "|" + payload;
  });
}

export function parseSignalFrame(raw: string): SignalFrame | null {
  const parts = raw.trim().split("|");

  if (parts.length < 5 || parts[0] !== FRAME_PREFIX) {
    return null;
  }

  const index = Number(parts[2]);
  const total = Number(parts[3]);

  if (!parts[1] || !Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    return null;
  }

  return {
    sessionId: parts[1],
    index,
    total,
    payload: parts.slice(4).join("|"),
  };
}

export function collectSignalFrame(frames: Map<string, Map<number, string>>, raw: string) {
  const parsed = parseSignalFrame(raw);

  if (!parsed) {
    return {
      signal: raw.trim().startsWith(SIGNAL_PREFIX + ".") ? raw.trim() : null,
      progress: 1,
      total: 1,
    };
  }

  const sessionFrames = frames.get(parsed.sessionId) ?? new Map<number, string>();
  sessionFrames.set(parsed.index, parsed.payload);
  frames.set(parsed.sessionId, sessionFrames);

  const progress = sessionFrames.size;

  if (progress < parsed.total) {
    return { signal: null, progress, total: parsed.total };
  }

  const signal = Array.from({ length: parsed.total }, (_, index) => sessionFrames.get(index + 1) ?? "").join("");
  return { signal, progress: parsed.total, total: parsed.total };
}
