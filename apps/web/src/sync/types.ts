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

export interface SyncLiveHandlers {
  /** A `{type:'poke', seq}` frame arrived: something changed server-side, go pull. */
  onPoke(seq: number): void;
  /** The socket just (re)connected — pull once to cover whatever was missed while it was down. */
  onOpen(): void;
}

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

export type SyncState = "offline" | "idle" | "pushing" | "pulling" | "bootstrapping" | "error";

export interface SyncStatus {
  state: SyncState;
  pendingCount: number;
  serverCursor: number;
  lastError?: string;
}
