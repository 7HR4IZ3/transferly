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

async function call(body: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetch("/api/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new PairingError("You appear to be offline.", 0);
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; messages?: string[] };
  if (!response.ok) throw new PairingError(data.error || "Pairing failed.", response.status);
  return data;
}

export class Mailbox {
  private constructor(
    readonly code: string,
    private id: string,
    private secret: string,
  ) {}

  static async claim() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = generateCode();
      const id = await mailboxId(code);
      const secret = randomToken();
      try {
        await call({ action: "claim", id, secret });
        void codeKey(code); // warm the key so the first message decrypts quickly
        return new Mailbox(code, id, secret);
      } catch (error) {
        if (!(error instanceof PairingError) || error.status !== 409) throw error;
      }
    }
    throw new PairingError("Could not reserve a code. Try again.", 409);
  }

  /** Fetch and decrypt everything waiting in this device's mailbox. */
  async poll() {
    const { messages = [] } = await call({ action: "poll", id: this.id, secret: this.secret });
    const opened = await Promise.all(messages.map((sealed) => open(this.code, sealed)));
    return opened.filter((message): message is SignalMessage => message !== null);
  }

  /** Encrypt a message with the recipient's code and drop it in their mailbox. */
  static async send(toCode: string, message: SignalMessage) {
    try {
      await call({ action: "send", id: await mailboxId(toCode), message: await seal(toCode, message) });
    } catch (error) {
      if (error instanceof PairingError && error.status === 404) {
        throw new PairingError("No device is using that code. Check it and try again.", 404);
      }
      throw error;
    }
  }

  release() {
    const body = JSON.stringify({ action: "release", id: this.id, secret: this.secret });
    if (!navigator.sendBeacon?.("/api/signal", body)) {
      void fetch("/api/signal", { method: "POST", body, keepalive: true }).catch(() => undefined);
    }
  }
}
