/**
 * An image's pixel size, read from its header — PNG, JPEG, GIF and WebP, the formats a phone or a
 * clipboard actually produces (B-703). Recorded on the `asset` row so the client can reserve an
 * image's box before the lazy-loaded bytes arrive, and rows below it stop jumping when it loads.
 *
 * Hand-rolled rather than a dependency: each format puts its size at a fixed place or behind a
 * short marker walk, and an image library (sharp, image-size) is a native build or a 100 KB
 * package for forty lines of reading.
 *
 * The size is the one a browser DISPLAYS. A phone JPEG is usually stored sideways with an EXIF
 * orientation tag saying so, and browsers apply it (`image-orientation: from-image` is the
 * default), so for orientations 5-8 width and height are swapped here. Reserving the stored size
 * instead would reserve a landscape box for a portrait photo — a jump as bad as no box.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** `null` when the bytes are not one of the four formats, or the header is cut short or broken.
 * Never throws. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  try {
    return png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
  } catch {
    return null;
  }
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}

function sane(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function png(b: Uint8Array): ImageSize | null {
  // Signature, then the IHDR chunk is always first: length(4) "IHDR"(4) width(4) height(4).
  if (b.length < 24 || b[0] !== 0x89 || ascii(b, 1, 3) !== "PNG") return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  const v = view(b);
  return sane(v.getUint32(16), v.getUint32(20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || ascii(b, 0, 4) !== "GIF8") return null;
  const v = view(b);
  return sane(v.getUint16(6, true), v.getUint16(8, true));
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 16 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const v = view(b);
  switch (ascii(b, 12, 4)) {
    case "VP8 ": // lossy: 14-bit sizes after the 3-byte frame tag and the 9d 01 2a start code
      if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return sane(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
    case "VP8L": {
      // lossless: signature 0x2f, then width-1 and height-1 as two 14-bit fields
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = v.getUint32(21, true);
      return sane((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    case "VP8X": {
      if (b.length < 30) return null;
      // extended (alpha, animation): canvas width-1 and height-1 as 24-bit fields
      const w = (b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16);
      const h = (b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16);
      return sane(w + 1, h + 1);
    }
    default:
      return null;
  }
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const v = view(b);
  let orientation = 1;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null; // lost sync: not a marker where one must be
    const marker = b[at + 1] as number;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before any SOF
    const len = v.getUint16(at + 2);
    if (len < 2) return null;
    const body = at + 4;
    if (marker === 0xe1 && body + 6 <= b.length && ascii(b, body, 6) === "Exif\0\0") {
      orientation = exifOrientation(b.subarray(body + 6, Math.min(b.length, at + 2 + len))) ?? 1;
    }
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (body + 5 > b.length) return null;
      const height = v.getUint16(body + 1);
      const width = v.getUint16(body + 3);
      return orientation >= 5 && orientation <= 8 ? sane(height, width) : sane(width, height);
    }
    at += 2 + len;
  }
  return null;
}

/** The EXIF orientation tag (0x0112) from IFD0 of a TIFF block, or `null`. */
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null;
  const order = ascii(t, 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const v = view(t);
  const ifd = v.getUint32(4, le);
  if (ifd + 2 > t.length) return null;
  const count = v.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > t.length) return null;
    if (v.getUint16(entry, le) === 0x0112) return v.getUint16(entry + 8, le);
  }
  return null;
}
