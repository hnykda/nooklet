import { z } from "zod";
import type { ServerBlockNode } from "../data-api.js";
import { boundsForPageEnd, newOrderKeys, resolveInsertionBounds, wouldCycle } from "../data-api.js";
import { getBlockRow, pageWireNameById } from "../rows.js";
import { runWithDryRun } from "./dry-run.js";
import { renderOutlineText } from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion, requirePage } from "./resolve.js";
import { BlockId, IdempotencyKey, IfVersion, PageRef, Position, WriteResult } from "./schemas.js";

/** Pre-`.refine()` plain object schema — see `blockUpdateInputShape`'s comment for why `batch.ts`
 * needs this rather than `blockMove.input` directly. */
export const blockMoveInputShape = z
  .object({
    id: BlockId,
    ref: BlockId.optional(),
    position: Position.optional(),
    page: PageRef.optional().describe(
      "Move to the top level (end) of this page instead of relative to ref",
    ),
    if_version: IfVersion,
    dry_run: z.boolean().default(false),
    idempotency_key: IdempotencyKey,
  })
  .strict();

export const blockMove = defineOp({
  name: "block.move",
  summary: "Move a block subtree",
  description:
    "Moves a block and its children relative to another block (ref + child_first/child_last/" +
    "before/after) or to the top level of a page (page instead of ref/position). Ids are " +
    "preserved, so existing ((block refs)) to it keep working. You cannot move a block under its " +
    "own descendant.",
  input: blockMoveInputShape.refine(
    (v) => (v.ref !== undefined && v.position !== undefined) !== (v.page !== undefined),
    {
      message: "give ref+position, or page, not both",
    },
  ),
  output: WriteResult,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => out.outline,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const row = getBlockRow(ctx.db, input.id);
      if (!row) throw new OpError("not_found", `no block with id ${input.id}`);
      checkIfVersion(row.updated_at, input.if_version);

      const bounds = input.page
        ? boundsForPageEnd(ctx.db, (await requirePage(ctx, input.page)).id, "end")
        : (() => {
            if (input.ref === input.id) {
              throw new OpError("invalid", "ref cannot be the block being moved");
            }
            // biome-ignore lint/style/noNonNullAssertion: schema refine guarantees ref+position together
            const b = resolveInsertionBounds(ctx.db, input.ref!, input.position!);
            // biome-ignore lint/style/noNonNullAssertion: schema refine guarantees ref present here
            if (!b) throw new OpError("not_found", `no block with id ${input.ref!}`);
            return b;
          })();

      if (bounds.parentId !== null && wouldCycle(ctx.db, input.id, bounds.parentId)) {
        throw new OpError(
          "invalid",
          "ref is the block itself or one of its descendants (would create a cycle)",
        );
      }

      // biome-ignore lint/style/noNonNullAssertion: newOrderKeys(bounds, 1) always returns one key
      const key = newOrderKeys(bounds, 1)[0]!;
      const applyResult = await ctx.applyOps([
        ctx.mintOp(input.id, {
          kind: "block.place",
          place: { pageId: bounds.pageId, parentId: bounds.parentId, order: key },
        }),
      ]);
      const rejected = applyResult.results.find(
        (r) => r.entity === input.id && r.status === "rejected",
      );
      if (rejected) throw new OpError("invalid", `move rejected: ${rejected.reason}`);

      const [subtree] = await ctx.data.blocks.tree(input.id);
      const outline = renderOutlineText(subtree ? [subtree as ServerBlockNode] : [], "all");
      return {
        page: pageWireNameById(ctx.db, bounds.pageId),
        created: [],
        updated: [input.id],
        deleted: [],
        outline,
        seq: applyResult.seq,
        dry_run: input.dry_run,
      };
    });
  },
});
