import { z } from "zod";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { backlinkCount, checkIfVersion, requirePage, wirePageName } from "./resolve.js";
import { BatchIdOut, IdempotencyKey, IfVersion, PageRef } from "./schemas.js";

export const pageDelete = defineOp({
  name: "page.delete",
  summary: "Delete a page (undoable)",
  description:
    "Soft-deletes an entire page and its blocks: they stop appearing anywhere, links to the page " +
    "become unresolved, and batch_undo with this call's batch_id brings all of it back. Prefer " +
    "editing or renaming a page over deleting it; use this only when the user has explicitly " +
    "asked to delete the page - most hosts will prompt for confirmation before running it.",
  input: z
    .object({
      page: PageRef,
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    page: z.string(),
    deleted_blocks: z.number().int(),
    backlinks_affected: z.number().int(),
    seq: z.number().int(),
    batch_id: BatchIdOut,
    dry_run: z.boolean(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  expose: { mcp: { requiresUserInteraction: true } },
  render: (out) =>
    `deleted ${out.page} (${out.deleted_blocks} blocks, ${out.backlinks_affected} backlinks affected)`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const page = await requirePage(ctx, input.page);
      if (page.journalDay !== null) {
        throw new OpError(
          "invalid",
          "journal pages are cleared automatically when emptied, not deleted through this op",
        );
      }
      checkIfVersion(page.updatedAt, input.if_version);
      const blockIds = ctx.db
        .all<{ id: string }>("SELECT id FROM block WHERE page_id = ? AND deleted_at IS NULL", [
          page.id,
        ])
        .map((r) => r.id);
      const backlinksAffected = backlinkCount(ctx.db, page);
      const now = Date.now();
      const ops = [
        ctx.mintOp(page.id, { kind: "page.delete", deletedAt: now }),
        ...blockIds.map((id) => ctx.mintOp(id, { kind: "block.delete", deletedAt: now })),
      ];
      const applyResult = await ctx.applyOps(ops);
      return {
        page: wirePageName(page),
        deleted_blocks: blockIds.length,
        backlinks_affected: backlinksAffected,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
