const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7: time-ordered, so new blocks and ops sort by creation time, while still being
 * a valid UUID for Logseq-style `id::` properties and ((block refs)).
 * Monotonic within a process: same-millisecond ids increase via the 12-bit rand_a field.
 */
export function newId(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    seq = Math.floor(Math.random() * 0x800);
  } else {
    seq++;
    if (seq > 0xfff) {
      lastMs++;
      seq = 0;
    }
  }
  const ms = lastMs;
  const bytes = new Uint8Array(16);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | (seq >> 8);
  bytes[7] = seq & 0xff;
  const rand = crypto.getRandomValues(new Uint8Array(8));
  bytes[8] = 0x80 | ((rand[0] as number) & 0x3f);
  for (let i = 1; i < 8; i++) bytes[8 + i] = rand[i] as number;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
