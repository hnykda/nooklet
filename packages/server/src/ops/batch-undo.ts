/**
 * `batch.undo` (ADR 013): reverses every entity a previous `changes.batch_id` touched, by reading
 * the full pre-image `apply-ops.ts`'s `recordChanges` now stores in `changes.before_json` and
 * replaying it back through `ctx.applyOps` as ordinary compensating ops — never raw SQL, so the
 * undo itself is a normal, fully-audited write.
 *
 * Design decisions (documented per the task, not just implemented):
 *  - **LWW, not refuse-on-conflict.** If an entity was edited again after the batch being undone,
 *    this op does NOT check for that and refuse; it applies the compensating ops anyway. Every op
 *    is per-field LWW by HLC (ADR 003) and `ctx.mintOp` always stamps a fresh, later HLC, so an
 *    undo always wins over whatever happened in between. This matches how every other write in
 *    this API behaves (no implicit "has anything changed" gate outside `if_version`) and keeps
 *    undo simple and predictable: "restore this batch's before-state, now" rather than "restore it
 *    only if nothing else touched it since." The tool description below tells an agent this
 *    explicitly so it is not a surprise.
 *  - **`keep_later_edits` opts out of that, per field (B-251).** A person restoring an old version
 *    from History is not undoing their own last write: the walk undoes a graph-wide replace to get
 *    one page back, and LWW overwrote every later edit to every block the replace had touched, on
 *    every page. With the flag, a field another batch changed afterwards is left as it is and
 *    reported in `kept`; `ignore_batches` names the walk's own batches so its earlier steps do not
 *    count as someone's later edit (`./later-edits.ts`). Off by default, so the agent contract
 *    above is unchanged.
 *  - **Undo of an undo, not redo.** The compensating ops are applied under a brand-new `batch_id`
 *    (via `ctx.applyOps` with no `meta.batchId`), which itself gets its own `before_json`/
 *    `after_json` rows. Calling `batch.undo` again on THAT id reverses the reversal — there is no
 *    separate redo concept to implement.
 *  - **Assets are out of scope.** `asset.upload` never produces an `op` row (ADR 003: "assets are
 *    not in the op log") and its `changes` row's `before_json`/`after_json` are file metadata, not
 *    a page/block state that any `applyOps` op could restore. A batch touching a non-page/block
 *    entity type is rejected with `invalid` rather than silently skipped, so an agent is not misled
 *    into thinking an asset upload was undone.
 */

import type { Op } from "@nooklet/core";
import { z } from "zod";
import {
  type BlockChangeSnapshot,
  type PageChangeSnapshot,
  pageWireNameById,
  snapshotBlock,
  snapshotPage,
  wirePageNameOf,
} from "../rows.js";
import { runWithDryRun } from "./dry-run.js";
import { changedFields, fieldsChangedLater, type UndoField } from "./later-edits.js";
import { defineOp, OpError } from "./registry.js";
import { currentHeadSeq } from "./resolve.js";
import { IdempotencyKey, WriteResult } from "./schemas.js";

const BatchId = z
  .string()
  .min(1)
  .max(64)
  .describe("A batch_id from a previous write's response or a changes_since item's batch_id field");

interface ChangeRow {
  seq: number;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
}

const KeptEntity = z.object({
  entity_type: z.enum(["page", "block"]),
  id: z.string(),
  page: z.string().describe("The page the entity is on now (for a page, its own name)"),
  fields: z
    .array(z.string())
    .describe(
      "What was left as it is: place, content, marker, priority, collapsed, name, deleted, or prop:<key>",
    ),
});

function summarizePages(touched: ReadonlySet<string>): string {
  if (touched.size === 0) return "";
  if (touched.size === 1) return [...touched][0] as string;
  return [...touched].sort().join(", ");
}

export const batchUndo = defineOp({
  name: "batch.undo",
  summary: "Undo every page/block change from a previous batch_id",
  description:
    "Reverses every page/block change recorded under batch_id (a value returned by any write, or " +
    "by changes_since's items[].batch_id), restoring each entity to its state immediately before " +
    "that batch, or deleting it (soft-delete, restorable) if the batch created it. Works from the " +
    "before/after snapshot every write already records for audit purposes - it never re-parses " +
    "Markdown or guesses. This call is itself a brand-new, separately-audited batch: to undo the " +
    "undo, call batch_undo again with THIS call's batch_id (there is no separate redo concept). " +
    "By default it does NOT check whether the entity changed again after the original batch - it " +
    "applies the restore unconditionally, and since every field is last-writer-wins by a fresh " +
    "timestamp, the undo always wins over anything in between. Pass keep_later_edits: true to " +
    "leave alone every field some other batch changed after this one (listed in kept) - use it " +
    "when undoing anything but your own latest write. Cannot undo asset_upload (assets are not in " +
    "the op log); such a batch_id fails with an invalid error. Use dry_run to preview what would " +
    "be restored/deleted without writing anything.",
  input: z
    .object({
      batch_id: BatchId,
      keep_later_edits: z
        .boolean()
        .default(false)
        .describe(
          "Leave as it is any field (text, marker, place, a property, the tombstone) that another " +
            "batch changed after this one, instead of overwriting it; a block or page this batch " +
            "created is not deleted if another batch changed it since. What was left is in kept",
        ),
      ignore_batches: z
        .array(BatchId)
        .max(10_000)
        .default([])
        .describe(
          "With keep_later_edits: changes made by these batches do not count as later edits. When " +
            "undoing several batches in a row (restoring a page to an older version), pass all of " +
            "them plus the batch_id of each undo already done",
        ),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  // `batch_id` in the result is this undo's OWN batch, like every other write's — pass it back to
  // batch_undo to undo the undo.
  output: WriteResult.extend({
    kept: z
      .array(KeptEntity)
      .default([])
      .describe("With keep_later_edits: entities (or some of their fields) left as they are"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => out.outline || "(nothing to undo)",
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const rows = ctx.db.all<ChangeRow>(
        "SELECT seq, entity_type, entity_id, before_json, after_json FROM changes WHERE batch_id = ? ORDER BY seq ASC",
        [input.batch_id],
      );
      if (rows.length === 0) {
        throw new OpError(
          "not_found",
          `no batch with id "${input.batch_id}"`,
          "batch_id comes from a previous write's response or changes_since's items[].batch_id",
        );
      }
      const unsupported = rows.find((r) => r.entity_type !== "page" && r.entity_type !== "block");
      if (unsupported) {
        throw new OpError(
          "invalid",
          `batch "${input.batch_id}" touched a "${unsupported.entity_type}" entity, which batch_undo does not support`,
          "only page/block changes recorded via the op log can be undone; asset uploads are not reversible this way",
        );
      }

      // A batch can touch the same entity more than once (e.g. a `batch` op with two block.update
      // steps on the same block); the entity's ORIGINAL pre-batch state is the before_json of its
      // first (lowest-seq) changes row within this batch_id, not any later one — and what the
      // batch left behind is the after_json of its last.
      const firstByEntity = new Map<string, ChangeRow>();
      const lastByEntity = new Map<string, ChangeRow>();
      for (const row of rows) {
        if (!firstByEntity.has(row.entity_id)) firstByEntity.set(row.entity_id, row);
        lastByEntity.set(row.entity_id, row);
      }

      const ignored = new Set([input.batch_id, ...input.ignore_batches]);
      /** Fields of this entity another batch changed since, which a keep_later_edits undo must not
       * write back. Empty (write everything, LWW) without the flag. */
      const laterEdits = (row: ChangeRow): Set<UndoField> =>
        input.keep_later_edits
          ? fieldsChangedLater(
              ctx.db,
              row.entity_type as "page" | "block",
              row.entity_id,
              row.seq,
              ignored,
            )
          : new Set();
      /** Of the fields left alone, the ones this batch itself changed: those are the undo the
       * caller asked for and did not get. A field the batch never touched but someone changed
       * later is skipped silently — writing it back was never part of reversing this batch. */
      const keptOf = (row: ChangeRow, skipped: Set<UndoField>): UndoField[] => {
        const last = lastByEntity.get(row.entity_id) ?? row;
        const own = changedFields(
          row.entity_type as "page" | "block",
          row.before_json === null ? null : JSON.parse(row.before_json),
          last.after_json === null ? null : JSON.parse(last.after_json),
        );
        return [...skipped].filter((f) => own.has(f)).sort();
      };

      const ops: Op[] = [];
      const restored: string[] = [];
      const removed: string[] = [];
      const kept: z.infer<typeof KeptEntity>[] = [];
      const touchedPages = new Set<string>();
      const summaryLines: string[] = [];
      const now = Date.now();

      for (const row of firstByEntity.values()) {
        const skip = laterEdits(row);
        if (row.entity_type === "page") {
          const pageId = row.entity_id;
          const current = snapshotPage(ctx.db, pageId);
          if (!current) continue; // pages are never hard-deleted; defensive only
          const pageName = wirePageNameOf(current);
          touchedPages.add(pageName);
          if (row.before_json === null) {
            if (skip.size > 0) {
              kept.push({ entity_type: "page", id: pageId, page: pageName, fields: ["deleted"] });
              summaryLines.push(`kept page "${current.name}": changed again since it was created`);
              continue;
            }
            ops.push(ctx.mintOp(pageId, { kind: "page.delete", deletedAt: now }));
            removed.push(pageId);
            summaryLines.push(`deleted page "${current.name}" (created by the undone batch)`);
            continue;
          }
          const before = JSON.parse(row.before_json) as PageChangeSnapshot;
          const pageOps: Op[] = [];
          if (!skip.has("name")) {
            pageOps.push(ctx.mintOp(pageId, { kind: "page.rename", name: before.name }));
          }
          const keys = new Set([
            ...Object.keys(current.properties),
            ...Object.keys(before.properties),
          ]);
          for (const k of keys) {
            if (skip.has(`prop:${k}`)) continue;
            pageOps.push(
              ctx.mintOp(pageId, {
                kind: "page.prop",
                key: k,
                value: before.properties[k] ?? null,
              }),
            );
          }
          if (!skip.has("deleted")) {
            pageOps.push(ctx.mintOp(pageId, { kind: "page.delete", deletedAt: before.deleted_at }));
          }
          const keptFields = keptOf(row, skip);
          if (keptFields.length > 0) {
            kept.push({ entity_type: "page", id: pageId, page: pageName, fields: keptFields });
            summaryLines.push(
              `kept page "${current.name}" ${keptFields.join(", ")}: changed again later`,
            );
          }
          if (pageOps.length > 0) {
            ops.push(...pageOps);
            restored.push(pageId);
            summaryLines.push(`restored page "${before.name}"`);
          }
        } else {
          const blockId = row.entity_id;
          const current = snapshotBlock(ctx.db, blockId);
          if (!current) continue; // blocks are never hard-deleted; defensive only
          const pageName = pageWireNameById(ctx.db, current.place.pageId);
          touchedPages.add(pageName);
          if (row.before_json === null) {
            if (skip.size > 0) {
              kept.push({ entity_type: "block", id: blockId, page: pageName, fields: ["deleted"] });
              summaryLines.push(`kept block ^${blockId}: changed again since it was created`);
              continue;
            }
            ops.push(ctx.mintOp(blockId, { kind: "block.delete", deletedAt: now }));
            removed.push(blockId);
            summaryLines.push(`deleted block ^${blockId} (created by the undone batch)`);
            continue;
          }
          const before = JSON.parse(row.before_json) as BlockChangeSnapshot;
          if (!skip.has("place")) touchedPages.add(pageWireNameById(ctx.db, before.place.pageId));
          const blockOps: Op[] = [];
          if (!skip.has("place")) {
            blockOps.push(ctx.mintOp(blockId, { kind: "block.place", place: before.place }));
          }
          if (!skip.has("content")) {
            blockOps.push(ctx.mintOp(blockId, { kind: "block.text", content: before.content }));
          }
          if (!skip.has("marker")) {
            blockOps.push(
              ctx.mintOp(blockId, { kind: "block.prop", key: "marker", value: before.marker }),
            );
          }
          if (!skip.has("priority")) {
            blockOps.push(
              ctx.mintOp(blockId, { kind: "block.prop", key: "priority", value: before.priority }),
            );
          }
          if (!skip.has("collapsed")) {
            blockOps.push(
              ctx.mintOp(blockId, {
                kind: "block.prop",
                key: "collapsed",
                value: before.collapsed ? "true" : "false",
              }),
            );
          }
          const keys = new Set([
            ...Object.keys(current.properties),
            ...Object.keys(before.properties),
          ]);
          for (const k of keys) {
            if (skip.has(`prop:${k}`)) continue;
            blockOps.push(
              ctx.mintOp(blockId, {
                kind: "block.prop",
                key: k,
                value: before.properties[k] ?? null,
              }),
            );
          }
          if (!skip.has("deleted")) {
            blockOps.push(
              ctx.mintOp(blockId, { kind: "block.delete", deletedAt: before.deleted_at }),
            );
          }
          const keptFields = keptOf(row, skip);
          if (keptFields.length > 0) {
            kept.push({ entity_type: "block", id: blockId, page: pageName, fields: keptFields });
            summaryLines.push(
              `kept block ^${blockId} ${keptFields.join(", ")}: changed again later`,
            );
          }
          if (blockOps.length > 0) {
            ops.push(...blockOps);
            restored.push(blockId);
            summaryLines.push(`restored block ^${blockId}: "${before.content.slice(0, 60)}"`);
          }
        }
      }

      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      return {
        page: summarizePages(touchedPages),
        created: [],
        updated: restored,
        deleted: removed,
        kept,
        outline: summaryLines.join("\n"),
        seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
        batch_id: input.dry_run ? undefined : applyResult?.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
