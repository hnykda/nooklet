/**
 * Derives `ServerPluginContext.on("block.*" | "page.*" | "tx.committed", ...)` events
 * (`@nooklet/plugin-api`'s `ServerChangeEvents`) from the same "commit -> poke" seam
 * `../sync/realtime.ts` uses for the WebSocket poke (`onCommit`), plus the `changes` rows that
 * commit produced (`../apply-ops.ts`'s `recordChanges`) — exactly the mechanism the task
 * description names: "derive these from `onCommit` plus the `changes` rows that commit produced,
 * so handlers get the entity ids and `origin`".
 *
 * One `onCommit` listener is wired per `ServerContext` (`ensureWired`, guarded like
 * `wirePokeOnCommit`), fanning out to every plugin's `ctx.on(...)` subscription so N plugins cost
 * one shared listener + one `changes` scan per commit, not N.
 *
 * Event-kind derivation reads the `op` table's `kind` column for every op id the `changes` row
 * recorded (cheap: a handful of rows per commit) rather than diffing `before_json`/`after_json`,
 * since the op kind is the unambiguous source of truth for "was this a create, a move, a delete,
 * or an in-place edit" — a snapshot diff would have to guess when several kinds land in the same
 * batch. Priority when a batch touches one entity with several kinds: create > delete > move >
 * (text/prop) update, matching "the fact that fully explains the current state wins".
 */
import type { Block, BlockId, Op, PageId } from "@nooklet/core";
import { normalizePageName } from "@nooklet/core";
import type { Origin, ServerChangeEvents } from "@nooklet/plugin-api";
import type { ServerContext } from "../apply-ops.js";
import {
  type BlockChangeSnapshot,
  getBlockRowAny,
  type PageChangeSnapshot,
  type PageRow,
  rowToBlock,
  rowToPage,
} from "../rows.js";
import { onCommit } from "../sync/realtime.js";

type EventName = keyof ServerChangeEvents;
// Deliberately NOT generic (`<E extends EventName>(name: E, payload: ServerChangeEvents[E])`):
// every stored listener is called with whichever event actually fired, so its parameter types are
// the WIDE unions here — `./server-context.ts`'s `on<E>(...)` narrows back down to one `E` with an
// explicit cast after checking `name === event` at runtime (a plain `E`/`EventName` generic
// comparison doesn't type-narrow across two independently-inferred generic parameters).
export type ChangeListener = (name: EventName, payload: ServerChangeEvents[EventName]) => void;

interface ChangeState {
  listeners: Set<ChangeListener>;
  lastSeq: number;
}

const states = new WeakMap<ServerContext, ChangeState>();
const wired = new WeakSet<ServerContext>();

function stateFor(ctx: ServerContext): ChangeState {
  let s = states.get(ctx);
  if (!s) {
    // Start from the CURRENT head so a plugin loaded mid-session never replays history it missed.
    const head =
      ctx.driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0;
    s = { listeners: new Set(), lastSeq: head };
    states.set(ctx, s);
  }
  return s;
}

/** `ServerPluginContext.on(...)`'s real implementation. Returns an unsubscribe function; the host
 * wraps it in a `Disposable` (`./server-context.ts`). */
export function onChange(ctx: ServerContext, listener: ChangeListener): () => void {
  ensureWired(ctx);
  const s = stateFor(ctx);
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

function ensureWired(ctx: ServerContext): void {
  if (wired.has(ctx)) return;
  wired.add(ctx);
  stateFor(ctx); // records the starting seq before the first commit can arrive
  onCommit(ctx, ({ seq }) => dispatch(ctx, seq));
}

interface ChangeRow {
  seq: number;
  batch_id: string;
  origin: Origin["kind"];
  entity_type: string;
  entity_id: string;
  op_ids_json: string;
  before_json: string | null;
  after_json: string | null;
}

interface OpRow {
  id: string;
  hlc: string;
  device_id: string;
  kind: string;
  entity: string;
  payload_json: string;
}

function dispatch(ctx: ServerContext, headSeq: number): void {
  const s = stateFor(ctx);
  if (headSeq <= s.lastSeq) return;
  const fromSeq = s.lastSeq;
  s.lastSeq = headSeq;
  if (s.listeners.size === 0) return; // still advance lastSeq — no replay once a first listener joins

  const rows = ctx.driver.all<ChangeRow>(
    "SELECT seq, batch_id, origin, entity_type, entity_id, op_ids_json, before_json, after_json " +
      "FROM changes WHERE seq > ? AND seq <= ? ORDER BY seq",
    [fromSeq, headSeq],
  );
  if (rows.length === 0) return;

  const emit = <E extends EventName>(name: E, payload: ServerChangeEvents[E]): void => {
    for (const l of s.listeners) l(name, payload);
  };

  const batchesSeen = new Map<string, { origin: Origin["kind"]; opIds: Set<string> }>();

  for (const row of rows) {
    const opIds = JSON.parse(row.op_ids_json) as string[];
    const batch = batchesSeen.get(row.batch_id) ?? { origin: row.origin, opIds: new Set<string>() };
    for (const id of opIds) batch.opIds.add(id);
    batchesSeen.set(row.batch_id, batch);

    const origin: Origin = { kind: row.origin };
    const kinds = kindsOf(ctx, opIds);
    if (row.entity_type === "block") {
      emitBlockEvent(ctx, emit, row, origin, kinds);
    } else if (row.entity_type === "page") {
      emitPageEvent(ctx, emit, row, origin, kinds);
    }
    // Other entity_types (setting/keybinding/plugin/asset) have no ServerChangeEvents entry yet
    // (api-and-plugin-types.md only defines block.*/page.*/tx.committed) — nothing to emit.
  }

  for (const [batchId, { origin, opIds }] of batchesSeen) {
    const ops = opsFrom(ctx, [...opIds]);
    emit("tx.committed", { txId: batchId, origin: { kind: origin }, ops });
  }
}

function kindsOf(ctx: ServerContext, opIds: string[]): Set<string> {
  if (opIds.length === 0) return new Set();
  const rows = ctx.driver.all<{ kind: string }>(
    `SELECT kind FROM op WHERE id IN (${opIds.map(() => "?").join(",")})`,
    opIds,
  );
  return new Set(rows.map((r) => r.kind));
}

function opsFrom(ctx: ServerContext, opIds: string[]): Op[] {
  if (opIds.length === 0) return [];
  const rows = ctx.driver.all<OpRow>(
    `SELECT id, hlc, device_id, kind, entity, payload_json FROM op WHERE id IN (${opIds.map(() => "?").join(",")})`,
    opIds,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the order the changes rows recorded them in, not SQL's arbitrary IN(...) order.
  return opIds
    .map((id) => byId.get(id))
    .filter((r): r is OpRow => r !== undefined)
    .map((r) => ({
      id: r.id,
      hlc: r.hlc,
      device: r.device_id,
      entity: r.entity,
      payload: JSON.parse(r.payload_json),
    }));
}

/** A "before" snapshot (`../rows.ts`'s `BlockChangeSnapshot`/`PageChangeSnapshot`, as stored in
 * `changes.before_json`) reconstructed into a full `Block`/`Page` for event payloads. `createdAt`
 * is immutable so the live row's value is always correct even for a snapshot taken moments ago;
 * `updatedAt` for a "before" snapshot is approximated from the previous `changes` row for this
 * entity (its `created_at`) since snapshots don't carry their own timestamp — good enough for
 * plugins, which look at content/property/place diffs, not timestamps. */
type BlockSnapshotJson = BlockChangeSnapshot;
type PageSnapshotJson = PageChangeSnapshot;

function previousChangeTimestamp(
  ctx: ServerContext,
  entityType: string,
  entityId: string,
  beforeSeq: number,
): number | undefined {
  const row = ctx.driver.get<{ created_at: number }>(
    "SELECT created_at FROM changes WHERE entity_type = ? AND entity_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
    [entityType, entityId, beforeSeq],
  );
  return row?.created_at;
}

/** Builds a `Block` directly from the snapshot (never via `rowToBlock`/`block_prop`, which would
 * read the CURRENT, post-write properties — a "before" object must not leak those). */
function blockFromSnapshot(
  id: BlockId,
  snap: BlockSnapshotJson,
  createdAt: number,
  updatedAt: number,
): Block {
  return {
    id,
    pageId: snap.place.pageId,
    parentId: snap.place.parentId,
    order: snap.place.order,
    content: snap.content,
    marker: snap.marker as Block["marker"],
    priority: snap.priority as Block["priority"],
    properties: snap.properties,
    collapsed: snap.collapsed,
    createdAt,
    updatedAt,
  };
}

function emitBlockEvent(
  ctx: ServerContext,
  emit: <E extends EventName>(name: E, payload: ServerChangeEvents[E]) => void,
  row: ChangeRow,
  origin: Origin,
  kinds: Set<string>,
): void {
  const current = getBlockRowAny(ctx.driver, row.entity_id);
  if (!current) return; // should not happen: recordChanges only writes rows for entities it snapshotted
  const block = rowToBlock(ctx.driver, current);
  const before = row.before_json ? (JSON.parse(row.before_json) as BlockSnapshotJson) : null;

  if (kinds.has("block.create") || before === null) {
    emit("block.created", { block, origin, txId: row.batch_id });
    return;
  }
  if (kinds.has("block.delete")) {
    emit("block.deleted", { block, origin, txId: row.batch_id });
    return;
  }
  if (kinds.has("block.place")) {
    emit("block.moved", {
      block,
      before: {
        pageId: before.place.pageId,
        parentId: before.place.parentId,
        order: before.place.order,
      },
      origin,
      txId: row.batch_id,
    });
    return;
  }
  const beforeUpdatedAt =
    previousChangeTimestamp(ctx, "block", row.entity_id, row.seq) ?? block.createdAt;
  emit("block.updated", {
    block,
    before: blockFromSnapshot(row.entity_id, before, block.createdAt, beforeUpdatedAt),
    origin,
    txId: row.batch_id,
  });
}

function emitPageEvent(
  ctx: ServerContext,
  emit: <E extends EventName>(name: E, payload: ServerChangeEvents[E]) => void,
  row: ChangeRow,
  origin: Origin,
  kinds: Set<string>,
): void {
  const currentRow = ctx.driver.get<PageRow>("SELECT * FROM page WHERE id = ?", [row.entity_id]);
  if (!currentRow) return;
  const page = rowToPage(ctx.driver, currentRow);
  const before = row.before_json ? (JSON.parse(row.before_json) as PageSnapshotJson) : null;

  if (kinds.has("page.create") || before === null) {
    emit("page.created", { page, origin, txId: row.batch_id });
    return;
  }
  if (kinds.has("page.delete")) {
    emit("page.deleted", { page, origin, txId: row.batch_id });
    return;
  }
  const beforePage = (
    id: PageId,
    snap: PageSnapshotJson,
    createdAt: number,
    updatedAt: number,
  ) => ({
    id,
    name: snap.name,
    key: normalizePageName(snap.name),
    journalDay: snap.journal_day,
    properties: snap.properties,
    createdAt,
    updatedAt,
  });
  const beforeUpdatedAt =
    previousChangeTimestamp(ctx, "page", row.entity_id, row.seq) ?? page.createdAt;
  if (kinds.has("page.rename")) {
    emit("page.renamed", {
      page,
      before: beforePage(row.entity_id, before, page.createdAt, beforeUpdatedAt),
      origin,
      txId: row.batch_id,
    });
    return;
  }
  emit("page.updated", {
    page,
    before: beforePage(row.entity_id, before, page.createdAt, beforeUpdatedAt),
    origin,
    txId: row.batch_id,
  });
}
