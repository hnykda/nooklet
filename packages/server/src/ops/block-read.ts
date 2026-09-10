import type { SqlDriver } from "@vrite/core";
import { z } from "zod";
import { getBlockRow, isoFromJournalDay, type ServerBlockNode } from "../data-api.js";
import { renderRootTruncated, toWireBlockNode } from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { BlockId, BlockNode, Format } from "./schemas.js";

function breadcrumbFor(
  driver: SqlDriver,
  parentId: string | null,
): Array<{ id: string; text: string }> {
  const chain: Array<{ id: string; text: string }> = [];
  let cur = parentId;
  while (cur !== null) {
    const row = getBlockRow(driver, cur);
    if (!row) break;
    chain.push({ id: row.id, text: (row.content.split("\n")[0] ?? "").trim() });
    cur = row.parent_id;
  }
  return chain.reverse();
}

export const blockRead = defineOp({
  name: "block.read",
  summary: "Read one block subtree",
  description:
    "Reads one block and its children as outline Markdown with ^ids, plus a breadcrumb (the page " +
    "name and the text of each ancestor block). Use this after search or page_read to zoom into " +
    "one subtree without reading the whole page again, or to read a subtree that a previous " +
    "page_read cut off with truncated.",
  input: z
    .object({
      id: BlockId,
      format: Format,
      depth: z.number().int().min(0).max(20).default(6),
      max_chars: z.number().int().min(200).max(200_000).default(10_000),
      ids: z.enum(["all", "none"]).default("all"),
    })
    .strict(),
  output: z.object({
    page: z.string(),
    breadcrumb: z.array(z.object({ id: BlockId, text: z.string() })),
    block: BlockNode,
    text: z.string(),
    truncated: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { http: { method: "GET", path: "/blocks/{id}" } },
  render: (out) => out.text,
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const row = getBlockRow(driver, input.id);
    if (!row) {
      throw new OpError(
        "not_found",
        `no block with id ${input.id}`,
        "this block may be in the trash; ask the user to restore it",
      );
    }
    const [rootNode] = await ctx.data.blocks.tree(input.id, { depth: input.depth });
    const node = rootNode as ServerBlockNode;
    const rendered = renderRootTruncated(node, input.ids, input.max_chars);
    const pageRow = driver.get<{ name: string; journal_day: number | null }>(
      "SELECT name, journal_day FROM page WHERE id = ?",
      [row.page_id],
    );
    const pageWire = pageRow
      ? pageRow.journal_day !== null
        ? isoFromJournalDay(pageRow.journal_day)
        : pageRow.name
      : row.page_id;
    return {
      page: pageWire,
      breadcrumb: breadcrumbFor(driver, row.parent_id),
      block: toWireBlockNode(driver, node),
      text: rendered.text,
      truncated: rendered.truncated,
    };
  },
});
