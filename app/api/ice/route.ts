import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ICE servers for WebRTC. STUN finds a direct path; TURN relays the
 * (still end-to-end DTLS-encrypted) traffic when networks block direct
 * connections. TURN credentials are minted here so secrets stay server-side.
 *
 * Configure ONE of:
 *  - CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN  (Cloudflare Realtime TURN)
 *  - TURN_CREDENTIALS_URL  (any endpoint returning an iceServers array, e.g. Metered's
 *    https://<app>.metered.live/api/v1/turn/credentials?apiKey=…)
 *  - TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL  (your own coturn)
 */

const STUN: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

function asServers(data: unknown): RTCIceServer[] {
  const list = Array.isArray(data) ? data : (data as { iceServers?: unknown })?.iceServers;
  if (Array.isArray(list)) return list as RTCIceServer[];
  if (list && typeof list === "object") return [list as RTCIceServer];
  return [];
}

async function turnServers(): Promise<RTCIceServer[]> {
  const env = process.env;

  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + env.CLOUDFLARE_TURN_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 6 * 60 * 60 }),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error("Cloudflare TURN: " + response.status);
    return asServers(await response.json());
  }

  if (env.TURN_CREDENTIALS_URL) {
    const response = await fetch(env.TURN_CREDENTIALS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("TURN credentials URL: " + response.status);
    return asServers(await response.json());
  }

  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return [{ urls: env.TURN_URLS.split(",").map((url) => url.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  }

  return [];
}

export async function GET() {
  let relay: RTCIceServer[] = [];
  try {
    relay = await turnServers();
  } catch (error) {
    console.error("TURN credentials failed:", error);
  }
  return NextResponse.json(
    { iceServers: [...STUN, ...relay], relay: relay.length > 0 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
