/**
 * Short-lived signaling storage.
 *
 * Each device claims a "mailbox" keyed by a hash of its 6-digit code. Other
 * devices drop encrypted WebRTC offers/answers into that mailbox, and the owner
 * drains it by polling. Nothing here ever sees a file, a plaintext code, or a
 * plaintext SDP.
 *
 * In production set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the
 * Vercel KV equivalents KV_REST_API_URL + KV_REST_API_TOKEN) so every server
 * instance shares the same mailboxes. Without them an in-memory store is used,
 * which is fine for `next dev` / a single `next start` process.
 */

export const MAILBOX_TTL_SECONDS = 10 * 60;
export const MAX_MESSAGES = 16;

export interface SignalStore {
  /** Create the mailbox if the id is free. Returns false when already taken. */
  claim(id: string, secret: string): Promise<boolean>;
  /** Append a message. Returns false if the mailbox does not exist or is full. */
  push(id: string, message: string): Promise<boolean>;
  /** Drain all messages. Returns null if the mailbox is gone or the secret is wrong. */
  drain(id: string, secret: string): Promise<string[] | null>;
  release(id: string, secret: string): Promise<void>;
}

type MemoryMailbox = { secret: string; messages: string[]; expiresAt: number };

class MemoryStore implements SignalStore {
  private boxes = new Map<string, MemoryMailbox>();

  private live(id: string) {
    const box = this.boxes.get(id);
    if (box && box.expiresAt < Date.now()) {
      this.boxes.delete(id);
      return undefined;
    }
    return box;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, box] of this.boxes) if (box.expiresAt < now) this.boxes.delete(id);
  }

  async claim(id: string, secret: string) {
    this.sweep();
    if (this.live(id)) return false;
    this.boxes.set(id, { secret, messages: [], expiresAt: Date.now() + MAILBOX_TTL_SECONDS * 1000 });
    return true;
  }

  async push(id: string, message: string) {
    const box = this.live(id);
    if (!box || box.messages.length >= MAX_MESSAGES) return false;
    box.messages.push(message);
    return true;
  }

  async drain(id: string, secret: string) {
    const box = this.live(id);
    if (!box || box.secret !== secret) return null;
    box.expiresAt = Date.now() + MAILBOX_TTL_SECONDS * 1000;
    return box.messages.splice(0);
  }

  async release(id: string, secret: string) {
    const box = this.live(id);
    if (box && box.secret === secret) this.boxes.delete(id);
  }
}

class UpstashStore implements SignalStore {
  constructor(
    private url: string,
    private token: string,
  ) {}

  private async pipeline(commands: (string | number)[][]) {
    const response = await fetch(this.url.replace(/\/$/, "") + "/multi-exec", {
      method: "POST",
      headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Signal store request failed: " + response.status);
    const results = (await response.json()) as { result?: unknown; error?: string }[];
    return results.map((entry) => {
      if (entry.error) throw new Error(entry.error);
      return entry.result;
    });
  }

  async claim(id: string, secret: string) {
    const [result] = await this.pipeline([["SET", "tl:box:" + id, secret, "NX", "EX", MAILBOX_TTL_SECONDS]]);
    return result === "OK";
  }

  async push(id: string, message: string) {
    const [exists, length] = await this.pipeline([
      ["EXISTS", "tl:box:" + id],
      ["LLEN", "tl:msg:" + id],
    ]);
    if (exists !== 1 || Number(length) >= MAX_MESSAGES) return false;
    await this.pipeline([
      ["RPUSH", "tl:msg:" + id, message],
      ["EXPIRE", "tl:msg:" + id, MAILBOX_TTL_SECONDS],
    ]);
    return true;
  }

  async drain(id: string, secret: string) {
    const [stored, messages] = await this.pipeline([
      ["GET", "tl:box:" + id],
      ["LRANGE", "tl:msg:" + id, 0, -1],
      ["DEL", "tl:msg:" + id],
      ["EXPIRE", "tl:box:" + id, MAILBOX_TTL_SECONDS],
    ]);
    if (stored !== secret) return null;
    return Array.isArray(messages) ? messages.map(String) : [];
  }

  async release(id: string, secret: string) {
    const [stored] = await this.pipeline([["GET", "tl:box:" + id]]);
    if (stored === secret) await this.pipeline([["DEL", "tl:box:" + id, "tl:msg:" + id]]);
  }
}

const globalStore = globalThis as typeof globalThis & { __transferlyStore?: SignalStore };

export class StoreNotConfiguredError extends Error {}

export function getStore(): SignalStore {
  if (globalStore.__transferlyStore) return globalStore.__transferlyStore;

  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!(url && token) && process.env.VERCEL) {
    // Vercel runs many short-lived instances; an in-memory store loses
    // mailboxes between requests and pairing hangs. Fail loudly instead.
    throw new StoreNotConfiguredError(
      "Pairing storage isn't set up on this deployment. Connect an Upstash Redis store in the Vercel project.",
    );
  }
  globalStore.__transferlyStore = url && token ? new UpstashStore(url, token) : new MemoryStore();
  return globalStore.__transferlyStore;
}
