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
  makeOp,
  merge3,
  newDeviceId,
  type Op,
  resolvePendingTextConflict,
  type SqlDriver,
} from "@nooklet/core";
import { LIVE_REFUSED_CODES, liveRefusedNote } from "./live-backoff.js";
import {
  type CapturedPage,
  captureAndRemoveRefusedPage,
  insertPageSnapshot,
  pagesDisplacedByPull,
  reapplyCapturedPage,
} from "./refused-page.js";
import {
  isSyncAuthError,
  LIVE_AUTH_REJECTED_CODES,
  type PushResponse,
  type SyncState,
  type SyncStatus,
  type SyncTransport,
} from "./types.js";

const PULL_LIMIT = 1000;
const PUSH_BATCH_LIMIT = 200;
export const PUSH_DEBOUNCE_MS = 300;

/**
 * B-614: how long the live socket may stay down before this client checks whether the server is
 * reachable at all (one `pull()`, whose failure is what reports `offline`). A server restart, or a
 * proxy recycling the connection, is back within about this long; probing at once would make every
 * such blip read as an outage. The indicator adds its own `ATTENTION_DELAY_MS` on top before the
 * dot changes (`shell/sync-indicator-state.ts`), so a blip shorter than both never shows at all.
 */
export const LIVE_DOWN_GRACE_MS = 1500;

interface PendingOpRow {
  id: string;
  hlc: string;
  kind: string;
  entity: string;
  payload: string;
}

/**
 * Which ancestor to three-way merge `theirs` into `mine` against. `base` — the text before this
 * device started diverging — is right whenever the other device's edit started from there too,
 * and it is what is used unless it fails to merge.
 *
 * It fails when `theirs` was written on top of a text this device has already merged, and that
 * text and `mine` changed the same words. Two shapes, each with a candidate ancestor:
 *
 *  - `previous`: the author's own text just before `theirs` — it edited the same words twice.
 *    `theirs` certainly descends from it.
 *  - `others`: a text `theirs` merged in — a third device's, or an older one of ours — whose
 *    words its author has since changed again (a merge op carrying a stale word). `theirs`
 *    descends from it only if it contains it, so that is checked (merging it into `theirs`
 *    against `base` changes nothing). Without the check, a third device's NEWER text looked like
 *    an ancestor, and the merge silently reverted that device's word
 *    (`tools/probes/b652-merge-base.ts`).
 *
 * Either way a candidate is used only when `mine` really contains everything its author has
 * written (`latest`, merged into `mine` against `base`, changes nothing). Otherwise `mine` would
 * look like it had reverted the candidate, and that "revert" would be merged in silently. If no
 * candidate merges, `base` stays and the caller reports a conflict: a spurious conflict copy can
 * be deleted, a silently dropped edit cannot be found.
 */
function mergeBase(
  base: string,
  mine: string,
  theirs: string,
  previous: string | undefined,
  others: ReadonlyArray<{ text: string; latest: string }>,
): string {
  if (merge3(base, mine, theirs).ok) return base;
  const contains = (outer: string, inner: string) => {
    const r = merge3(base, outer, inner);
    return r.ok && r.merged === outer;
  };
  const candidates = [
    ...(previous === undefined ? [] : [{ text: previous, latest: previous }]),
    ...others.filter((o) => contains(theirs, o.text)),
  ];
  for (const { text, latest } of candidates) {
    if (text === base || !contains(mine, latest)) continue;
    if (merge3(text, mine, theirs).ok) return text;
  }
  return base;
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
   * treat this as "everything may have changed". Also called after a refused page was dropped
   * from the replica (`./refused-page.ts`), for the same reason. */
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
  private liveDownTimer: ReturnType<typeof setTimeout> | undefined;
  /** B-613: the server refused this device's token. Sticky until a request succeeds again: a
   * network failure on top of it must not turn "re-pair this device" back into "wait, it will
   * sync when back online", which is the false promise this state exists to stop making. */
  private authRejected = false;
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
      this.setStatus({ state: this.busyState("pushing") });
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
          this.setStatus({ state: this.failureState(err), lastError: String(err) });
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
      this.authRejected = false;
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
    const refused = res.refused_pages ?? [];
    for (const r of refused) this.hlc.receive(r.page.name_hlc);
    const captured: Array<{ page: CapturedPage; winnerId: string }> = [];
    this.driver.transaction(() => {
      // Before the outbox rows go: the refused page's content is read from the replica, and its
      // pending ops are superseded by what `reapplyCapturedPage` re-sends (`./refused-page.ts`).
      for (const r of refused) {
        const page = captureAndRemoveRefusedPage(this.driver, r.refused_id);
        insertPageSnapshot(this.driver, r);
        if (page) captured.push({ page, winnerId: r.page.id });
      }
      // B-652: an accepted `block.text` moves to `sent_text` instead of vanishing. Conflict
      // detection in `pull()` needs this device's own text and its base while the other device's
      // edit is still on its way here, and this response can be applied before the pull response
      // that carries that edit (worker-core runs push and pull at once on reconnect; and two
      // online devices can each push before pulling). Not when a pull already passed the op: it
      // came back and was dropped there, which is the "seen" this table waits for.
      const cursor = Number(this.getState(SYNC_STATE_SERVER_CURSOR) ?? "0");
      for (const a of res.accepted) {
        if (a.seq > cursor) {
          this.driver.run(
            `INSERT OR IGNORE INTO sent_text(id, hlc, entity, content, base, seq)
             SELECT id, hlc, entity, json_extract(payload, '$.content'), base, ?
             FROM pending_op WHERE id = ? AND kind = 'block.text' AND base IS NOT NULL`,
            [a.seq, a.id],
          );
        }
        this.driver.run("DELETE FROM pending_op WHERE id = ?", [a.id]);
      }
      for (const r of res.rejected) this.driver.run("DELETE FROM pending_op WHERE id = ?", [r.id]);
      // The server's own order (ADR 026), like a pull: corrections are logged in the order the
      // server applied them.
      if (res.corrections.length > 0) coreApplyOps(this.driver, res.corrections, { order: "seq" });
    });
    this.persistHlc();
    this.refreshPendingCount();
    if (res.corrections.length > 0) this.onAppliedOpsCb?.(res.corrections);
    this.reapplyCaptured(captured);
  }

  /** Re-send refused pages' content onto the pages that won their names, as fresh local ops. */
  private reapplyCaptured(captured: ReadonlyArray<{ page: CapturedPage; winnerId: string }>): void {
    if (captured.length === 0) return;
    const ops = captured.flatMap(({ page, winnerId }) =>
      reapplyCapturedPage(page, winnerId, (entity, payload) =>
        makeOp(this.nextHlc(), this.deviceId, entity, payload),
      ),
    );
    if (ops.length > 0) this.applyLocal(ops);
    // Pages and blocks were removed outside any op: every view may be showing one of them.
    this.onBootstrapCb?.();
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
      this.setStatus({ state: this.busyState("pulling") });
      for (;;) {
        const cursor = Number(this.getState(SYNC_STATE_SERVER_CURSOR) ?? "0");
        const res = await this.transport.pull(this.deviceId, cursor, this.pullLimit);
        if (res.ops.length > 0) {
          // Absorb every pulled op's HLC BEFORE writing state (may throw `HlcDriftError`, ADR
          // 003) so a drifted batch is rejected cleanly instead of applied with a clock that
          // can't represent it — see the identical ordering rationale in `applyPushResponse`.
          for (const op of res.ops) this.hlc.receive(op.hlc);
          const resolved = this.resolveTextConflicts(res.ops);
          const extraOps = resolved.map((r) => r.op);
          for (const op of extraOps) this.hlc.receive(op.hlc);
          const captured: Array<{ page: CapturedPage; winnerId: string }> = [];
          this.driver.transaction(() => {
            // A local page holding a name the server's page arrives under: move out of its way
            // first, or the server's page is refused here and the replicas never converge
            // (`./refused-page.ts`). Its content is re-sent onto that page below.
            for (const d of pagesDisplacedByPull(this.driver, res.ops)) {
              const page = captureAndRemoveRefusedPage(this.driver, d.refusedId);
              if (page) captured.push({ page, winnerId: d.winnerId });
            }
            // Merge ops go in the SAME batch as the pulled ops they resolve: they carry newer
            // HLCs, so applying them together means the merged text wins deterministically here
            // and, once pushed, on every other device too.
            //
            // In the server's `seq` order, not re-sorted by HLC (ADR 026, B-587): a page.create
            // minted before its device heard of the delete that freed its name has the smaller
            // HLC, and HLC order applied it while the old page still held the name — refused here,
            // accepted on the server, so this replica lost the page and everything on it. The
            // merge ops are newest and go last either way.
            coreApplyOps(this.driver, [...res.ops, ...extraOps], { order: "seq" });
            for (const op of res.ops) {
              this.driver.run("DELETE FROM pending_op WHERE id = ?", [op.id]);
              this.driver.run("DELETE FROM sent_text WHERE id = ?", [op.id]);
            }
            this.forgetSentTextUpTo(res.cursor);
            this.setState(SYNC_STATE_SERVER_CURSOR, String(res.cursor));
          });
          // A merge op is a local edit like any other: queue it so it reaches the server.
          if (resolved.length > 0) this.enqueueForPush(resolved);
          this.persistHlc();
          this.refreshPendingCount();
          this.onAppliedOpsCb?.(res.ops);
          this.reapplyCaptured(captured);
        } else {
          this.forgetSentTextUpTo(res.cursor);
          this.setState(SYNC_STATE_SERVER_CURSOR, String(res.cursor));
        }
        this.setStatus({ serverCursor: res.cursor });
        if (!res.has_more) break;
      }
      this.authRejected = false;
      this.setStatus({ state: "idle" });
    } catch (err) {
      this.setStatus({ state: this.failureState(err), lastError: String(err) });
    } finally {
      this.pulling = false;
    }
  }

  /** Bootstrap a fresh replica from `/sync/snapshot` (first install, or the "full pull" escape
   * hatch after storage eviction). Inserts rows directly — they already carry final per-field
   * HLCs — rather than replaying them through `applyOps`. */
  async bootstrap(): Promise<void> {
    this.setStatus({ state: "bootstrapping" });
    let snap: Awaited<ReturnType<SyncTransport["snapshot"]>>;
    try {
      snap = await this.transport.snapshot();
    } catch (err) {
      // Still thrown — `worker-core.ts#start` tolerates it and carries on with an empty replica —
      // but no longer left at "bootstrapping", which the indicator shows as a sync that is about
      // to start rather than one that cannot (B-613).
      this.setStatus({ state: this.failureState(err), lastError: String(err) });
      throw err;
    }
    let maxHlc: string | undefined;
    const track = (hlc: string | null | undefined) => {
      if (hlc && (!maxHlc || hlc > maxHlc)) maxHlc = hlc;
    };
    this.driver.transaction(() => {
      // B-660: check foreign keys at COMMIT, not per row. The snapshot lists blocks in the
      // server's rowid (creation) order, so a block moved under one created after it arrives
      // before its parent; checked per row, that insert failed and rolled back the whole
      // bootstrap. The app then fell back to pulling the op log from 0, which silently drops
      // whatever `nooklet gc` has trimmed from it. Sorting the snapshot here would also work, but
      // deferring holds for any order and still refuses a snapshot that is inconsistent as a
      // whole. SQLite resets this pragma itself when the transaction ends.
      this.driver.exec("PRAGMA defer_foreign_keys = ON");
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
      this.forgetSentTextUpTo(snap.cursor);
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
      onPoke: () => {
        // A poke means the server accepted this socket after all.
        if (this.status.liveNote) this.setStatus({ liveNote: undefined });
        void this.pull();
      },
      onOpen: () => {
        this.clearLiveDownTimer();
        void this.pull();
        this.pushIfPending();
      },
      onClose: (code) => this.onLiveClosed(code),
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

  /**
   * B-614: the live socket closed, or a reconnect attempt failed. A socket the server refused is
   * the token being rejected (B-613), reported at once. Anything else may be a blip, so wait
   * `LIVE_DOWN_GRACE_MS` and then ask the server directly with a `pull()`: its failure is what
   * says `offline`, its success means only the live channel is down (a proxy without WebSocket
   * support) and the data really is in sync. Each later failed reconnect probes again, so this is
   * also what notices the server coming back when the socket alone cannot.
   */
  private onLiveClosed(code: number): void {
    if (LIVE_AUTH_REJECTED_CODES.has(code)) {
      this.clearLiveDownTimer();
      this.authRejected = true;
      this.setStatus({ state: "unauthorized", lastError: `live sync refused the token (${code})` });
      return;
    }
    // B-676 H4: refused for capacity (or a frame too big). Push and pull still work, so the state
    // stays whatever the probe below finds; the note says why other devices' changes now arrive
    // only when the (long, backed-off) reconnect attempt pulls.
    // Any other close (the server went away) makes the note stale.
    const liveNote = LIVE_REFUSED_CODES.has(code) ? liveRefusedNote(code) : undefined;
    if (liveNote !== this.status.liveNote) this.setStatus({ liveNote });
    if (this.authRejected || this.liveDownTimer) return;
    this.liveDownTimer = setTimeout(() => {
      this.liveDownTimer = undefined;
      void this.pull();
    }, LIVE_DOWN_GRACE_MS);
  }

  private clearLiveDownTimer(): void {
    if (this.liveDownTimer) clearTimeout(this.liveDownTimer);
    this.liveDownTimer = undefined;
  }

  /** What a request that failed with `err` leaves the client in (B-613). */
  private failureState(err: unknown): SyncState {
    if (isSyncAuthError(err)) this.authRejected = true;
    return this.authRejected ? "unauthorized" : "offline";
  }

  /** "pushing"/"pulling", unless the token is known to be refused: a retry that is all but certain
   * to be refused again should not flicker the indicator through "N changes waiting to sync". */
  private busyState(state: "pushing" | "pulling"): SyncState {
    return this.authRejected ? "unauthorized" : state;
  }

  dispose(): void {
    this.clearLiveDownTimer();
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
   * ADR 003's v1.1 upgrade, wired: when a pulled `block.text` op targets a block this device also
   * edited without having seen that op, plain last-writer-wins would silently discard one
   * person's edit. Instead we three-way merge against the pre-edit content captured in `base`
   * (see `applyLocal`). A clean merge yields a fresh `block.text` op carrying the combined text; a
   * genuine overlapping edit falls back to LWW but preserves the losing text as a `conflict_copy`
   * property, so nothing is ever lost quietly — a report the server turns into a block after the
   * winner, clearing the property (ADR 027). Either way the returned ops carry newer HLCs than
   * both sides, so every device converges on the same result.
   *
   * "Edited without having seen it" is this device's `block.text` ops that have not yet come
   * back in a pull: unpushed (`pending_op`) or pushed and acknowledged but not yet pulled back
   * (`sent_text`, B-652). `incoming` is in the server's `seq` order, so an op of ours appearing in
   * it marks everything after it as written by a device that may have seen ours; from there on
   * that op, and every older op of ours (pushed in HLC order, so earlier in the log — including a
   * noop the pull never returns, whose text our own later op replaced), no longer counts.
   */
  private resolveTextConflicts(incoming: readonly Op[]): Array<{ op: Op; base: string }> {
    const extra: Array<{ op: Op; base: string }> = [];
    let seenOwnUpTo = "";
    // Per block, what earlier ops in this batch already settled:
    //  - `mine`: a clean merge is this device's text from then on, so a third device's edit
    //    later in the batch merges into it — not into the text before it, which would drop the
    //    second device's change once the newer merge wins. It stays this device's unseen text
    //    even after our own op shows up later in the batch: the merge is minted here, so nobody
    //    else has seen it yet.
    //  - `base`: the ancestor that merge was made against, for the same reason.
    //  - `seen`: every device's texts met so far, oldest first, starting from this replica's op
    //    log (our own edits, earlier pulls) — `mergeBase`'s candidates.
    const settled = new Map<
      string,
      {
        base: string;
        mine?: { content: string; hlc: string };
        seen: Array<{ device: string; text: string }>;
      }
    >();
    for (const op of incoming) {
      if (op.device === this.deviceId) {
        if (op.hlc > seenOwnUpTo) seenOwnUpTo = op.hlc;
        continue;
      }
      if (op.payload.kind !== "block.text") continue;
      let here = settled.get(op.entity);
      const unseen = this.unseenOwnText(op.entity, seenOwnUpTo);
      const base = unseen?.base ?? here?.base;
      const current = here?.mine ?? unseen;
      if (base === undefined || !current) continue;
      if (!here) {
        here = { base, seen: this.recentTexts(op.entity) };
        settled.set(op.entity, here);
      }
      const seen = here.seen;
      // Everything this device has written is `current`, which contains itself — so an older
      // text of ours that `theirs` merged in is a candidate whenever `theirs` contains it.
      const latestOf = (device: string) =>
        device === this.deviceId
          ? current.content
          : seen.findLast((x) => x.device === device)?.text;
      const previous = latestOf(op.device);
      const others = seen
        .filter((x) => x.device !== op.device)
        .reverse()
        .map((x) => ({ text: x.text, latest: latestOf(x.device) ?? x.text }));
      seen.push({ device: op.device, text: op.payload.content });

      const outcome = resolvePendingTextConflict({
        entity: op.entity,
        device: this.deviceId,
        base: mergeBase(base, current.content, op.payload.content, previous, others),
        mine: current.content,
        mineHlc: current.hlc,
        theirs: op.payload.content,
        theirsHlc: op.hlc,
        nextHlc: () => this.hlc.next(),
      });
      for (const extraOp of outcome.extraOps) extra.push({ op: extraOp, base });
      const [merged] = outcome.extraOps;
      if (outcome.kind === "merged" && merged?.payload.kind === "block.text") {
        here.mine = { content: merged.payload.content, hlc: merged.hlc };
      }
    }
    return extra;
  }

  /** Recent `block.text`s on `entity` from this replica's op log — ours and pulled ones — oldest
   * first: the texts a newly pulled edit may have been written on top of (`mergeBase`). Bounded:
   * only the ones near the divergence matter, and `mergeBase` tries each. */
  private recentTexts(entity: string): Array<{ device: string; text: string }> {
    return this.driver
      .all<{ device: string; text: string | null }>(
        `SELECT device_id AS device, json_extract(payload_json, '$.content') AS text FROM op
         WHERE entity = ? AND kind = 'block.text'
         ORDER BY seq DESC LIMIT 20`,
        [entity],
      )
      .filter((r): r is { device: string; text: string } => typeof r.text === "string")
      .reverse();
  }

  /**
   * This device's text for `entity` that the server's log, as pulled so far, has not shown back
   * to it: the newest such edit's content and HLC, and the base of the OLDEST one — the text
   * before this device started diverging, which is what the other device edited too. (The newest
   * row's own base is an earlier local edit the other device never saw; merging against it would
   * quietly undo that earlier edit wherever the other device touched nearby.) `undefined` when
   * there is none, or no base to merge against (the block did not exist here yet).
   */
  private unseenOwnText(
    entity: string,
    seenOwnUpTo: string,
  ): { content: string; hlc: string; base: string } | undefined {
    const rows = this.driver
      .all<{ id: string; hlc: string; content: string | null; base: string | null }>(
        `SELECT id, hlc, json_extract(payload, '$.content') AS content, base
           FROM pending_op WHERE entity = ? AND kind = 'block.text'
         UNION ALL
         SELECT id, hlc, content, base FROM sent_text WHERE entity = ?
         ORDER BY hlc`,
        [entity, entity],
      )
      .filter((r) => r.hlc > seenOwnUpTo);
    const base = rows.find((r) => r.base !== null)?.base;
    const newest = rows.at(-1);
    if (base == null || !newest || typeof newest.content !== "string") return undefined;
    return { content: newest.content, hlc: newest.hlc, base };
  }

  /** `sent_text` rows the server's log has now been read past: the op came back, or was a noop
   * the pull never carries (its text lives on in this device's later op or merge, or in a
   * conflict copy). */
  private forgetSentTextUpTo(cursor: number): void {
    this.driver.run("DELETE FROM sent_text WHERE seq <= ?", [cursor]);
  }

  /** Queue already-applied ops for push (used for merge ops, which are applied inline). A merge
   * op keeps the base its merge used (B-652): it is this device's newest text for the block, and
   * an edit from a third device that arrives later must merge into it against that same base.
   * Stored as NULL it made the block look like it had no base, and that edit then won by plain
   * LWW over the merge, dropping whatever the merge had folded in. */
  private enqueueForPush(ops: ReadonlyArray<{ op: Op; base: string | null }>): void {
    this.driver.transaction(() => {
      for (const { op, base } of ops) {
        this.driver.run(
          "INSERT OR IGNORE INTO pending_op(id, hlc, kind, entity, payload, base) VALUES (?, ?, ?, ?, ?, ?)",
          [
            op.id,
            op.hlc,
            op.payload.kind,
            op.entity,
            JSON.stringify(op.payload),
            op.payload.kind === "block.text" ? base : null,
          ],
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
