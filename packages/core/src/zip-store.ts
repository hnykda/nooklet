/**
 * A minimal streaming ZIP writer, STORE only (no compression), for the in-app Logseq import
 * (ADR 030): the browser turns a picked graph folder into one zip, a file at a time, and uploads it
 * in chunks while it is being written, so a 250 MB graph never has to sit in memory whole.
 *
 * No compression on purpose: a graph's bulk is images and PDFs, already compressed; its markdown
 * is small. Deflating in JavaScript would cost seconds of a phone's CPU to save little.
 *
 * Classic ZIP (no ZIP64): at most 65,535 entries and 4 GiB, both checked — the server's own
 * upload limit is far below that. Names are UTF-8 with the language-encoding flag (bit 11) set,
 * so `Plánování.md` survives on every reader that honours it (yauzl, Info-ZIP, macOS, Windows).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const UTF8_FLAG = 1 << 11;

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  mode: number;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipStoreError extends Error {}

/** Size of the local header + data for one entry, so a caller can total an archive up front. */
export function zipStoreEntrySize(name: string, size: number): number {
  return 30 + new TextEncoder().encode(name).length + size;
}

export class ZipStoreWriter {
  #offset = 0;
  #records: CentralRecord[] = [];
  #names = new Set<string>();
  #finished = false;

  /** Bytes written so far. */
  get offset(): number {
    return this.#offset;
  }

  /** The local header and data for one file, to be emitted in order. `mode` is the unix mode
   *  recorded in the central directory (a regular rw-r--r-- file unless a test says otherwise). */
  add(name: string, bytes: Uint8Array, modified: Date = new Date(), mode = 0o100644): Uint8Array[] {
    if (this.#finished) throw new ZipStoreError("the archive is already finished");
    if (this.#names.has(name)) throw new ZipStoreError(`duplicate entry "${name}"`);
    if (this.#records.length >= MAX_ENTRIES) {
      throw new ZipStoreError(`more than ${MAX_ENTRIES} files; too many for one archive`);
    }
    const encoded = new TextEncoder().encode(name);
    if (this.#offset + 30 + encoded.length + bytes.length > MAX_U32) {
      throw new ZipStoreError("the archive would be larger than 4 GiB");
    }
    this.#names.add(name);
    const crc = crc32(bytes);
    const { time, date } = dosTime(modified);
    const header = new Uint8Array(30 + encoded.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); // local file header signature
    v.setUint16(4, 20, true); // version needed (2.0)
    v.setUint16(6, UTF8_FLAG, true);
    v.setUint16(8, 0, true); // method: STORE
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true); // compressed size
    v.setUint32(22, bytes.length, true); // uncompressed size
    v.setUint16(26, encoded.length, true);
    v.setUint16(28, 0, true); // extra field length
    header.set(encoded, 30);
    this.#records.push({
      name: encoded,
      crc,
      size: bytes.length,
      offset: this.#offset,
      time,
      date,
      mode,
    });
    this.#offset += header.length + bytes.length;
    return [header, bytes];
  }

  /** The central directory and end record. Nothing may be added after. */
  finish(): Uint8Array {
    if (this.#finished) throw new ZipStoreError("the archive is already finished");
    this.#finished = true;
    const cdSize = this.#records.reduce((n, r) => n + 46 + r.name.length, 0);
    const out = new Uint8Array(cdSize + 22);
    const v = new DataView(out.buffer);
    let p = 0;
    for (const r of this.#records) {
      v.setUint32(p, 0x02014b50, true); // central directory header signature
      v.setUint16(p + 4, (3 << 8) | 20, true); // made by: unix, 2.0 (so the mode below is read)
      v.setUint16(p + 6, 20, true);
      v.setUint16(p + 8, UTF8_FLAG, true);
      v.setUint16(p + 10, 0, true);
      v.setUint16(p + 12, r.time, true);
      v.setUint16(p + 14, r.date, true);
      v.setUint32(p + 16, r.crc, true);
      v.setUint32(p + 20, r.size, true);
      v.setUint32(p + 24, r.size, true);
      v.setUint16(p + 28, r.name.length, true);
      v.setUint16(p + 30, 0, true); // extra
      v.setUint16(p + 32, 0, true); // comment
      v.setUint16(p + 34, 0, true); // disk
      v.setUint16(p + 36, 0, true); // internal attributes
      v.setUint32(p + 38, (r.mode << 16) >>> 0, true); // unix mode in the high half
      v.setUint32(p + 42, r.offset, true);
      out.set(r.name, p + 46);
      p += 46 + r.name.length;
    }
    v.setUint32(p, 0x06054b50, true); // end of central directory
    v.setUint16(p + 4, 0, true);
    v.setUint16(p + 6, 0, true);
    v.setUint16(p + 8, this.#records.length, true);
    v.setUint16(p + 10, this.#records.length, true);
    v.setUint32(p + 12, cdSize, true);
    v.setUint32(p + 16, this.#offset, true);
    v.setUint16(p + 20, 0, true);
    this.#offset += out.length;
    return out;
  }
}
