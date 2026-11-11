/**
 * Minimal ZIP writer ("stored", no compression). The archive is a Blob made of
 * small headers plus the original file Blobs, so nothing is copied into
 * memory, even for disk-backed files. CRCs are computed during transfer.
 */

export type ZipEntry = { name: string; blob: Blob; crc: number; date?: Date };

/** Classic ZIP (no ZIP64) limits. */
export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;
export const ZIP_MAX_FILES = 65_000;

const encoder = new TextEncoder();

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Give duplicate names a " (2)" suffix so every entry survives extraction. */
function uniqueNames(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw.replace(/[\\/]/g, "_") || "file";
    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (!count) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}` : `${name} (${count + 1})`;
  });
}

export function buildZip(entries: ZipEntry[]): Blob {
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const names = uniqueNames(entries.map((entry) => entry.name));

  entries.forEach((entry, index) => {
    const name = encoder.encode(names[index]) as Uint8Array<ArrayBuffer>;
    const size = entry.blob.size;
    const { time, day } = dosDateTime(entry.date ?? new Date());

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, entry.blob);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, day, true);
    header.setUint32(16, entry.crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    const record = new Uint8Array(46 + name.length);
    record.set(new Uint8Array(header.buffer));
    record.set(name, 46);
    central.push(record);

    offset += 30 + name.length + size;
  });

  const centralSize = central.reduce((total, record) => total + record.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
