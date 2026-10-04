/**
 * Wire types for the sync protocol (ADR 003, research/03-sync.md §6.5). `packages/server`'s
 * `/sync/*` routes are being built concurrently against this same protocol — these types are this
 * package's copy of the contract, not an import from the server (the client must not depend on
 * `@nooklet/server`). Reconciled against the server's actual
 * implementation (snake_case wire fields per docs/spec/00-conventions.md); if it changes again,
 * only `http-transport.ts` and this file need to move;
 * `sync-client.ts`'s logic is written entirely against the `SyncTransport` interface below.
 */

import type { Op } from "@nooklet/core";
import { LIVE_CLOSE } from "@nooklet/core";

export interface PushRequestBody {
  device_id: string;
  ops: Op[];
}

export interface PushAccepted {
  id: string;
  seq: number;
}

export interface PushRejected {
  id: string;
  reason: string;
}

export interface PushResponse {
  accepted: PushAccepted[];
  rejected: PushRejected[];
  /** Server-authored corrective ops (e.g. a rejected `block.place`'s corrective move), applied
   * via `applyOps` exactly like any pulled op (ADR 003: "Clients never rebase"). */
  corrections: Op[];
  /** Server's current head after this push; useful as a cursor floor. */
  server_seq: number;
  /** For each `page.create` refused with `page-key-collision`: the server's page holding the name
   * (ADR 024's two-device race). Absent when there were none. See `./refused-page.ts`. */
  refused_pages?: Array<{
    refused_id: string;
    page: SnapshotPageRow;
    page_props: SnapshotPagePropRow[];
  }>;
}

export interface PullResponse {
  ops: Op[];
  /** New value for `sync_state.server_cursor`. */
  cursor: number;
  /** True when more ops remain past `cursor` — pull again immediately rather than waiting. */
  has_more: boolean;
}

/** Row shapes mirror `docs/spec/sql-schema.md`'s column names verbatim: the snapshot is a direct
 * dump of the server's state tables, inserted as-is (not replayed through `applyOps`) because
 * these rows already carry their final per-field HLCs. */
export interface SnapshotPageRow {
  id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  name_hlc: string;
  deleted_hlc: string | null;
}

export interface SnapshotBlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  place_hlc: string;
  content_hlc: string;
  marker_hlc: string | null;
  priority_hlc: string | null;
  collapsed_hlc: string | null;
  scheduled_hlc: string | null;
  deadline_hlc: string | null;
  repeat_hlc: string | null;
  done_hlc: string | null;
  deleted_hlc: string | null;
}

export interface SnapshotBlockPropRow {
  block_id: string;
  key: string;
  value: string | null;
  hlc: string;
}

export interface SnapshotPagePropRow {
  page_id: string;
  key: string;
  value: string | null;
  hlc: string;
}

export interface SnapshotResponse {
  cursor: number;
  pages: SnapshotPageRow[];
  blocks: SnapshotBlockRow[];
  block_props: SnapshotBlockPropRow[];
  page_props: SnapshotPagePropRow[];
}

/**
 * B-613: the server answered and refused the token. Its own class so `SyncClient` can tell it from
 * a network failure — both used to become "offline", which promised the edit would go through
 * "when back online" when in fact nothing short of a new token ever would.
 */
export class SyncAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`sync request rejected the token: ${status}`);
    this.name = "SyncAuthError";
    this.status = status;
  }
}

export function isSyncAuthError(err: unknown): boolean {
  return (
    err instanceof SyncAuthError || (err as { name?: unknown } | null)?.name === "SyncAuthError"
  );
}

export interface SyncLiveHandlers {
  /** A `{type:'poke', seq}` frame arrived: something changed server-side, go pull. */
  onPoke(seq: number): void;
  /** The socket just (re)connected — pull once to cover whatever was missed while it was down. */
  onOpen(): void;
  /** The socket closed, or a (re)connect attempt failed — `code` is the WebSocket close code.
   * B-614: the only signal that the server went away while nobody is typing; before this the
   * transport swallowed it into a silent reconnect loop and the indicator said "Synced" for as long
   * as the server stayed down. `LIVE_AUTH_REJECTED_CODES` means the server refused the token. */
  onClose?(code: number): void;
}

/** Close codes meaning the server refused the token: 4403 when the hello's token does not verify,
 * 4401 when it was revoked while the socket was open (B-676 H3). `@nooklet/core`'s `LIVE_CLOSE`. */
export const LIVE_AUTH_REJECTED_CODES: ReadonlySet<number> = new Set([
  LIVE_CLOSE.revoked,
  LIVE_CLOSE.forbidden,
]);

/** Everything `SyncClient` needs from the network. `http-transport.ts` implements this for real
 * (fetch + WebSocket); tests implement a fake so sync logic runs with no network at all. */
export interface SyncTransport {
  push(body: PushRequestBody): Promise<PushResponse>;
  /** `deviceId` is required by the server: it advances that device's `acked_seq` (the op-GC
   * floor), and nothing else on a GET identifies the caller. */
  pull(deviceId: string, since: number, limit?: number): Promise<PullResponse>;
  snapshot(): Promise<SnapshotResponse>;
  /** `deviceId` is sent (with the bearer token) in the WS handshake's first message
   * (`{type:'hello', device_id, token}`, `packages/server/src/sync/live.ts`) — a browser cannot
   * set a bearer header on a WebSocket upgrade, so the server authenticates and identifies the
   * connecting device from that first frame instead of anything on the connect URL. Returns an
   * unsubscribe function. */
  connectLive(deviceId: string, handlers: SyncLiveHandlers): () => void;
}

/** `unauthorized` (B-613): the server answered, and refused this device's token (HTTP 401/403, or
 * the live socket closed with `LIVE_AUTH_REJECTED_CODES`). Distinct from `offline` because waiting
 * cannot fix it — the token was revoked or never valid, and only re-pairing can. */
export type SyncState =
  | "offline"
  | "idle"
  | "pushing"
  | "pulling"
  | "bootstrapping"
  | "error"
  | "unauthorized";

export interface SyncStatus {
  state: SyncState;
  pendingCount: number;
  serverCursor: number;
  lastError?: string;
  /** B-676 H4: why the live socket is being refused (over the server's connection cap), while
   * push and pull still work. Shown in the indicator's tooltip; cleared by the next poke, which
   * proves the socket was accepted. */
  liveNote?: string;
}
