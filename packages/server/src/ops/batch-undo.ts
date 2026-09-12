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
}

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
    "undo, call batch_undo again with THIS call's seq/batch (there is no separate redo concept). " +
    "It does NOT check whether the entity changed again after the original batch - it applies the " +
    "restore unconditionally, and since every field is last-writer-wins by a fresh timestamp, the " +
    "undo always wins over anything in between. Cannot undo asset_upload (assets are not in the " +
    "op log); such a batch_id fails with an invalid error. Use dry_run to preview what would be " +
    "restored/deleted without writing anything.",
  input: z
    .object({
      batch_id: BatchId,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult.extend({
    undo_batch_id: z
      .string()
      .describe(
        "The id of this undo itself, as a fresh batch_id; pass it to batch_undo again to undo the undo",
      ),
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
        "SELECT seq, entity_type, entity_id, before_json FROM changes WHERE batch_id = ? ORDER BY seq ASC",
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
      // first (lowest-seq) changes row within this batch_id, not any later one.
      const firstByEntity = new Map<string, ChangeRow>();
      for (const row of rows) {
        if (!firstByEntity.has(row.entity_id)) firstByEntity.set(row.entity_id, row);
      }

      const ops: Op[] = [];
      const restored: string[] = [];
      const removed: string[] = [];
      const touchedPages = new Set<string>();
      const summaryLines: string[] = [];
      const now = Date.now();

      for (const row of firstByEntity.values()) {
        if (row.entity_type === "page") {
          const pageId = row.entity_id;
          const current = snapshotPage(ctx.db, pageId);
          if (!current) continue; // pages are never hard-deleted; defensive only
          touchedPages.add(wirePageNameOf(current));
          if (row.before_json === null) {
            ops.push(ctx.mintOp(pageId, { kind: "page.delete", deletedAt: now }));
            removed.push(pageId);
            summaryLines.push(`deleted page "${current.name}" (created by the undone batch)`);
            continue;
          }
          const before = JSON.parse(row.before_json) as PageChangeSnapshot;
          ops.push(ctx.mintOp(pageId, { kind: "page.rename", name: before.name }));
          const keys = new Set([
            ...Object.keys(current.properties),
            ...Object.keys(before.properties),
          ]);
          for (const k of keys) {
            ops.push(
              ctx.mintOp(pageId, {
                kind: "page.prop",
                key: k,
                value: before.properties[k] ?? null,
              }),
            );
          }
          ops.push(ctx.mintOp(pageId, { kind: "page.delete", deletedAt: before.deleted_at }));
          restored.push(pageId);
          summaryLines.push(`restored page "${before.name}"`);
        } else {
          const blockId = row.entity_id;
          const current = snapshotBlock(ctx.db, blockId);
          if (!current) continue; // blocks are never hard-deleted; defensive only
          touchedPages.add(pageWireNameById(ctx.db, current.place.pageId));
          if (row.before_json === null) {
            ops.push(ctx.mintOp(blockId, { kind: "block.delete", deletedAt: now }));
            removed.push(blockId);
            summaryLines.push(`deleted block ^${blockId} (created by the undone batch)`);
            continue;
          }
          const before = JSON.parse(row.before_json) as BlockChangeSnapshot;
          touchedPages.add(pageWireNameById(ctx.db, before.place.pageId));
          ops.push(ctx.mintOp(blockId, { kind: "block.place", place: before.place }));
          ops.push(ctx.mintOp(blockId, { kind: "block.text", content: before.content }));
          ops.push(
            ctx.mintOp(blockId, { kind: "block.prop", key: "marker", value: before.marker }),
          );
          ops.push(
            ctx.mintOp(blockId, { kind: "block.prop", key: "priority", value: before.priority }),
          );
          ops.push(
            ctx.mintOp(blockId, {
              kind: "block.prop",
              key: "collapsed",
              value: before.collapsed ? "true" : "false",
            }),
          );
          const keys = new Set([
            ...Object.keys(current.properties),
            ...Object.keys(before.properties),
          ]);
          for (const k of keys) {
            ops.push(
              ctx.mintOp(blockId, {
                kind: "block.prop",
                key: k,
                value: before.properties[k] ?? null,
              }),
            );
          }
          ops.push(ctx.mintOp(blockId, { kind: "block.delete", deletedAt: before.deleted_at }));
          restored.push(blockId);
          summaryLines.push(`restored block ^${blockId}: "${before.content.slice(0, 60)}"`);
        }
      }

      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      return {
        page: summarizePages(touchedPages),
        created: [],
        updated: restored,
        deleted: removed,
        outline: summaryLines.join("\n"),
        seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
        dry_run: input.dry_run,
        undo_batch_id: applyResult?.batchId ?? input.batch_id,
      };
    });
  },
});
