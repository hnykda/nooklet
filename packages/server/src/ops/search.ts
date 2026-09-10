import { normalizePageName } from "@vrite/core";
import { z } from "zod";
import { isoFromJournalDay } from "../data-api.js";
import { resolvePageIds } from "./resolve.js";
import { defineOp, OpError } from "./registry.js";
import { Cursor, Limit, PageRef, PropertyKey } from "./schemas.js";

interface Candidate {
  kind: "block" | "page";
  id: string;
  pageId: string;
  pageName: string;
  journalDate?: string;
  snippet: string;
  breadcrumb: string[];
  score: number;
  updatedAt: number;
}

function breadcrumbForBlock(driver: import("@vrite/core").SqlDriver, parentId: string | null): string[] {
  const chain: string[] = [];
  let cur = parentId;
  let guard = 0;
  while (cur !== null && guard++ < 100) {
    const row = driver.get<{ content: string; parent_id: string | null }>(
      "SELECT content, parent_id FROM block WHERE id = ?",
      [cur],
    );
    if (!row) break;
    chain.push((row.content.split("\n")[0] ?? "").trim());
    cur = row.parent_id;
  }
  return chain.reverse();
}

export const search = defineOp({
  name: "search",
  summary: "Search blocks and pages",
  description:
    'Finds blocks and pages. mode: "hybrid" (default) combines full-text and semantic ' +
    'similarity; "keyword" for exact words or "quoted phrases" and -exclusions; "semantic" for ' +
    "meaning-based matches (falls back to keyword if no embedding model is configured - check " +
    "mode_used). Filters: tags (all must match), properties (exact key=value, e.g. finding " +
    "scheduled or marker values), namespace, pages (restrict to specific pages), " +
    "updated_after/updated_before, journals_only. Each hit has the block or page id, its page, a " +
    "snippet with the match highlighted, a breadcrumb, and a 0-1 score. Paginated. Read around a " +
    "hit with page_read/block_read.",
  input: z
    .object({
      query: z.string().min(1).max(500),
      mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
      scope: z.enum(["blocks", "pages", "all"]).default("all").describe("Match block content, page names/properties, or both"),
      tags: z.array(z.string()).max(10).optional(),
      properties: z.record(PropertyKey, z.string()).optional().describe('Exact key=value filters, e.g. {"marker":"TODO"}'),
      namespace: z.string().optional(),
      pages: z.array(PageRef).max(20).optional(),
      journals_only: z.boolean().default(false),
      updated_after: z.string().optional().describe("ISO date/time"),
      updated_before: z.string().optional(),
      limit: Limit,
      cursor: Cursor.optional(),
      snippet_chars: z.number().int().min(40).max(600).default(200),
    })
    .strict(),
  output: z.object({
    hits: z.array(
      z.object({
        kind: z.enum(["block", "page"]),
        id: z.string(),
        page: z.string(),
        journal_date: z.string().optional(),
        snippet: z.string(),
        breadcrumb: z.array(z.string()),
        score: z.number().min(0).max(1),
        updated_at: z.string(),
      }),
    ),
    cursor: z.string().optional(),
    mode_used: z.enum(["hybrid", "keyword", "semantic"]).describe('"keyword" if hybrid/semantic was requested but embeddings are unavailable'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ["read"],
  expose: { mcp: { alwaysLoad: true } },
  render: (out) => `${out.hits.length} hit(s) (${out.mode_used})`,
  handler: async (input, ctx) => {
    if (input.pages && input.pages.length > 20) {
      throw new OpError("invalid", "at most 20 pages allowed");
    }
    const driver = ctx.db;
    const pageIds = input.pages ? await resolvePageIds(ctx, input.pages) : undefined;
    if (input.pages && input.pages.length > 0 && pageIds && pageIds.length === 0) {
      return { hits: [], mode_used: "keyword" as const };
    }

    const snippetTokens = Math.max(4, Math.round(input.snippet_chars / 8));
    const candidates: Candidate[] = [];

    if (input.scope === "blocks" || input.scope === "all") {
      const conditions = ["b.deleted_at IS NULL"];
      const params: unknown[] = [input.query];
      let sql = `SELECT b.id AS id, b.page_id AS page_id, b.updated_at AS updated_at, b.parent_id AS parent_id,
                        bm25(block_fts) AS rank, snippet(block_fts, 0, '**', '**', '...', ${snippetTokens}) AS snip
                 FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
                 WHERE block_fts MATCH ?`;
      if (input.namespace) {
        conditions.push(
          "EXISTS (SELECT 1 FROM page p WHERE p.id = b.page_id AND (p.key = ? OR p.key LIKE ?))",
        );
        params.push(normalizePageName(input.namespace), `${normalizePageName(input.namespace)}/%`);
      }
      if (input.journals_only) conditions.push("EXISTS (SELECT 1 FROM page p WHERE p.id = b.page_id AND p.journal_day IS NOT NULL)");
      if (input.updated_after) {
        conditions.push("b.updated_at > ?");
        params.push(Date.parse(input.updated_after));
      }
      if (input.updated_before) {
        conditions.push("b.updated_at < ?");
        params.push(Date.parse(input.updated_before));
      }
      if (pageIds && pageIds.length > 0) {
        conditions.push(`b.page_id IN (${pageIds.map(() => "?").join(",")})`);
        params.push(...pageIds);
      }
      for (const tag of input.tags ?? []) {
        conditions.push("EXISTS (SELECT 1 FROM ref r WHERE r.src_block_id = b.id AND r.kind = 'tag' AND r.dst_page_key = ?)");
        params.push(normalizePageName(tag));
      }
      for (const [k, v] of Object.entries(input.properties ?? {})) {
        conditions.push("EXISTS (SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = ? AND bp.value = ?)");
        params.push(k, v);
      }
      sql += ` AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
      const rows = driver.all<{
        id: string;
        page_id: string;
        updated_at: number;
        parent_id: string | null;
        rank: number;
        snip: string;
      }>(sql, params);
      for (const r of rows) {
        const page = driver.get<{ name: string; journal_day: number | null }>(
          "SELECT name, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
          [r.page_id],
        );
        if (!page) continue;
        candidates.push({
          kind: "block",
          id: r.id,
          pageId: r.page_id,
          pageName: page.journal_day !== null ? isoFromJournalDay(page.journal_day) : page.name,
          journalDate: page.journal_day !== null ? isoFromJournalDay(page.journal_day) : undefined,
          snippet: r.snip,
          breadcrumb: breadcrumbForBlock(driver, r.parent_id),
          score: 1 / (1 + Math.max(0, r.rank)),
          updatedAt: r.updated_at,
        });
      }
    }

    if (input.scope === "pages" || input.scope === "all") {
      const conditions = ["p.deleted_at IS NULL"];
      const params: unknown[] = [input.query];
      if (input.journals_only) conditions.push("p.journal_day IS NOT NULL");
      if (pageIds && pageIds.length > 0) conditions.push(`p.id IN (${pageIds.map(() => "?").join(",")})`);
      if (pageIds && pageIds.length > 0) params.push(...pageIds);
      const sql = `SELECT p.id AS id, p.name AS name, p.journal_day AS journal_day, p.updated_at AS updated_at, bm25(page_fts) AS rank
                   FROM page_fts JOIN page p ON p.rowid = page_fts.rowid
                   WHERE page_fts MATCH ? AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
      const rows = driver.all<{ id: string; name: string; journal_day: number | null; updated_at: number; rank: number }>(
        sql,
        params,
      );
      for (const r of rows) {
        candidates.push({
          kind: "page",
          id: r.id,
          pageId: r.id,
          pageName: r.journal_day !== null ? isoFromJournalDay(r.journal_day) : r.name,
          journalDate: r.journal_day !== null ? isoFromJournalDay(r.journal_day) : undefined,
          snippet: r.name,
          breadcrumb: [],
          score: 1 / (1 + Math.max(0, r.rank)),
          updatedAt: r.updated_at,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const offset = input.cursor ? Number.parseInt(Buffer.from(input.cursor, "base64").toString("utf8"), 10) : 0;
    const page = candidates.slice(offset, offset + input.limit);
    const hasMore = candidates.length > offset + input.limit;

    return {
      hits: page.map((c) => ({
        kind: c.kind,
        id: c.id,
        page: c.pageName,
        journal_date: c.journalDate,
        snippet: c.snippet,
        breadcrumb: c.breadcrumb,
        score: Math.min(1, Math.max(0, c.score)),
        updated_at: new Date(c.updatedAt).toISOString(),
      })),
      cursor: hasMore ? Buffer.from(String(offset + input.limit)).toString("base64") : undefined,
      // Soft-fail (rule/§9.14): hybrid/semantic degrade to keyword since no embedding index exists
      // in M1 (ADR 010); this is never surfaced as an error.
      mode_used: "keyword" as const,
    };
  },
});
