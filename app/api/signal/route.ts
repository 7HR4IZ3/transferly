import { NextResponse, type NextRequest } from "next/server";
import { getStore, StoreNotConfiguredError, type SignalStore } from "../../../lib/server/store";

export const runtime = "nodejs";

const ID_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_MESSAGE_LENGTH = 32 * 1024;

// Small best-effort limiter so codes can't be guessed in bulk from one client.
// Per-instance only; put a real rate limiter in front for large deployments.
const hits = new Map<string, { count: number; resetAt: number }>();
const LIMITS = { claim: 20, send: 30, poll: 240, release: 30 } as const;

function limited(request: NextRequest, action: keyof typeof LIMITS) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  const key = action + ":" + ip;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > LIMITS[action];
}

function reply(status: number, body: Record<string, unknown> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "Invalid request." });
  }

  const { action, id, secret, message } = body;
  if (typeof action !== "string" || !(action in LIMITS)) return reply(400, { error: "Unknown action." });
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return reply(400, { error: "Invalid id." });
  if (limited(request, action as keyof typeof LIMITS)) return reply(429, { error: "Too many requests. Wait a moment." });

  let store: SignalStore;
  try {
    store = getStore();
  } catch (error) {
    console.error(error);
    return reply(503, { error: error instanceof StoreNotConfiguredError ? error.message : "Pairing service unavailable." });
  }
  const needsSecret = action !== "send";
  if (needsSecret && (typeof secret !== "string" || !SECRET_PATTERN.test(secret))) {
    return reply(400, { error: "Invalid secret." });
  }

  try {
    switch (action) {
      case "claim":
        return (await store.claim(id, secret as string)) ? reply(200, { ok: true }) : reply(409, { error: "Code taken." });
      case "send":
        if (typeof message !== "string" || !message || message.length > MAX_MESSAGE_LENGTH) {
          return reply(400, { error: "Invalid message." });
        }
        return (await store.push(id, message)) ? reply(200, { ok: true }) : reply(404, { error: "Code not found." });
      case "poll": {
        const messages = await store.drain(id, secret as string);
        return messages ? reply(200, { messages }) : reply(410, { error: "Code expired." });
      }
      case "release":
        await store.release(id, secret as string);
        return reply(200, { ok: true });
    }
  } catch (error) {
    console.error("Signal store error:", error);
    return reply(503, { error: "Pairing service unavailable." });
  }

  return reply(400, { error: "Unknown action." });
}
