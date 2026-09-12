/**
 * `page.history` (M7 item 8, ADR 019): a page's timeline, read straight from the `changes` audit
 * rows (sql-schema.md rule 21) that every write already records with a full before/after image per
 * entity (ADR 013). Rows are grouped by `batch_id` — one batch is one write call, sync push, or
 * undo — newest first, and each batch says what happened in words ("3 blocks edited, 1 deleted")
 * plus the per-entity images a client needs to show a diff.
 *
 * "Restore this version" is deliberately NOT an op here. The op log supports it as "undo every
 * batch newer than the chosen one, newest first" — each step is a `batch.undo`, already a
 * complete, audited write — and composing those on the server would only mean re-implementing or
 * re-exporting `batch.undo`'s compensation logic for an operation that is not atomic across pages
 * either way (a batch that also touched another page reverts there too). The client walks the
 * `batch_id`s this op returns and calls `batch.undo` for each; ADR 019 records the trade-off.
 *
 * Which rows are "this page's": the page entity itself, and every block entity whose CURRENT
 * `page_id` is this page. A block moved here from elsewhere brings its earlier history along; one
 * moved away takes it with it. That is the same choice `changes.since`'s `page` filter makes.
 */

import type { SqlDriver } from "@nooklet/core";
import { z } from "zod";
import { pageWireNameById } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { resolvePageRef } from "./resolve.js";
import { OriginEnum, PageRef, Properties } from "./schemas.js";
import { findTrashedPageByName } from "./trash-restore.js";

/** One side of an entity's image: the fields a viewer needs, a subset of `rows.ts`'s
 * `PageChangeSnapshot`/`BlockChangeSnapshot`. Blocks carry content/marker/place; pages carry
 * name. Both carry properties and the tombstone. */
const Snapshot = z.object({
  content: z.string().optional(),
  marker: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  collapsed: z.boolean().optional(),
  parent_id: z.string().nullable().optional(),
  page_id: z.string().optional(),
  name: z.string().optional(),
  properties: Properties.optional(),
  deleted_at: z.number().nullable(),
});
type SnapshotT = z.infer<typeof Snapshot>;

const EntryKind = z.enum([
  "created",
  "edited",
  "moved",
  "deleted",
  "restored",
  "renamed",
  "updated",
]);
type EntryKindT = z.infer<typeof EntryKind>;

const Entry = z.object({
  entity_type: z.enum(["page", "block"]),
  entity_id: z.string(),
  kind: EntryKind,
  before: Snapshot.nullable().describe("null = did not exist before this batch"),
  after: Snapshot.nullable(),
});
type EntryT = z.infer<typeof Entry>;

const Batch = z.object({
  batch_id: z.string().describe("Pass to batch_undo to reverse just this batch"),
  seq: z.number().int().describe("Highest changes seq in the batch; the timeline's order key"),
  at: z.string().describe("ISO-8601"),
  origin: OriginEnum,
  actor: z.string(),
  summary: z.string().describe('In words, e.g. "3 blocks edited, 1 deleted"'),
  entries: z.array(Entry),
});

interface BatchRow {
  batch_id: string;
  top: number;
  at: number;
  origin: string;
  actor: string;
}

interface ChangeRow {
  seq: number;
  entity_type: "page" | "block";
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
}

interface RawBlockSnap {
  place: { pageId: string; parentId: string | null; order: string };
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: boolean;
  properties: Record<string, string>;
  deleted_at: number | null;
}

interface RawPageSnap {
  name: string;
  journal_day: number | null;
  properties: Record<string, string>;
  deleted_at: number | null;
}

function toSnapshot(entityType: "page" | "block", json: string | null): SnapshotT | null {
  if (json === null) return null;
  const raw = JSON.parse(json) as RawBlockSnap | RawPageSnap;
  if (entityType === "page") {
    const p = raw as RawPageSnap;
    return { name: p.name, properties: p.properties, deleted_at: p.deleted_at };
  }
  const b = raw as RawBlockSnap;
  return {
    content: b.content,
    marker: b.marker,
    priority: b.priority,
    collapsed: b.collapsed,
    parent_id: b.place.parentId,
    page_id: b.place.pageId,
    properties: b.properties,
    deleted_at: b.deleted_at,
  };
}

/** Same-state check on the viewer-facing image, so an op that changed nothing (LWW-stale, or a
 * re-send of identical text) does not show up as a change. */
function sameImage(a: SnapshotT | null, b: SnapshotT | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classify(
  entityType: "page" | "block",
  before: SnapshotT | null,
  after: SnapshotT | null,
): EntryKindT {
  if (before === null) return "created";
  if (after === null) return "deleted"; // cannot happen (rows are never hard-deleted); defensive
  if (before.deleted_at === null && after.deleted_at !== null) return "deleted";
  if (before.deleted_at !== null && after.deleted_at === null) return "restored";
  if (entityType === "page") return before.name !== after.name ? "renamed" : "updated";
  if (before.content !== after.content) return "edited";
  if (before.parent_id !== after.parent_id || before.page_id !== after.page_id) return "moved";
  return "updated";
}

const BLOCK_WORDS: Record<EntryKindT, string> = {
  created: "added",
  edited: "edited",
  moved: "moved",
  deleted: "deleted",
  restored: "restored",
  renamed: "renamed",
  updated: "updated",
};

const PAGE_WORDS: Record<EntryKindT, string> = {
  ...BLOCK_WORDS,
  created: "created",
  updated: "properties updated",
};

/** "page renamed; 3 blocks edited, 1 deleted" — page verbs first, then block counts in the order
 * a reader expects (additions, edits, moves, deletions, restores, other). */
export function summarize(entries: readonly EntryT[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.entity_type === "page") parts.push(`page ${PAGE_WORDS[e.kind]}`);
  }
  const counts = new Map<EntryKindT, number>();
  for (const e of entries) {
    if (e.entity_type !== "block") continue;
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }
  const order: EntryKindT[] = ["created", "edited", "moved", "deleted", "restored", "updated"];
  const blockParts: string[] = [];
  for (const kind of order) {
    const n = counts.get(kind);
    if (!n) continue;
    const noun = blockParts.length === 0 ? ` block${n === 1 ? "" : "s"}` : "";
    blockParts.push(`${n}${noun} ${BLOCK_WORDS[kind]}`);
  }
  if (blockParts.length > 0) parts.push(blockParts.join(", "));
  return parts.join("; ") || "no visible change";
}

function pageFilterSql(): string {
  return "((entity_type = 'page' AND entity_id = ?) OR (entity_type = 'block' AND entity_id IN (SELECT id FROM block WHERE page_id = ?)))";
}

function entriesForBatch(driver: SqlDriver, batchId: string, pageId: string): EntryT[] {
  const rows = driver.all<ChangeRow>(
    `SELECT seq, entity_type, entity_id, before_json, after_json FROM changes
     WHERE batch_id = ? AND ${pageFilterSql()} ORDER BY seq ASC`,
    [batchId, pageId, pageId],
  );
  // One entity can have several rows in one batch (a `batch` op with two steps on one block):
  // its image for the batch is first-row-before -> last-row-after.
  const byEntity = new Map<
    string,
    { entity_type: "page" | "block"; first: ChangeRow; last: ChangeRow }
  >();
  for (const r of rows) {
    const cur = byEntity.get(r.entity_id);
    if (cur) cur.last = r;
    else byEntity.set(r.entity_id, { entity_type: r.entity_type, first: r, last: r });
  }
  const entries: EntryT[] = [];
  for (const [entityId, { entity_type, first, last }] of byEntity) {
    const before = toSnapshot(entity_type, first.before_json);
    const after = toSnapshot(entity_type, last.after_json);
    if (sameImage(before, after)) continue;
    entries.push({
      entity_type,
      entity_id: entityId,
      kind: classify(entity_type, before, after),
      before,
      after,
    });
  }
  return entries;
}

export const pageHistory = defineOp({
  name: "page.history",
  summary: "A page's change history, batch by batch, newest first",
  description:
    "Returns a page's history from the audit log: every write that touched the page or a block " +
    "on it, grouped by batch_id (one batch = one write call, sync push, or undo), newest first. " +
    "Each batch says what happened in words (summary) and lists each touched entity with its " +
    "before and after image (content, marker, properties, tombstone), so you can show or " +
    "compute a diff. To reverse one batch call batch_undo with its batch_id. To restore the " +
    "page as it was right after some batch, call batch_undo on every NEWER batch in this list, " +
    "newest first - there is no single restore call, and a batch that also touched other pages " +
    "reverts there too. Works for a deleted page as well (its deletion is the newest batch). " +
    "Blocks are attributed to the page they are on now. Paginate with cursor.",
  input: z
    .object({
      page: PageRef,
      cursor: z.string().max(32).optional().describe("From a previous call; batches older than it"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max batches to return (default 20, max 100)"),
    })
    .strict(),
  output: z.object({
    page: z.string(),
    page_id: z.string(),
    batches: z.array(Batch),
    cursor: z.string().optional().describe("Present when there are older batches"),
    has_more: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    out.batches.length === 0
      ? `no history for ${out.page}`
      : out.batches
          .map((b) => `${b.at} ${b.actor} (${b.origin}) [${b.batch_id}]: ${b.summary}`)
          .join("\n") + (out.has_more ? "\n…older" : ""),
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const live = await resolvePageRef(ctx, input.page);
    const pageId = live?.id ?? findTrashedPageByName(driver, input.page)?.id;
    if (!pageId) throw new OpError("not_found", `no page named "${input.page}"`);

    let cursorSeq: number | undefined;
    if (input.cursor !== undefined) {
      cursorSeq = Number(input.cursor);
      if (!Number.isInteger(cursorSeq) || cursorSeq < 0) {
        throw new OpError("invalid", "cursor is not a page_history cursor");
      }
    }
    const batches = driver.all<BatchRow>(
      `SELECT batch_id, MAX(seq) AS top, MIN(created_at) AS at, origin, actor
       FROM changes
       WHERE ${pageFilterSql()}
       GROUP BY batch_id
       ${cursorSeq !== undefined ? "HAVING MAX(seq) < ?" : ""}
       ORDER BY top DESC LIMIT ?`,
      [pageId, pageId, ...(cursorSeq !== undefined ? [cursorSeq] : []), input.limit + 1],
    );
    const hasMore = batches.length > input.limit;
    const page = batches.slice(0, input.limit);
    const out: z.infer<typeof Batch>[] = [];
    for (const b of page) {
      const entries = entriesForBatch(driver, b.batch_id, pageId);
      // A batch whose every op was LWW-stale or re-sent identical text changed nothing visible;
      // listing it would be noise. (So a page can come back shorter than `limit` with `has_more`
      // still true — the cursor, not the count, says whether there is more.)
      if (entries.length === 0) continue;
      out.push({
        batch_id: b.batch_id,
        seq: b.top,
        at: new Date(b.at).toISOString(),
        origin: b.origin as z.infer<typeof OriginEnum>,
        actor: b.actor,
        summary: summarize(entries),
        entries,
      });
    }
    const last = page[page.length - 1];
    return {
      page: pageWireNameById(driver, pageId),
      page_id: pageId,
      batches: out,
      cursor: hasMore && last ? String(last.top) : undefined,
      has_more: hasMore,
    };
  },
});
