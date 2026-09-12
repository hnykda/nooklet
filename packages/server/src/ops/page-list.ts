import { normalizePageName } from "@nooklet/core";
import { z } from "zod";
import { wirePageNameOf } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { Cursor, Limit } from "./schemas.js";

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new OpError(
      "invalid",
      "cursor is not valid for this query",
      "start a new page.list without cursor",
    );
  }
  return n;
}

export const pageList = defineOp({
  name: "page.list",
  summary: "List pages (filtered, paginated)",
  description:
    "Lists pages by namespace, name prefix, tag, or kind, sorted by name or last update, " +
    "paginated. Journals are excluded unless kind is journal or all. This is for browsing a known " +
    "slice of the graph (a namespace, a tag); to find pages or blocks by content use search instead.",
  input: z
    .object({
      namespace: z
        .string()
        .optional()
        .describe('Only pages under this namespace, e.g. "Projects" matches "Projects/Aurora"'),
      prefix: z.string().optional().describe("Case-insensitive name prefix"),
      tag: z.string().optional().describe('Only pages whose "tags" property includes this tag'),
      kind: z.enum(["page", "journal", "all"]).default("page"),
      sort: z.enum(["name", "updated", "created"]).default("name"),
      order: z.enum(["asc", "desc"]).default("asc"),
      limit: Limit,
      cursor: Cursor.optional(),
    })
    .strict(),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["page", "journal"]),
        updated_at: z.string(),
        block_count: z.number().int(),
      }),
    ),
    cursor: z.string().optional().describe("Present when more pages match; pass back to continue"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { http: { method: "GET", path: "/pages" } },
  render: (out) => `${out.items.length} page(s)${out.cursor ? " (more available)" : ""}`,
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const offset = decodeCursor(input.cursor);
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (input.kind === "journal") conditions.push("journal_day IS NOT NULL");
    else if (input.kind === "page") conditions.push("journal_day IS NULL");
    if (input.namespace) {
      const ns = normalizePageName(input.namespace);
      conditions.push("(key = ? OR key LIKE ?)");
      params.push(ns, `${ns}/%`);
    }
    if (input.prefix) {
      conditions.push("key LIKE ?");
      params.push(`${normalizePageName(input.prefix)}%`);
    }
    if (input.tag) {
      conditions.push(
        "EXISTS (SELECT 1 FROM page_prop pp WHERE pp.page_id = page.id AND pp.key = 'tags' AND pp.value IS NOT NULL AND pp.value LIKE ?)",
      );
      params.push(`%${input.tag}%`);
    }
    const sortCol =
      input.sort === "updated" ? "updated_at" : input.sort === "created" ? "created_at" : "name";
    const order = input.order === "desc" ? "DESC" : "ASC";
    const rows = driver.all<{
      id: string;
      name: string;
      journal_day: number | null;
      updated_at: number;
    }>(
      `SELECT id, name, journal_day, updated_at FROM page WHERE ${conditions.join(" AND ")} ORDER BY ${sortCol} ${order}, id LIMIT ? OFFSET ?`,
      [...params, input.limit + 1, offset],
    );
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const items = page.map((r) => {
      const count = driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM block WHERE page_id = ? AND deleted_at IS NULL",
        [r.id],
      );
      return {
        id: r.id,
        name: wirePageNameOf(r),
        kind: r.journal_day !== null ? ("journal" as const) : ("page" as const),
        updated_at: new Date(r.updated_at).toISOString(),
        block_count: count?.n ?? 0,
      };
    });
    return { items, cursor: hasMore ? encodeCursor(offset + input.limit) : undefined };
  },
});
