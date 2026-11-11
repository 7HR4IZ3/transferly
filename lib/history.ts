/**
 * Transfer history, kept on this device (localStorage for the list, OPFS for
 * the received files themselves). Received files are kept for KEEP_DAYS, then
 * removed automatically; entries stay in the list (marked as no longer stored).
 */

import { deleteStored, type StorageKind } from "./files";

export type HistoryEntry = {
  /** `${direction}:${transferId}` */
  key: string;
  direction: "in" | "out";
  name: string;
  size: number;
  mime?: string;
  /** The other device's code, when paired by code. */
  peer?: string;
  at: number;
  status: "done" | "failed";
  storage?: StorageKind;
  location?: string;
  crc?: number;
};

const STORAGE_KEY = "transferly.history.v1";
const MAX_ENTRIES = 500;
export const KEEP_DAYS = 7;

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: HistoryEntry[] | null = null;

function read(): HistoryEntry[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as HistoryEntry[];
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(entries: HistoryEntry[]) {
  cache = entries.slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: keep the in-memory copy for this session.
  }
  listeners.forEach((listener) => listener());
}

export const history = {
  list: (): HistoryEntry[] => (typeof window === "undefined" ? EMPTY : read()),
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  record(entry: HistoryEntry) {
    const others = read().filter((item) => item.key !== entry.key);
    write([entry, ...others]);
  },
  async remove(keys: string[]) {
    const set = new Set(keys);
    const doomed = read().filter((item) => set.has(item.key));
    await Promise.all(doomed.filter((item) => item.storage === "opfs" && item.location).map((item) => deleteStored(item.location!)));
    write(read().filter((item) => !set.has(item.key)));
  },
  async clear() {
    await history.remove(read().map((item) => item.key));
  },
  /** Drop stored files older than KEEP_DAYS (the entries remain, marked not stored). */
  async expire() {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const old = read().filter((item) => item.storage === "opfs" && item.at < cutoff);
    if (!old.length) return;
    await Promise.all(old.map((item) => item.location && deleteStored(item.location)));
    const expired = new Set(old.map((item) => item.key));
    write(read().map((item) => (expired.has(item.key) ? { ...item, storage: undefined, location: undefined } : item)));
  },
};

const EMPTY: HistoryEntry[] = [];
