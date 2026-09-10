/**
 * Ids (ADR 004): 14 lowercase Crockford base32 characters.
 *   - 9 chars = 45 bits of milliseconds since the epoch (time-ordered, sortable)
 *   - 5 chars = 25 random bits, bumped monotonically inside the same millisecond
 * Short enough for LLM serialization (`- text ^1k7f3q9xz2hav4`), Obsidian `^id` compatible.
 * Logseq UUIDs are recognized by `isUuid` for import-time mapping.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_RE = /^[0-9a-hjkmnp-tv-z]{14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_CHARS = 9;
const RAND_CHARS = 5;
const RAND_MAX = 2 ** (RAND_CHARS * 5);

let lastMs = 0;
let lastRand = 0;

function encode(value: number, chars: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

export function newId(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    const r = crypto.getRandomValues(new Uint32Array(1))[0] as number;
    lastRand = r % RAND_MAX;
  } else {
    lastRand++;
    if (lastRand >= RAND_MAX) {
      lastMs++;
      lastRand = 0;
    }
  }
  return encode(lastMs, TIME_CHARS) + encode(lastRand, RAND_CHARS);
}

export function isId(s: string): boolean {
  return ID_RE.test(s);
}

/** Milliseconds encoded in an id (creation time). */
export function idTime(id: string): number {
  let v = 0;
  for (let i = 0; i < TIME_CHARS; i++) v = v * 32 + ALPHABET.indexOf(id[i] as string);
  return v;
}

/** Logseq-style UUID (v4 in file graphs); accepted on import and mapped to a vrite id. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
