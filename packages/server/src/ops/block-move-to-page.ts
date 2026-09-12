/**
 * `block.move_to_page` (M7, research/13 §4.2 item 3): a whole subtree to the top level of another
 * page, at its end or start, creating the page when it does not exist yet. `block.move`'s `page`
 * form is the same move without the create and without a choice of end — and, as of B-85, without
 * the subtree: every cross-page move here goes through `subtreePlaceOps`, so the children come
 * along.
 */

import { isoJournalName, newId, type Op, type Page, parseJournalTitle } from "@nooklet/core";
import { z } from "zod";
import type { ServerBlockNode } from "../data-api.js";
import {
  boundsForPageEnd,
  journalDayFromWire,
  newOrderKeys,
  subtreeBlockIds,
  subtreePlaceOps,
} from "../data-api.js";
import { getBlockRow, pageWireNameById } from "../rows.js";
import { runWithDryRun } from "./dry-run.js";
import { renderOutlineText } from "./outline-bridge.js";
import { defineOp, type OpContext, OpError } from "./registry.js";
import { checkIfVersion, resolvePageRef } from "./resolve.js";
import { BlockId, IdempotencyKey, IfVersion, PageRef, WriteResult } from "./schemas.js";

export interface PageTarget {
  /** The page as it exists, or as it will exist once `createOp` is applied. */
  page: Pick<Page, "id" | "name" | "journalDay">;
  /** Present when the page did not exist: apply it in the SAME batch as whatever needs the page,
   * so one `batch_undo` removes both and a failure leaves no empty page behind. */
  createOp?: Op;
}

/**
 * Resolve a `PageRef` to a live page, or mint the `page.create` op that would make one — a date
 * (any recognised title format) becomes a journal day stored under its ISO name (ADR 018), any
 * other name an ordinary page. Never applies anything: `ctx.data.pages.create` would run its own
 * `serverApplyOps` with its own batch id, and a page created that way could not be undone with
 * the move that needed it.
 */
export async function resolveOrMintPage(
  ctx: OpContext,
  ref: string,
  create: boolean,
): Promise<PageTarget> {
  const existing = await resolvePageRef(ctx, ref);
  if (existing) return { page: existing };
  if (!create) {
    throw new OpError(
      "not_found",
      `no page named "${ref}"`,
      "pass create_page: true to create it, or name an existing page",
    );
  }
  const name = ref.trim().replace(/\s+/g, " ");
  const day = journalDayFromWire(name) ?? parseJournalTitle(name);
  const id = newId();
  const createOp = ctx.mintOp(id, {
    kind: "page.create",
    name: day === null ? name : isoJournalName(day),
    journalDay: day,
    createdAt: Date.now(),
  });
  return { page: { id, name: day === null ? name : isoJournalName(day), journalDay: day }, createOp };
}

export const blockMoveToPage = defineOp({
  name: "block.move_to_page",
  summary: "Move a block subtree to the end (or start) of a page",
  description:
    "Moves a block and every block nested under it to the top level of another page, at the end " +
    "(default) or the start. Ids are kept, so ((block refs)) to any of them keep working, and " +
    "the page is created if it does not exist (create_page: false to fail instead). This is the " +
    "op behind the outliner's 'Move to page' menu item. One batch: batch_undo with the returned " +
    "batch_id puts the subtree back where it was. To place a block relative to another block " +
    "rather than at a page's edge, use block_move.",
  input: z
    .object({
      id: BlockId,
      page: PageRef,
      position: z
        .enum(["start", "end"])
        .default("end")
        .describe("Which end of the page's top level the subtree lands at"),
      create_page: z.boolean().default(true),
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult.extend({
    page_created: z.boolean(),
    moved: z.number().int().describe("Blocks moved, the root and its descendants"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => `moved ${out.moved} block(s) to ${out.page}`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const row = getBlockRow(ctx.db, input.id);
      if (!row) throw new OpError("not_found", `no block with id ${input.id}`);
      checkIfVersion(row.updated_at, input.if_version);

      const target = await resolveOrMintPage(ctx, input.page, input.create_page);
      const bounds = target.createOp
        ? { pageId: target.page.id, parentId: null, lower: null, upper: null }
        : boundsForPageEnd(ctx.db, target.page.id, input.position);
      // biome-ignore lint/style/noNonNullAssertion: newOrderKeys(bounds, 1) always returns one key
      const order = newOrderKeys(bounds, 1)[0]!;
      const moved = subtreeBlockIds(ctx.db, input.id);
      const ops: Op[] = target.createOp ? [target.createOp] : [];
      ops.push(
        ...subtreePlaceOps(ctx.db, ctx.mintOp, input.id, {
          pageId: target.page.id,
          parentId: null,
          order,
        }),
      );

      const applyResult = await ctx.applyOps(ops);
      const rejected = applyResult.results.find((r) => r.status === "rejected");
      if (rejected) throw new OpError("invalid", `move rejected: ${rejected.reason}`);

      const [subtree] = await ctx.data.blocks.tree(input.id);
      return {
        page: pageWireNameById(ctx.db, target.page.id),
        created: [],
        updated: moved,
        deleted: [],
        outline: renderOutlineText(subtree ? [subtree as ServerBlockNode] : [], "all"),
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
        page_created: target.createOp !== undefined,
        moved: moved.length,
      };
    });
  },
});
