/**
 * Where received files go, and how they're saved out again.
 *
 * Incoming data is streamed to disk as it arrives instead of piling up in memory:
 *  - "folder": straight into a folder the user picked (File System Access API,
 *    Chrome/Edge desktop). The file is simply there when the transfer ends.
 *  - "opfs": the browser's private on-disk storage (Origin Private File System:
 *    Chrome, Edge, Firefox, Android, recent Safari). Kept for a while so it can be
 *    saved later from History.
 *  - "memory": last resort when neither is available.
 */

import { CRC32_START, crc32Finish, crc32Update } from "./crc32";
import { ZIP_MAX_BYTES, ZIP_MAX_FILES, buildZip } from "./zip";

export type StorageKind = "folder" | "opfs" | "memory";

export type ReceivedFile = {
  blob?: Blob;
  storage: StorageKind;
  /** OPFS entry name, or the folder name for "folder". */
  location?: string;
  crc: number;
};

export type IncomingMeta = { id: string; name: string; size: number; mime: string };

export interface Sink {
  write(chunk: ArrayBuffer): void;
  finish(): Promise<ReceivedFile>;
  abort(): void;
}

type Backend = {
  storage: StorageKind;
  write(chunk: ArrayBuffer): Promise<void> | void;
  close(): Promise<{ blob?: Blob; location?: string }>;
  abort(): Promise<void>;
};

type DirectoryHandle = FileSystemDirectoryHandle & {
  values?: () => AsyncIterable<FileSystemHandle>;
  queryPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
};
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "readwrite"; id?: string }) => Promise<DirectoryHandle> };

const OPFS_DIR = "transferly";

// ---- capabilities ------------------------------------------------------------

export const canPickFolder = () => typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";

export const canUseOpfs = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function" &&
  typeof FileSystemFileHandle !== "undefined" &&
  "createWritable" in FileSystemFileHandle.prototype;

export async function pickFolder(): Promise<DirectoryHandle | null> {
  try {
    return (await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite", id: "transferly" })) ?? null;
  } catch {
    return null; // cancelled
  }
}

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/** A name that doesn't overwrite anything already in the folder: "photo (2).jpg". */
async function freeName(dir: FileSystemDirectoryHandle, wanted: string) {
  const clean = wanted.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? clean : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate; // doesn't exist yet
    }
  }
  return `${stem} (${Date.now()})${ext}`;
}

// ---- receiving -------------------------------------------------------------------

async function fileBackend(dir: FileSystemDirectoryHandle, name: string, storage: StorageKind, label: string): Promise<Backend> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  return {
    storage,
    write: (chunk) => writable.write(chunk),
    async close() {
      await writable.close();
      return { blob: await handle.getFile(), location: label || name };
    },
    async abort() {
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}

function memoryBackend(mime: string): Backend {
  const chunks: ArrayBuffer[] = [];
  return {
    storage: "memory",
    write: (chunk) => void chunks.push(chunk),
    close: async () => ({ blob: new Blob(chunks, { type: mime }) }),
    abort: async () => void (chunks.length = 0),
  };
}

/**
 * A sink accepts chunks synchronously (in arrival order) and writes them to its
 * backend in the background. If the preferred backend can't be opened, it falls
 * back to memory so the transfer still completes.
 */
export function createSink(meta: IncomingMeta, folder: DirectoryHandle | null): Sink {
  let crc = CRC32_START;
  let failed: unknown = null;

  const open = async (): Promise<Backend> => {
    if (folder) {
      try {
        return await fileBackend(folder, await freeName(folder, meta.name), "folder", folder.name);
      } catch {
        // Permission lost or folder gone: fall through.
      }
    }
    if (canUseOpfs()) {
      try {
        return await fileBackend(await opfsDir(), meta.id, "opfs", meta.id);
      } catch {
        // Quota or unsupported: fall through.
      }
    }
    return memoryBackend(meta.mime);
  };

  let chain: Promise<Backend> = open();

  return {
    write(chunk) {
      crc = crc32Update(crc, new Uint8Array(chunk));
      chain = chain.then(async (backend) => {
        if (!failed) await backend.write(chunk);
        return backend;
      });
      chain.catch((error) => (failed ??= error));
    },
    async finish() {
      const backend = await chain;
      if (failed) throw failed;
      const { blob, location } = await backend.close();
      return { blob, storage: backend.storage, location, crc: crc32Finish(crc) };
    },
    abort() {
      void chain.then((backend) => backend.abort()).catch(() => undefined);
    },
  };
}

// ---- stored files (OPFS) -----------------------------------------------------------

export async function openStored(location: string): Promise<File | null> {
  try {
    return await (await (await opfsDir()).getFileHandle(location)).getFile();
  } catch {
    return null;
  }
}

export async function deleteStored(location: string) {
  try {
    await (await opfsDir()).removeEntry(location);
  } catch {
    // Already gone.
  }
}

/** Ask the browser not to evict our stored files under storage pressure. */
export function requestPersistence() {
  void navigator.storage?.persist?.().catch(() => undefined);
}

// ---- saving out ----------------------------------------------------------------------

export type Saveable = { name: string; size: number; crc?: number; getBlob: () => Promise<Blob | null> };

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Save one or many files. Must be called straight from a click (the folder
 * picker needs the user gesture), so nothing is awaited before it.
 *  - one file: a normal download;
 *  - several, where folders can be picked (Chrome/Edge desktop): into a chosen folder;
 *  - otherwise: one ZIP (no copying, built from the files on disk), or one-by-one
 *    downloads if the ZIP would be too large.
 * Resolves with a short summary for the UI, or null if cancelled.
 */
export async function saveFiles(items: Saveable[]): Promise<string | null> {
  if (!items.length) return null;

  if (items.length === 1) {
    const blob = await items[0].getBlob();
    if (!blob) return "That file is no longer stored on this device.";
    downloadBlob(blob, items[0].name);
    return null;
  }

  if (canPickFolder()) {
    const folder = await pickFolder();
    if (!folder) return null;
    let saved = 0;
    for (const item of items) {
      const blob = await item.getBlob();
      if (!blob) continue;
      const handle = await folder.getFileHandle(await freeName(folder, item.name), { create: true });
      await blob.stream().pipeTo(await handle.createWritable());
      saved += 1;
    }
    return `Saved ${saved} file${saved === 1 ? "" : "s"} to “${folder.name}”.`;
  }

  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (total < ZIP_MAX_BYTES && items.length < ZIP_MAX_FILES && items.every((item) => typeof item.crc === "number")) {
    const entries = [];
    for (const item of items) {
      const blob = await item.getBlob();
      if (blob) entries.push({ name: item.name, blob, crc: item.crc! });
    }
    downloadBlob(buildZip(entries), `transferly-${new Date().toISOString().slice(0, 10)}.zip`);
    return `Saved ${entries.length} files as a ZIP.`;
  }

  for (const item of items) {
    const blob = await item.getBlob();
    if (blob) downloadBlob(blob, item.name);
    await new Promise((resolve) => setTimeout(resolve, 400)); // browsers throttle bursts of downloads
  }
  return null;
}
