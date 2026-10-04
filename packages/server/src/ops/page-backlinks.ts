import { type BacklinksTarget, backlinkRows } from "@nooklet/core";
import { z } from "zod";
import { pageWireNameById } from "../rows.js";
import { defineOp } from "./registry.js";
import { resolvePageRef, wirePageName } from "./resolve.js";
import { BlockId, Cursor, Limit, PageRef } from "./schemas.js";

export const pageBacklinks = defineOp({
  name: "page.backlinks",
  summary: "Linked/unlinked references to a page or block",
  description:
    "Lists blocks that reference a page or block: [[page]] links, #tags, ((block refs)), and - if " +
    "include_unlinked - plain-text mentions of the page's name that are not already a link. Each " +
    "item has the referencing block's id, page, and text, and direct: true when the block links the " +
    "target itself rather than only sitting under a block that does (linked_direct_total counts " +
    "those - the number Logseq shows as N Linked References). For a page it also lists tagged_pages: " +
    "the pages that carry it as a page-level tag - a tags:: page property naming it (source " +
    "property), or every journal day under Journal (source intrinsic) - with tagged_total, so " +
    "asking about Person or Journal returns its members. Linked references and tagged_pages are " +
    "paginated together by limit and cursor (linked_total counts all linked); unlinked mentions " +
    "are not - up to unlinked_limit are returned, with unlinked_truncated saying whether there " +
    "are more. Use this before renaming or deleting a page to see what points at it.",
  input: z
    .object({
      target: z
        .union([PageRef, BlockId])
        .describe("Page name/date/alias, a page id, or a block id"),
      include_unlinked: z.boolean().default(false),
      unlinked_limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe(
          "Max unlinked mentions to return (500 is also what one mentions_link call rewrites)",
        ),
      limit: Limit,
      cursor: Cursor.optional(),
    })
    .strict(),
  output: z.object({
    target: z.string(),
    linked: z.array(
      z.object({
        id: BlockId,
        page: z.string(),
        text: z.string(),
        updated_at: z.string(),
        direct: z
          .boolean()
          .describe(
            "The block links the target itself; false when it is listed only because an ancestor does",
          ),
      }),
    ),
    linked_total: z.number().int().describe("Linked references across all pages of results"),
    linked_direct_total: z
      .number()
      .int()
      .describe(
        "How many of linked_total link the target directly - Logseq's linked-references count",
      ),
    unlinked: z.array(z.object({ id: BlockId, page: z.string(), text: z.string() })).default([]),
    unlinked_truncated: z
      .boolean()
      .default(false)
      .describe("More unlinked mentions exist than unlinked_limit returned"),
    tagged_pages: z
      .array(
        z.object({
          id: z.string(),
          page: z.string(),
          source: z.enum(["property", "intrinsic"]),
        }),
      )
      .default([]),
    tagged_total: z.number().int().default(0),
    cursor: z.string().optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { http: { method: "GET", path: "/pages/{page}/backlinks" } },
  render: (out) =>
    `${out.linked.length} linked, ${out.unlinked.length} unlinked reference(s) to ${out.target}` +
    (out.tagged_total > 0 ? `; ${out.tagged_total} page(s) tagged ${out.target}` : ""),
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const offset = input.cursor
      ? Number.parseInt(Buffer.from(input.cursor, "base64").toString("utf8"), 10)
      : 0;

    // Resolution stays here (it is shared by every op that takes a `PageRef`, errors included);
    // the reading is `@nooklet/core`'s `backlinkRows`, the same code a client replica answers its
    // references panel with (B-641), so the two cannot drift.
    //
    // A name that is neither a page nor a block is a page that is REFERENCED but not created yet:
    // an empty list rather than an error — returning 404 here meant every not-yet-created page
    // rendered as "Couldn't load references".
    const asPage = await resolvePageRef(ctx, input.target);
    let target: BacklinksTarget;
    let targetWire: string;
    if (asPage) {
      target = { kind: "page", page: asPage };
      targetWire = wirePageName(asPage);
    } else if (await ctx.data.blocks.get(input.target)) {
      target = { kind: "block", blockId: input.target };
      targetWire = input.target;
    } else {
      target = { kind: "key", name: input.target };
      targetWire = input.target;
    }
    const rows = backlinkRows(driver, target, {
      includeUnlinked: input.include_unlinked,
      unlinkedLimit: input.unlinked_limit,
    });
    const linkedRows = rows.linked;
    const unlinkedRows = rows.unlinked;
    const taggedRows = rows.tagged;

    const end = offset + input.limit;
    const hasMore = linkedRows.length > end || taggedRows.length > end;
    const unlinkedTruncated = unlinkedRows.length > input.unlinked_limit;

    return {
      target: targetWire,
      linked: linkedRows.slice(offset, end).map((r) => ({
        id: r.block_id,
        page: pageWireNameById(driver, r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
        updated_at: new Date(r.updated_at).toISOString(),
        direct: r.direct === 1,
      })),
      linked_total: linkedRows.length,
      linked_direct_total: linkedRows.filter((r) => r.direct === 1).length,
      unlinked: unlinkedRows.slice(0, input.unlinked_limit).map((r) => ({
        id: r.block_id,
        page: pageWireNameById(driver, r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
      })),
      unlinked_truncated: unlinkedTruncated,
      tagged_pages: taggedRows.slice(offset, end).map((r) => ({
        id: r.page_id,
        page: pageWireNameById(driver, r.page_id),
        source: r.source,
      })),
      tagged_total: taggedRows.length,
      cursor: hasMore ? Buffer.from(String(end)).toString("base64") : undefined,
    };
  },
});
