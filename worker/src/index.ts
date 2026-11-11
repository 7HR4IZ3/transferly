/**
 * Transferly signaling + relay-credential Worker (Cloudflare free plan).
 *
 * - One Durable Object per pairing code ("mailbox"). The code's owner holds a
 *   hibernating WebSocket to it; other devices POST encrypted messages that are
 *   pushed down that socket instantly. No polling.
 * - /ice hands out short-lived Cloudflare TURN credentials, but only to a device
 *   that owns a live code and is in the middle of pairing, and only while this
 *   month's relay budget lasts.
 * - /usage lets clients report bytes they sent through the relay.
 *
 * The Worker never sees codes, file names or file data: mailbox ids are
 * SHA-256(code) and messages are AES-GCM ciphertext created in the browser.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  BUDGET: DurableObjectNamespace<Budget>;
  /** Comma-separated origins allowed to use this Worker, or "*" (default). */
  ALLOWED_ORIGINS?: string;
  /** Secrets for Cloudflare Realtime TURN (set with `wrangler secret put`). */
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  /** Monthly relay budget in GB (default 900, under the 1,000 GB free tier). */
  RELAY_MONTHLY_GB?: string;
  /** Largest file the app will send over the relay, in MB (default 1024). */
  RELAY_MAX_FILE_MB?: string;
}

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

const ID_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_MESSAGE_LENGTH = 32 * 1024;
const MAX_QUEUED = 16;
const MAX_SENDS_PER_MINUTE = 30;
const IDLE_EXPIRY_MS = 10 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const TURN_TTL_SECONDS = 60 * 60;
const STUN: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

type SendResult = "ok" | "missing" | "busy";

// ---------------------------------------------------------------------------
// Mailbox: one per pairing code
// ---------------------------------------------------------------------------

export class Mailbox extends DurableObject<Env> {
  private sendTimes: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** WebSocket connect = claim (or reconnect to) this code. */
  async fetch(request: Request) {
    const secret = new URL(request.url).searchParams.get("secret") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    const stored = await this.ctx.storage.get<string>("secret");
    if (stored && stored !== secret) {
      server.send(JSON.stringify({ type: "taken" }));
      server.close(4009, "taken");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!stored) await this.ctx.storage.put("secret", secret);
    await this.ctx.storage.deleteAlarm();
    // A reconnect replaces any older socket from the same owner.
    for (const socket of this.ctx.getWebSockets()) if (socket !== server) socket.close(4000, "replaced");

    server.send(JSON.stringify({ type: "ready" }));
    const queued = (await this.ctx.storage.get<string[]>("queue")) ?? [];
    for (const message of queued) server.send(JSON.stringify({ type: "message", message }));
    if (queued.length) await this.ctx.storage.delete("queue");

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Deliver an encrypted message to the owner (queued briefly if they're reconnecting). */
  async send(message: string): Promise<SendResult> {
    if (!(await this.ctx.storage.get<string>("secret"))) return "missing";

    const now = Date.now();
    this.sendTimes = this.sendTimes.filter((time) => now - time < 60_000);
    if (this.sendTimes.length >= MAX_SENDS_PER_MINUTE) return "busy";
    this.sendTimes.push(now);
    await this.ctx.storage.put("lastMessageAt", now);

    const sockets = this.ctx.getWebSockets();
    if (sockets.length) {
      for (const socket of sockets) socket.send(JSON.stringify({ type: "message", message }));
      return "ok";
    }
    const queue = (await this.ctx.storage.get<string[]>("queue")) ?? [];
    if (queue.length >= MAX_QUEUED) return "busy";
    queue.push(message);
    await this.ctx.storage.put("queue", queue);
    return "ok";
  }

  /** May this owner get relay credentials? Only while actually pairing. */
  async mayUseRelay(secret: string) {
    const stored = await this.ctx.storage.get<string>("secret");
    const lastMessageAt = (await this.ctx.storage.get<number>("lastMessageAt")) ?? 0;
    return Boolean(stored) && stored === secret && Date.now() - lastMessageAt < PAIRING_WINDOW_MS;
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (data === "release") {
      await this.ctx.storage.deleteAll();
      socket.close(1000, "released");
    }
  }

  async webSocketClose(socket: WebSocket, code: number) {
    try {
      socket.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    if (this.ctx.getWebSockets().filter((other) => other !== socket).length === 0 && (await this.ctx.storage.get("secret"))) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_EXPIRY_MS);
    }
  }

  /** Nobody reconnected for a while: free the code. */
  async alarm() {
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Budget: one global counter of relay bytes per calendar month
// ---------------------------------------------------------------------------

export class Budget extends DurableObject<Env> {
  private key() {
    return "used:" + new Date().toISOString().slice(0, 7);
  }

  async used() {
    return (await this.ctx.storage.get<number>(this.key())) ?? 0;
  }

  async add(bytes: number) {
    const total = (await this.used()) + bytes;
    await this.ctx.storage.put(this.key(), total);
    return total;
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((value) => value.trim());
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function originAllowed(request: Request, env: Env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((value) => value.trim());
  return allowed.includes("*") || allowed.includes(request.headers.get("Origin") ?? "");
}

const relayLimitBytes = (env: Env) => Number(env.RELAY_MONTHLY_GB ?? "900") * 1e9;
const relayMaxFileBytes = (env: Env) => Number(env.RELAY_MAX_FILE_MB ?? "1024") * 1024 * 1024;

async function turnServers(env: Env): Promise<RTCIceServer[]> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + env.CLOUDFLARE_TURN_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    },
  );
  if (!response.ok) throw new Error("TURN credentials failed: " + response.status);
  const data = (await response.json()) as { iceServers?: RTCIceServer | RTCIceServer[] };
  const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  // Browsers block port 53, so drop those URLs (Cloudflare's own recommendation).
  return list
    .map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url: string) => !/:53(\?|$)/.test(url)),
    }))
    .filter((server) => server.urls.length > 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!originAllowed(request, env)) return json(403, { error: "Origin not allowed." });

    // Owner connects: claim / reconnect a code.
    if (url.pathname === "/ws") {
      const id = url.searchParams.get("id") ?? "";
      const secret = url.searchParams.get("secret") ?? "";
      if (request.headers.get("Upgrade") !== "websocket") return json(426, { error: "Expected a WebSocket." });
      if (!ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return json(400, { error: "Invalid id or secret." });
      return env.MAILBOX.get(env.MAILBOX.idFromName(id)).fetch(request);
    }

    if (request.method !== "POST") return url.pathname === "/" ? json(200, { ok: true }) : json(404, { error: "Not found." });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "Invalid request." });
    }

    if (url.pathname === "/send") {
      const { id, message } = body;
      if (typeof id !== "string" || !ID_PATTERN.test(id)) return json(400, { error: "Invalid id." });
      if (typeof message !== "string" || !message || message.length > MAX_MESSAGE_LENGTH) return json(400, { error: "Invalid message." });
      const result = await env.MAILBOX.get(env.MAILBOX.idFromName(id)).send(message);
      if (result === "missing") return json(404, { error: "Code not found." });
      if (result === "busy") return json(429, { error: "That device is busy. Try again in a moment." });
      return json(200, { ok: true });
    }

    if (url.pathname === "/ice") {
      const { id, secret } = body;
      const base = { iceServers: STUN, relay: false, relayMaxBytes: relayMaxFileBytes(env) };
      if (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_API_TOKEN) return json(200, { ...base, reason: "not-configured" });
      if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
        return json(200, { ...base, reason: "not-pairing" });
      }
      if (!(await env.MAILBOX.get(env.MAILBOX.idFromName(id)).mayUseRelay(secret))) return json(200, { ...base, reason: "not-pairing" });
      if ((await env.BUDGET.get(env.BUDGET.idFromName("global")).used()) >= relayLimitBytes(env)) {
        return json(200, { ...base, reason: "budget" });
      }
      try {
        return json(200, { ...base, iceServers: [...STUN, ...(await turnServers(env))], relay: true });
      } catch (error) {
        console.error(error);
        return json(200, { ...base, reason: "error" });
      }
    }

    if (url.pathname === "/usage") {
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) return json(400, { error: "Invalid usage." });
      // Cap a single report so one client can't wipe the budget in one go.
      const total = await env.BUDGET.get(env.BUDGET.idFromName("global")).add(Math.min(bytes, 2 * relayMaxFileBytes(env)));
      return json(200, { ok: true, usedGB: Math.round(total / 1e7) / 100 });
    }

    return json(404, { error: "Not found." });
  },
};
