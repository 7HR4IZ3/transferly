/** Incremental CRC-32 (as used by ZIP). Computed while a file arrives, so zipping later is instant. */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const CRC32_START = 0xffffffff;

export function crc32Update(state: number, bytes: Uint8Array) {
  let crc = state;
  for (let i = 0; i < bytes.length; i += 1) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

export function crc32Finish(state: number) {
  return (state ^ 0xffffffff) >>> 0;
}
