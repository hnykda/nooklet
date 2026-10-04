/**
 * The limits and close codes of the two first-message-authenticated WebSockets, `/sync/live` and
 * `/ui/live` (B-676 H4/H12). Shared here because the server enforces them
 * (`packages/server/src/live-limits.ts`) and the web client has to react to each one
 * (`apps/web/src/sync/live-backoff.ts`) — a code the client does not know falls into "network
 * blip, retry in a second", which for a capacity refusal is exactly the reconnect loop the cap is
 * there to stop.
 */

/** Close codes. 4xxx is the application range (RFC 6455 §7.4.2); the last three digits echo the
 * nearest HTTP status so a log line reads without a lookup table. 1009 is the protocol's own
 * "message too big", which the `ws` library sends itself when `maxPayload` is exceeded. */
export const LIVE_CLOSE = {
  /** The socket's token was revoked while it was open (B-676 H3). */
  revoked: 4401,
  /** The hello's token is unknown, revoked, or lacks `can_sync`. */
  forbidden: 4403,
  /** No valid hello within `LIVE_HELLO_TIMEOUT_MS` of the socket opening. */
  helloTimeout: 4408,
  /** Over a connection cap: this token's (`--ws-max-per-token`) or the server's (`--ws-max-total`).
   * The close reason says which. */
  overCapacity: 4429,
  /** A frame over `LIVE_MAX_PAYLOAD_BYTES` (or, before hello, over `LIVE_MAX_PRE_HELLO_BYTES`). */
  tooBig: 1009,
} as const;

/** How long a socket may stay open without a valid hello. A real client sends hello in the same
 * tick as `open`; 10 s leaves room for a phone on a bad network. */
export const LIVE_HELLO_TIMEOUT_MS = 10_000;

/**
 * Largest frame the server accepts on either socket (the `ws` `maxPayload`, default 100 MiB).
 *
 * Sized by `tools/probes/security/ws-frame-sizes.mjs`: every client frame is under ~2 KB except
 * `/ui/live`'s `state.result`, which lists the selected block ids at 17 bytes each over a ~1 KB
 * base. The largest real page is ~9.4k lines (docs/review/2026-10-03-sweep-core.md), so a
 * select-all there is at most ~160 KB. 512 KiB holds ~30,000 selected ids, three times that, and
 * the client trims the list rather than send a frame over the limit
 * (`apps/web/src/live/message-handler.ts`), so a legitimate client never hits it.
 */
export const LIVE_MAX_PAYLOAD_BYTES = 512 * 1024;

/** Before a socket has authenticated, the only frame worth reading is a hello (under 1 KB even
 * with a long page name). Anything larger closes it with `LIVE_CLOSE.tooBig`, so an anonymous
 * socket cannot make the server parse half-megabyte frames for the full hello timeout. */
export const LIVE_MAX_PRE_HELLO_BYTES = 16 * 1024;

/** Default caps, overridable with `nooklet serve --ws-max-per-token / --ws-max-total`. */
export const LIVE_DEFAULT_MAX_PER_TOKEN = 20;
export const LIVE_DEFAULT_MAX_TOTAL = 500;
