import { z } from "zod";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion, requirePage, wirePageName } from "./resolve.js";
import { IdempotencyKey, IfVersion, PageRef } from "./schemas.js";

export const pageDelete = defineOp({
  name: "page.delete",
  summary: "Delete a page (to trash)",
  description:
    "Moves an entire page and its blocks to the trash (restorable for 30 days). Links to it " +
    "become unresolved until restored. Prefer editing or renaming a page over deleting it; use " +
    "this only when the user has explicitly asked to delete the page - most hosts will prompt for " +
    "confirmation before running it.",
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
      const backlinksAffected =
        ctx.db.get<{ n: number }>(
          "SELECT count(*) AS n FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL WHERE pr.page_key = ? AND b.page_id != ?",
          [page.key, page.id],
        )?.n ?? 0;
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
        dry_run: input.dry_run,
      };
    });
  },
});
