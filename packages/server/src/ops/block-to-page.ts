/**
 * `block.to_page` (M7, research/13 §4.2 item 3 — Logseq's most-asked-for refactor): a block whose
 * children have outgrown it becomes a page. The first line names the page, the children become
 * its blocks, and the block itself stays where it was as a `[[link]]` — same id, same marker,
 * same properties — so nothing that pointed at it breaks.
 */

import { newId, type Op } from "@nooklet/core";
import { z } from "zod";
import { boundsForPageEnd, newOrderKeys, subtreePlaceOps } from "../data-api.js";
import { getBlockRow, pageWireNameById } from "../rows.js";
import { applyAllOrNothing } from "./apply-all-or-nothing.js";
import { resolveOrMintPage } from "./block-move-to-page.js";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion } from "./resolve.js";
import { BatchIdOut, BlockId, IdempotencyKey, IfVersion } from "./schemas.js";

/** A first line that is already exactly one `[[link]]` (or `[[link|label]]`) names that page. */
const SOLE_LINK_RE = /^\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]$/;
/** A Markdown heading marker at the start of the line: `#` to `######`, then space or the end. */
const HEADING_RE = /^(#{1,6})(?:\s+|$)/;
/** An inline `[[Page]]` or `[[Page|label]]`. */
const INLINE_LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;

/**
 * The page name a block's first line stands for, and the heading marker that stays on the block
 * (B-254). The raw line used to be the name, so `## Plánování…` made a page called "## Plánování…"
 * beside the existing "Plánování…", and `[[Alex]] by chtěl…` left the block as
 * `[[[[Alex]] by chtěl…]]`. The name is what the line shows: no heading marker (it is the block's
 * formatting, so it stays on the link block and the outline keeps its heading), and inline links
 * reduced to their text — the label where there is one, since that is what was on screen.
 */
export function pageNameFromFirstLine(firstLine: string): { name: string; headingPrefix: string } {
  const line = firstLine.trim();
  const heading = HEADING_RE.exec(line);
  const headingPrefix = heading ? `${heading[1]} ` : "";
  const text = heading ? line.slice(heading[0].length).trim() : line;
  const sole = SOLE_LINK_RE.exec(text);
  const name = sole
    ? (sole[1] as string)
    : text.replace(INLINE_LINK_RE, (_m, page: string, label?: string) => label || page);
  return { name: name.trim().replace(/\s+/g, " "), headingPrefix };
}

export const blockToPage = defineOp({
  name: "block.to_page",
  summary: "Turn a block into a page",
  description:
    "Turns a block into a page: the block's first line becomes the page name (or pass name to " +
    "choose one; a heading's # marker is not part of the name and stays on the block, inline " +
    "[[links]] count as their text, and a first line that is a single [[link]] names that page), " +
    "every block " +
    "nested under it becomes a top-level block of that page in the same order and nesting " +
    "(appended after any existing blocks if the page already exists), and the block itself is " +
    "replaced by a [[link]] to the page - keeping its id, task marker, priority and properties, " +
    "so references to it still work. Continuation lines under the first line become the page's " +
    "first block. The page is created if it does not exist. One batch: batch_undo with the " +
    "returned batch_id puts everything back. Use dry_run to preview the page name and how many " +
    "blocks would move.",
  input: z
    .object({
      id: BlockId,
      name: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe("Page name to use instead of the block's first line"),
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    page: z.string().describe("The page the block became (wire name)"),
    page_id: z.string(),
    page_created: z.boolean(),
    block_id: BlockId.describe("The block, now a [[link]] to page"),
    link: z.string().describe("The block's new text"),
    moved: z.number().int().describe("Blocks moved onto the page (children and their subtrees)"),
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
  render: (out) =>
    `${out.page_created ? "created" : "extended"} ${out.page}: ${out.moved} block(s) moved, block ^${out.block_id} is now ${out.link}`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const row = getBlockRow(ctx.db, input.id);
      if (!row) throw new OpError("not_found", `no block with id ${input.id}`);
      checkIfVersion(row.updated_at, input.if_version);

      const lines = row.content.split("\n");
      const rest = lines.slice(1).join("\n").trim();
      const fromLine = pageNameFromFirstLine(lines[0] ?? "");
      const name = input.name?.trim().replace(/\s+/g, " ") ?? fromLine.name;
      if (name === "") {
        throw new OpError(
          "invalid",
          "the block has no text to name a page by",
          "give the block a first line, or pass name",
        );
      }
      if (name.length > 512) throw new OpError("invalid", "page name is longer than 512 chars");

      const target = await resolveOrMintPage(ctx, name, true);
      const children = await ctx.data.blocks.children(input.id);
      const extra = rest !== "" ? 1 : 0;
      const bounds = target.createOp
        ? { pageId: target.page.id, parentId: null, lower: null, upper: null }
        : boundsForPageEnd(ctx.db, target.page.id, "end");
      const keys = newOrderKeys(bounds, children.length + extra);

      const ops: Op[] = target.createOp ? [target.createOp] : [];
      let moved = 0;
      if (extra) {
        // The lines that were not the title go first on the new page, ahead of the children,
        // which is where they sat in the outline (under the first line, above the bullets).
        ops.push(
          ctx.mintOp(newId(), {
            kind: "block.create",
            place: { pageId: target.page.id, parentId: null, order: keys[0] as string },
            content: rest,
            createdAt: Date.now(),
          }),
        );
      }
      children.forEach((child, i) => {
        const place = subtreePlaceOps(ctx.db, ctx.mintOp, child.id, {
          pageId: target.page.id,
          parentId: null,
          order: keys[i + extra] as string,
        });
        moved += place.length;
        ops.push(...place);
      });
      const link = `${fromLine.headingPrefix}[[${target.page.name}]]`;
      if (row.content !== link)
        ops.push(ctx.mintOp(input.id, { kind: "block.text", content: link }));

      const applyResult = await applyAllOrNothing(ctx, ops, "block.to_page");

      return {
        page: pageWireNameById(ctx.db, target.page.id),
        page_id: target.page.id,
        page_created: target.createOp !== undefined,
        block_id: input.id,
        link,
        moved,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
