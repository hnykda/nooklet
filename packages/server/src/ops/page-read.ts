import { z } from "zod";
import { loadBlockTree } from "../data-api.js";
import { renderTruncated, toWireBlockNode } from "./outline-bridge.js";
import { defineOp } from "./registry.js";
import { backlinkCount, pageMetaWire, requirePage } from "./resolve.js";
import { BlockNode, Format, PageMeta } from "./schemas.js";

export const pageRead = defineOp({
  name: "page.read",
  summary: "Read a page or journal day",
  description:
    "Reads a page or journal day as outline Markdown, where every block's bullet line ends with " +
    "its id (^1k7f3q9xz2hav4). Use those ids with block_read, block_insert, block_update, " +
    "block_move, block_delete. Control cost with depth (nesting levels) and max_chars (hard cap); " +
    "when the result is truncated, read the omitted subtree with block_read rather than " +
    "re-reading the whole page. format: 'json' returns a typed tree instead of text. page accepts " +
    "a page name, a journal date (YYYY-MM-DD), or today/yesterday/tomorrow. A missing page is " +
    "not_found - this call never creates a page; use page_create or page_append for that.",
  input: z
    .object({
      page: z.string().min(1).max(512),
      format: Format,
      depth: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(6)
        .describe("Max nesting depth to include (0 = only top-level blocks)"),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .default(20_000)
        .describe("Truncate text output after this many characters, at a block boundary"),
      ids: z
        .enum(["all", "none"])
        .default("all")
        .describe(
          "Include ^ids (needed for editing) or omit them to save tokens; ignored when format is json",
        ),
      include_backlink_count: z.boolean().default(true),
    })
    .strict(),
  output: z.object({
    page: PageMeta,
    text: z.string().describe("Rendered outline Markdown; empty when format is json"),
    tree: z.array(BlockNode).optional().describe("Present when format is json"),
    truncated: z.boolean(),
    continue_hint: z.string().optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: {
    http: { method: "GET", path: "/pages/{page}" },
    mcp: { alwaysLoad: true, maxResultSizeChars: 200_000 },
  },
  render: (out) =>
    out.tree ? `${out.page.name}: ${out.page.block_count} blocks (json)` : out.text,
  handler: async (input, ctx) => {
    const page = await requirePage(ctx, input.page);
    const driver = ctx.db;

    const meta = pageMetaWire(driver, page, {
      backlinkCount: input.include_backlink_count ? backlinkCount(driver, page) : undefined,
    });

    if (input.format === "json") {
      const nodes = loadBlockTree(driver, null, page.id, input.depth);
      return {
        page: meta,
        text: "",
        tree: nodes.map((n) => toWireBlockNode(driver, n)),
        truncated: false,
      };
    }

    const nodes = loadBlockTree(driver, null, page.id, input.depth);
    const rendered = renderTruncated(nodes, input.ids, input.max_chars);
    const propLines = Object.entries(page.properties)
      .map(([k, v]) => `${k}:: ${v}`)
      .join("\n");
    const text = propLines ? `${propLines}\n\n${rendered.text}` : rendered.text;
    return {
      page: meta,
      text,
      truncated: rendered.truncated,
      continue_hint: rendered.truncated
        ? `${rendered.omittedCount} block(s) omitted after ^${rendered.lastIncludedId}; call block_read on it, or page_read again with a larger max_chars`
        : undefined,
    };
  },
});
