/**
 * The client half of ADR 003's sync protocol (research/03-sync.md §6.5). Talks only to a
 * `SqlDriver` (assumed to already have `@nooklet/core`'s state schema plus this app's
 * `pending_op`/`sync_state` tables — see `../db/schema-client.ts`) and a `SyncTransport`
 * (`./types.ts`), so it is fully unit-testable with an in-memory driver and a fake transport
 * (`sync-client.test.ts`) — no network, no worker, no browser.
 *
 * Responsibilities:
 *  - `applyLocal(ops)`: apply ops to local state AND enqueue them in `pending_op`, in one
 *    transaction (ADR 003: "pending ops are written in the same transaction as the local state
 *    change"). This is the ONLY way editor/UI code should mutate the local replica.
 *  - `flush()`: drain `pending_op` to the server via `push`, in batches, removing rows the server
 *    has decided on (accepted or rejected — the server is the sole arbiter either way) and
 *    applying any corrective ops it returns.
 *  - `pull()`: page through `/sync/pull` from `sync_state.server_cursor`, applying via
 *    `@nooklet/core`'s `applyOps` (idempotent: an already-seen op id is a no-op there) and
 *    dropping any `pending_op` row that just arrived back from the server.
 *  - `bootstrap()`: for a fresh replica, load `/sync/snapshot` and insert its rows directly
 *    (they already carry final per-field HLCs, so this bypasses `applyOps`, not `pending_op`).
 *  - `connectLive()`: wire the transport's WebSocket poke to `pull()`, and reconnects to `pull()`
 *    too (research/03 §6.5: "pull on poke and on reconnect").
 *
 * Idempotent and resumable throughout, per ADR 003: every step can be safely retried or resumed
 * after a crash (`sync-client.test.ts`'s crash-safety test reopens the driver on the same on-disk
 * file to prove `pending_op` rows survive a real close/reopen, not just a fresh JS object).
 */

import {
  type ApplyOpsResult,
  applyOps as coreApplyOps,
  Hlc,
  newDeviceId,
  type Op,
  resolvePendingTextConflict,
  type SqlDriver,
} from "@nooklet/core";
import type { PushResponse, SyncStatus, SyncTransport } from "./types.js";

const PULL_LIMIT = 1000;
const PUSH_BATCH_LIMIT = 200;
export const PUSH_DEBOUNCE_MS = 300;

interface PendingOpRow {
  id: string;
  hlc: string;
  kind: string;
  entity: string;
  payload: string;
}

const SYNC_STATE_DEVICE_ID = "device_id";
const SYNC_STATE_HLC_LAST = "hlc_last";
const SYNC_STATE_SERVER_CURSOR = "server_cursor";
const SYNC_STATE_BOOTSTRAPPED = "bootstrapped";

export interface SyncClientOptions {
  driver: SqlDriver;
  transport: SyncTransport;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  onStatus?: (status: SyncStatus) => void;
  /** Called with every op just applied to local state — from `applyLocal`, from a push response's
   * `corrections`, and from `pull` — so a caller (`../db/worker-core.ts`) can compute which
   * tables/pages were touched and fire one `ChangeEvent` per batch, regardless of which of the
   * three sources caused it. */
  onAppliedOps?: (ops: readonly Op[]) => void;
  /** Called once a `bootstrap()` finishes: unlike the other three sources, a snapshot is inserted
   * as raw rows (see `bootstrap()`'s doc), not `Op`s, so there is nothing to pass `onAppliedOps`;
   * treat this as "everything may have changed". */
  onBootstrap?: () => void;
  /** Page size for `/sync/pull`; small values let tests exercise pagination cheaply. */
  pullLimit?: number;
  /** Rows drained from `pending_op` per `push` call; small values let tests exercise batching
   * cheaply. */
  pushBatchLimit?: number;
}

export class SyncClient {
  private readonly driver: SqlDriver;
  private readonly transport: SyncTransport;
  private readonly now: () => number;
  private readonly onStatusCb: ((status: SyncStatus) => void) | undefined;
  private readonly onAppliedOpsCb: ((ops: readonly Op[]) => void) | undefined;
  private readonly onBootstrapCb: (() => void) | undefined;
  private readonly pullLimit: number;
  private readonly pushBatchLimit: number;

  private hlc!: Hlc;
  private deviceId!: string;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private flushAgain = false;
  private pulling = false;
  private unsubscribeLive: (() => void) | undefined;
  private status: SyncStatus = { state: "offline", pendingCount: 0, serverCursor: 0 };

  constructor(opts: SyncClientOptions) {
    this.driver = opts.driver;
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
    this.onStatusCb = opts.onStatus;
    this.onAppliedOpsCb = opts.onAppliedOps;
    this.onBootstrapCb = opts.onBootstrap;
    this.pullLimit = opts.pullLimit ?? PULL_LIMIT;
    this.pushBatchLimit = opts.pushBatchLimit ?? PUSH_BATCH_LIMIT;
  }

  /** Load (or create) `device_id`/`hlc_last`/`server_cursor` from `sync_state`. Synchronous, no
   * network — safe to call every time the worker starts, even offline. Idempotent. */
  init(): void {
    let deviceId = this.getState(SYNC_STATE_DEVICE_ID);
    if (!deviceId) {
      deviceId = newDeviceId();
      this.setState(SYNC_STATE_DEVICE_ID, deviceId);
    }
    this.deviceId = deviceId;
    const lastHlc = this.getState(SYNC_STATE_HLC_LAST);
    this.hlc = new Hlc(deviceId, lastHlc, this.now);
    this.refreshPendingCount();
    this.setStatus({ serverCursor: Number(this.getState(SYNC_STATE_SERVER_CURSOR) ?? "0") });
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /** The HLC for a new local op. Editor/UI code builds ops with
   * `makeOp(syncClient.nextHlc(), syncClient.getDeviceId(), entity, payload)`. */
  nextHlc(): string {
    const next = this.hlc.next();
    // Persist on every mint. `init()` seeds from `hlc_last`, so without this a tab that minted
    // ops and reloaded before any push/pull would restart its clock from the wall clock and
    // could re-mint an HLC it had already used — and since an op's id IS its HLC, and applyOps
    // treats a known id as already-applied, that op would be silently dropped. One indexed row
    // update per op is cheap next to the write it accompanies.
    this.persistHlc();
    return next;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  isBootstrapped(): boolean {
    return this.getState(SYNC_STATE_BOOTSTRAPPED) === "1";
  }

  /**
   * Apply `ops` to local state and enqueue them for push, atomically (ADR 003). Returns the same
   * `ApplyOpsResult` `@nooklet/core`'s `applyOps` would — a locally-rejected op (e.g. a cycle) is
   * still queued and pushed: the server is the sole structural arbiter, and by the time it's
   * processed the state it was rejected against locally may no longer be the state that matters.
   */
  applyLocal(ops: readonly Op[]): ApplyOpsResult {
    if (ops.length === 0) return { results: [], applied: 0, noop: 0, rejected: 0 };
    const result = this.driver.transaction(() => {
      // Capture the pre-edit content of every block a `block.text` op is about to overwrite,
      // BEFORE applying — that content is the common ancestor a three-way merge needs if another
      // device turns out to have edited the same block concurrently (see `pull()`'s conflict
      // handling and `../db/schema-client.ts`'s note on `pending_op.base`). Read once per entity
      // so a batch touching one block repeatedly still records the original ancestor, not an
      // intermediate value.
      const bases = new Map<string, string | null>();
      for (const op of ops) {
        if (op.payload.kind !== "block.text" || bases.has(op.entity)) continue;
        const existing = this.driver.get<{ content: string }>(
          "SELECT content FROM block WHERE id = ?",
          [op.entity],
        );
        bases.set(op.entity, existing?.content ?? null);
      }

      const r = coreApplyOps(this.driver, ops);
      for (const op of ops) {
        this.driver.run(
          "INSERT OR IGNORE INTO pending_op(id, hlc, kind, entity, payload, base) VALUES (?, ?, ?, ?, ?, ?)",
          [
            op.id,
            op.hlc,
            op.payload.kind,
            op.entity,
            JSON.stringify(op.payload),
            op.payload.kind === "block.text" ? (bases.get(op.entity) ?? null) : null,
          ],
        );
      }
      return r;
    });
    this.refreshPendingCount();
    this.onAppliedOpsCb?.(ops);
    this.schedulePush();
    return result;
  }

  /** Debounce a `flush()` (research/03 §6.5: "Push runs on a 300ms debounce"). Call again on
   * `online`/`visibilitychange` with `delayMs: 0` for an immediate flush. */
  schedulePush(delayMs: number = PUSH_DEBOUNCE_MS): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.flush();
    }, delayMs);
  }

  /** Drain `pending_op` to the server. Coalesces overlapping calls into one more pass rather than
   * running concurrently (a `flush()` invoked while one is already in flight just sets a flag). */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      this.setStatus({ state: "pushing" });
      for (;;) {
        const rows = this.driver.all<PendingOpRow>(
          "SELECT * FROM pending_op ORDER BY hlc LIMIT ?",
          [this.pushBatchLimit],
        );
        if (rows.length === 0) break;
        const ops = rows.map((r) => this.rowToOp(r));
        let res: PushResponse;
        try {
          res = await this.transport.push({ device_id: this.deviceId, ops });
        } catch (err) {
          this.setStatus({ state: "offline", lastError: String(err) });
          return;
        }
        try {
          this.applyPushResponse(res);
        } catch (err) {
          // Most likely an HlcDriftError (ADR 003: "device clocks more than 60s ahead are
          // rejected with a visible error"). Surface it and stop; nothing was written for this
          // batch (see applyPushResponse's comment on ordering).
          this.setStatus({ state: "error", lastError: String(err) });
          return;
        }
        if (rows.length < this.pushBatchLimit) break;
      }
      this.setStatus({ state: "idle" });
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        void this.flush();
      }
    }
  }

  private applyPushResponse(res: PushResponse): void {
    // Absorb corrections' HLCs into our clock BEFORE writing anything (may throw
    // `HlcDriftError`, ADR 003) so a drifted server clock rejects the whole batch cleanly rather
    // than leaving state partially applied with a clock that never caught up to it.
    for (const c of res.corrections) this.hlc.receive(c.hlc);
    this.driver.transaction(() => {
      for (const a of res.accepted) this.driver.run("DELETE FROM pending_op WHERE id = ?", [a.id]);
      for (const r of res.rejected) this.driver.run("DELETE FROM pending_op WHERE id = ?", [r.id]);
      if (res.corrections.length > 0) coreApplyOps(this.driver, res.corrections);
    });
    this.persistHlc();
    this.refreshPendingCount();
    if (res.corrections.length > 0) this.onAppliedOpsCb?.(res.corrections);
  }

  /**
   * Page through `/sync/pull` from the stored cursor until caught up. Continues to the next page
   * whenever the response says `has_more: true`, regardless of how many ops that page carried —
   * NOT a `ops.length === pullLimit` heuristic, which is wrong on exactly one page's worth of
   * ops remaining (the server can return a full-limit page with `has_more: false`, its last page
   * landing on an exact multiple of `limit`). Driven off `has_more` this way, a device that is far
   * behind (fresh install, or offline for a week) drains every page in one `pull()` call instead
   * of crawling forward one page per poke.
   */
  async pull(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      this.setStatus({ state: "pulling" });
      for (;;) {
        const cursor = Number(this.getState(SYNC_STATE_SERVER_CURSOR) ?? "0");
        const res = await this.transport.pull(this.deviceId, cursor, this.pullLimit);
        if (res.ops.length > 0) {
          // Absorb every pulled op's HLC BEFORE writing state (may throw `HlcDriftError`, ADR
          // 003) so a drifted batch is rejected cleanly instead of applied with a clock that
          // can't represent it — see the identical ordering rationale in `applyPushResponse`.
          for (const op of res.ops) this.hlc.receive(op.hlc);
          const extraOps = this.resolveTextConflicts(res.ops);
          for (const op of extraOps) this.hlc.receive(op.hlc);
          this.driver.transaction(() => {
            // Merge ops go in the SAME batch as the pulled ops they resolve: they carry newer
            // HLCs, so applying them together means the merged text wins deterministically here
            // and, once pushed, on every other device too.
            coreApplyOps(this.driver, [...res.ops, ...extraOps]);
            for (const op of res.ops) {
              this.driver.run("DELETE FROM pending_op WHERE id = ?", [op.id]);
            }
            this.setState(SYNC_STATE_SERVER_CURSOR, String(res.cursor));
          });
          // A merge op is a local edit like any other: queue it so it reaches the server.
          if (extraOps.length > 0) this.enqueueForPush(extraOps);
          this.persistHlc();
          this.refreshPendingCount();
          this.onAppliedOpsCb?.(res.ops);
        } else {
          this.setState(SYNC_STATE_SERVER_CURSOR, String(res.cursor));
        }
        this.setStatus({ serverCursor: res.cursor });
        if (!res.has_more) break;
      }
      this.setStatus({ state: "idle" });
    } catch (err) {
      this.setStatus({ state: "offline", lastError: String(err) });
    } finally {
      this.pulling = false;
    }
  }

  /** Bootstrap a fresh replica from `/sync/snapshot` (first install, or the "full pull" escape
   * hatch after storage eviction). Inserts rows directly — they already carry final per-field
   * HLCs — rather than replaying them through `applyOps`. */
  async bootstrap(): Promise<void> {
    this.setStatus({ state: "bootstrapping" });
    const snap = await this.transport.snapshot();
    let maxHlc: string | undefined;
    const track = (hlc: string | null | undefined) => {
      if (hlc && (!maxHlc || hlc > maxHlc)) maxHlc = hlc;
    };
    this.driver.transaction(() => {
      for (const p of snap.pages) {
        this.driver.run(
          `INSERT OR REPLACE INTO page(id, name, key, journal_day, created_at, updated_at, deleted_at, name_hlc, deleted_hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id,
            p.name,
            p.key,
            p.journal_day,
            p.created_at,
            p.updated_at,
            p.deleted_at,
            p.name_hlc,
            p.deleted_hlc,
          ],
        );
        track(p.name_hlc);
        track(p.deleted_hlc);
      }
      for (const b of snap.blocks) {
        this.driver.run(
          `INSERT OR REPLACE INTO block(
             id, page_id, parent_id, order_key, content, marker, priority, collapsed,
             scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at,
             created_at, updated_at, deleted_at,
             place_hlc, content_hlc, marker_hlc, priority_hlc, collapsed_hlc,
             scheduled_hlc, deadline_hlc, repeat_hlc, done_hlc, deleted_hlc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            b.id,
            b.page_id,
            b.parent_id,
            b.order_key,
            b.content,
            b.marker,
            b.priority,
            b.collapsed,
            b.scheduled_day,
            b.scheduled_time,
            b.deadline_day,
            b.deadline_time,
            b.repeat,
            b.done_at,
            b.created_at,
            b.updated_at,
            b.deleted_at,
            b.place_hlc,
            b.content_hlc,
            b.marker_hlc,
            b.priority_hlc,
            b.collapsed_hlc,
            b.scheduled_hlc,
            b.deadline_hlc,
            b.repeat_hlc,
            b.done_hlc,
            b.deleted_hlc,
          ],
        );
        for (const h of [
          b.place_hlc,
          b.content_hlc,
          b.marker_hlc,
          b.priority_hlc,
          b.collapsed_hlc,
          b.scheduled_hlc,
          b.deadline_hlc,
          b.repeat_hlc,
          b.done_hlc,
          b.deleted_hlc,
        ]) {
          track(h);
        }
      }
      for (const bp of snap.block_props) {
        this.driver.run(
          "INSERT OR REPLACE INTO block_prop(block_id, key, value, hlc) VALUES (?, ?, ?, ?)",
          [bp.block_id, bp.key, bp.value, bp.hlc],
        );
        track(bp.hlc);
      }
      for (const pp of snap.page_props) {
        this.driver.run(
          "INSERT OR REPLACE INTO page_prop(page_id, key, value, hlc) VALUES (?, ?, ?, ?)",
          [pp.page_id, pp.key, pp.value, pp.hlc],
        );
        track(pp.hlc);
      }
      this.setState(SYNC_STATE_SERVER_CURSOR, String(snap.cursor));
      this.setState(SYNC_STATE_BOOTSTRAPPED, "1");
    });
    if (maxHlc) this.hlc.receive(maxHlc);
    this.persistHlc();
    this.setStatus({ state: "idle", serverCursor: snap.cursor });
    this.onBootstrapCb?.();
  }

  /** Wire the transport's WebSocket poke (and reconnects) to `pull()`. Call once at startup. */
  connectLive(): void {
    this.unsubscribeLive?.();
    this.unsubscribeLive = this.transport.connectLive(this.deviceId, {
      onPoke: () => void this.pull(),
      onOpen: () => {
        void this.pull();
        this.pushIfPending();
      },
    });
    this.pushIfPending();
  }

  /**
   * Push an outbox this client did not fill itself. Only `applyLocal` (and the online/visible/
   * resume lifecycle events) used to schedule a push, so ops that were durable in `pending_op` but
   * unpushed when the page reloaded — written less than the 300 ms push debounce before it, or
   * while the server was down — sat there until the next local write, which on a device you only
   * read on might be never (B-301). Called when live sync connects (startup, and every reconnect
   * after the server was unreachable) and once at startup even if the socket never opens.
   */
  private pushIfPending(): void {
    if (this.status.pendingCount > 0) this.schedulePush(0);
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.unsubscribeLive?.();
    this.unsubscribeLive = undefined;
  }

  private rowToOp(row: PendingOpRow): Op {
    return {
      id: row.id,
      hlc: row.hlc,
      device: this.deviceId,
      entity: row.entity,
      payload: JSON.parse(row.payload),
    };
  }

  /**
   * ADR 003's v1.1 upgrade, wired: when a pulled `block.text` op targets a block that still has
   * an unpushed local `block.text` of our own, plain last-writer-wins would silently discard one
   * person's edit. Instead we three-way merge against the pre-edit content captured in
   * `pending_op.base` (see `applyLocal`). A clean merge yields a fresh `block.text` op carrying
   * the combined text; a genuine overlapping edit falls back to LWW but preserves the losing
   * text as a `conflict_copy` property, so nothing is ever lost quietly. Either way the returned
   * ops carry newer HLCs than both sides, so every device converges on the same result.
   */
  private resolveTextConflicts(incoming: readonly Op[]): Op[] {
    const extra: Op[] = [];
    for (const op of incoming) {
      if (op.payload.kind !== "block.text") continue;
      const pending = this.driver.get<{ payload: string; hlc: string; base: string | null }>(
        "SELECT payload, hlc, base FROM pending_op WHERE entity = ? AND kind = 'block.text' ORDER BY hlc DESC LIMIT 1",
        [op.entity],
      );
      if (!pending || pending.base === null) continue;
      const minePayload = JSON.parse(pending.payload) as { kind: string; content?: string };
      if (typeof minePayload.content !== "string") continue;

      const outcome = resolvePendingTextConflict({
        entity: op.entity,
        device: this.deviceId,
        base: pending.base,
        mine: minePayload.content,
        mineHlc: pending.hlc,
        theirs: op.payload.content,
        theirsHlc: op.hlc,
        nextHlc: () => this.hlc.next(),
      });
      extra.push(...outcome.extraOps);
    }
    return extra;
  }

  /** Queue already-applied ops for push (used for merge ops, which are applied inline). */
  private enqueueForPush(ops: readonly Op[]): void {
    this.driver.transaction(() => {
      for (const op of ops) {
        this.driver.run(
          "INSERT OR IGNORE INTO pending_op(id, hlc, kind, entity, payload, base) VALUES (?, ?, ?, ?, ?, NULL)",
          [op.id, op.hlc, op.payload.kind, op.entity, JSON.stringify(op.payload)],
        );
      }
    });
    this.persistHlc();
    this.refreshPendingCount();
    this.schedulePush();
  }

  private getState(key: string): string | undefined {
    const row = this.driver.get<{ value: string }>("SELECT value FROM sync_state WHERE key = ?", [
      key,
    ]);
    return row?.value;
  }

  private setState(key: string, value: string): void {
    this.driver.run(
      `INSERT INTO sync_state(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  private persistHlc(): void {
    this.setState(SYNC_STATE_HLC_LAST, this.hlc.last);
  }

  private refreshPendingCount(): void {
    const row = this.driver.get<{ c: number }>("SELECT COUNT(*) AS c FROM pending_op");
    this.status.pendingCount = row?.c ?? 0;
    this.onStatusCb?.(this.status);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatusCb?.(this.status);
  }
}
