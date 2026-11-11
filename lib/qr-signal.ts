/**
 * Compact WebRTC descriptions for offline (QR) pairing.
 *
 * A full SDP is ~1–2 KB. Only a few fields matter for our single data-channel
 * connection, so we pack those into a short string (~120–160 chars) that fits
 * in one small, easy-to-scan QR code, and rebuild a minimal SDP on the other side.
 *
 * Format: TLQ1~<o|a>~<sid>~<mid>~<setup>~<ufrag>~<pwd>~<fingerprint b64url>~<cand,cand,…>
 * Candidate: <h|s|r><address>_<port>   (host / server-reflexive / relay)
 */

export const QR_PREFIX = "TLQ1";
const SEP = "~";
const MAX_CANDIDATES = 6;

export type QrSignal = { kind: "offer" | "answer"; sid: string; sdp: string };

const SETUP_CODES: Record<string, string> = { actpass: "x", active: "c", passive: "p" };
const SETUP_NAMES: Record<string, string> = { x: "actpass", c: "active", p: "passive" };
const TYPE_CODES: Record<string, string> = { host: "h", srflx: "s", prflx: "s", relay: "r" };
const TYPE_NAMES: Record<string, string> = { h: "host", s: "srflx", r: "relay" };
const PRIORITY: Record<string, number> = { host: 2122260223, srflx: 1686052607, relay: 41885439 };

function hexToBase64Url(hex: string) {
  const bytes = hex.split(":").map((pair) => parseInt(pair, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToHex(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function attribute(sdp: string, name: string) {
  return sdp.match(new RegExp("^a=" + name + ":(.+)$", "m"))?.[1]?.trim();
}

export function packSignal(kind: "offer" | "answer", sid: string, sdp: string) {
  const ufrag = attribute(sdp, "ice-ufrag");
  const pwd = attribute(sdp, "ice-pwd");
  const fingerprint = attribute(sdp, "fingerprint");
  const setup = attribute(sdp, "setup") ?? (kind === "offer" ? "actpass" : "active");
  const mid = attribute(sdp, "mid") ?? "0";
  if (!ufrag || !pwd || !fingerprint) throw new Error("The browser produced an incomplete connection description.");

  const [algorithm, hex] = fingerprint.split(" ");
  if (algorithm.toLowerCase() !== "sha-256") throw new Error("Unsupported certificate fingerprint.");

  const candidates: string[] = [];
  for (const match of sdp.matchAll(/^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\w+)/gm)) {
    const [, component, protocol, address, port, type] = match;
    if (component !== "1" || protocol.toLowerCase() !== "udp" || !TYPE_CODES[type]) continue;
    const entry = TYPE_CODES[type] + address + "_" + port;
    if (!candidates.includes(entry)) candidates.push(entry);
  }
  // Prefer IPv4 LAN addresses, then the rest; keep the QR small.
  candidates.sort((a, b) => Number(/^h\d+\.\d+\.\d+\.\d+_/.test(b)) - Number(/^h\d+\.\d+\.\d+\.\d+_/.test(a)));

  return [
    QR_PREFIX,
    kind === "offer" ? "o" : "a",
    sid,
    mid,
    SETUP_CODES[setup] ?? "x",
    ufrag,
    pwd,
    hexToBase64Url(hex),
    candidates.slice(0, MAX_CANDIDATES).join(","),
  ].join(SEP);
}

export function unpackSignal(text: string): QrSignal {
  const parts = text.trim().split(SEP);
  if (parts.length !== 9 || parts[0] !== QR_PREFIX || (parts[1] !== "o" && parts[1] !== "a")) {
    throw new Error("That isn't a Transferly code.");
  }
  const [, kindCode, sid, mid, setupCode, ufrag, pwd, fingerprint, candidateList] = parts;
  const kind = kindCode === "o" ? "offer" : "answer";

  const lines = [
    "v=0",
    "o=- " + Math.floor(Math.random() * 1e15) + " 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE " + mid,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:" + ufrag,
    "a=ice-pwd:" + pwd,
    "a=fingerprint:sha-256 " + base64UrlToHex(fingerprint),
    "a=setup:" + (SETUP_NAMES[setupCode] ?? (kind === "offer" ? "actpass" : "active")),
    "a=mid:" + mid,
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];

  candidateList
    .split(",")
    .filter(Boolean)
    .forEach((entry, index) => {
      const type = TYPE_NAMES[entry[0]];
      const split = entry.lastIndexOf("_");
      if (!type || split < 2) return;
      const address = entry.slice(1, split);
      const port = entry.slice(split + 1);
      const extra = type === "host" ? "" : " raddr 0.0.0.0 rport 0";
      lines.push(`a=candidate:${index + 1} 1 udp ${PRIORITY[type] - index} ${address} ${port} typ ${type}${extra}`);
    });
  lines.push("a=end-of-candidates");

  return { kind, sid, sdp: lines.join("\r\n") + "\r\n" };
}
