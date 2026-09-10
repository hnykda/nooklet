import { z } from "zod";
import { getBlockRow, type ServerBlockNode } from "../data-api.js";
import { runWithDryRun } from "./dry-run.js";
import { renderOutlineText } from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion } from "./resolve.js";
import { BlockId, IdempotencyKey, IfVersion, WriteResult } from "./schemas.js";

export const blockDelete = defineOp({
  name: "block.delete",
  summary: "Delete a block subtree (to trash)",
  description:
    "Moves a block and all its children to the trash (restorable for 30 days); ((block refs)) " +
    "elsewhere show as broken until restored. Returns the deleted outline so you can confirm what " +
    "was removed. Use dry_run: true first if you are not sure how large the subtree is - it " +
    "returns the same outline and counts without deleting anything.",
  input: z
    .object({
      id: BlockId,
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult.extend({
    deleted_count: z.number().int(),
    refs_broken: z.number().int().describe("Blocks elsewhere that referenced the deleted blocks"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => `deleted ${out.deleted_count} block(s)`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const row = getBlockRow(ctx.db, input.id);
      if (!row) throw new OpError("not_found", `no block with id ${input.id}`);
      checkIfVersion(row.updated_at, input.if_version);

      const [subtree] = await ctx.data.blocks.tree(input.id);
      const outline = renderOutlineText(subtree ? [subtree as ServerBlockNode] : [], "all");

      const ids: string[] = [];
      const stack = [input.id];
      while (stack.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: loop guarded by stack.length
        const cur = stack.pop()!;
        ids.push(cur);
        for (const child of ctx.db.all<{ id: string }>(
          "SELECT id FROM block WHERE parent_id = ? AND deleted_at IS NULL",
          [cur],
        )) {
          stack.push(child.id);
        }
      }
      const refsBroken =
        ctx.db.get<{ n: number }>(
          `SELECT count(DISTINCT src_block_id) AS n FROM ref
           WHERE dst_block_id IN (${ids.map(() => "?").join(",")})
             AND src_block_id NOT IN (${ids.map(() => "?").join(",")})`,
          [...ids, ...ids],
        )?.n ?? 0;

      const now = Date.now();
      const applyResult = await ctx.applyOps(
        ids.map((id) => ctx.mintOp(id, { kind: "block.delete", deletedAt: now })),
      );

      const pageRow = ctx.db.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [
        row.page_id,
      ]);
      return {
        page: pageRow?.name ?? row.page_id,
        created: [],
        updated: [],
        deleted: ids,
        outline,
        seq: applyResult.seq,
        dry_run: input.dry_run,
        deleted_count: ids.length,
        refs_broken: refsBroken,
      };
    });
  },
});
