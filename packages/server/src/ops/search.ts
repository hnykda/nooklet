import type { SqlDriver } from "@nooklet/core";
import { normalizePageName } from "@nooklet/core";
import { z } from "zod";
import { isoFromJournalDay } from "../data-api.js";
import {
  checkSemanticAvailability,
  distanceToScore,
  embedQueryVector,
  rrfFuse,
  semanticCandidates,
} from "../embeddings/index.js";
import { defineOp, OpError } from "./registry.js";
import { resolvePageIds } from "./resolve.js";
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

function breadcrumbForBlock(driver: SqlDriver, parentId: string | null): string[] {
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

/** A snippet for a hit that has no FTS `snippet()` match to reuse (a vector-only hit in semantic
 * mode has no FTS row at all). */
function naiveSnippet(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}…` : content;
}

/** Re-check an id set (already ranked by KNN distance) against the same relational filters the
 * keyword path applies in SQL, preserving the input order. Used for semantic/hybrid candidates,
 * since vec0 KNN itself can't express tag/property/namespace filters. */
function filterIdsBySql(
  driver: SqlDriver,
  table: "block" | "page",
  alias: "b" | "p",
  ids: readonly string[],
  conditions: readonly string[],
  params: readonly unknown[],
): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const sql = `SELECT ${alias}.id AS id FROM ${table} ${alias} WHERE ${alias}.id IN (${placeholders}) AND ${conditions.join(" AND ")}`;
  const rows = driver.all<{ id: string }>(sql, [...ids, ...params]);
  return new Set(rows.map((r) => r.id));
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
      scope: z
        .enum(["blocks", "pages", "all"])
        .default("all")
        .describe("Match block content, page names/properties, or both"),
      tags: z.array(z.string()).max(10).optional(),
      properties: z
        .record(PropertyKey, z.string())
        .optional()
        .describe('Exact key=value filters, e.g. {"marker":"TODO"}'),
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
    mode_used: z
      .enum(["hybrid", "keyword", "semantic"])
      .describe('"keyword" if hybrid/semantic was requested but embeddings are unavailable'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
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

    // Soft-fail per ADR 010: hybrid/semantic degrade to keyword whenever sqlite-vec isn't loaded,
    // no active embedding model exists, or embedding the query itself fails (network/Ollama down).
    const availability =
      input.mode !== "keyword" ? checkSemanticAvailability(driver) : { available: false as const };
    const queryVec =
      availability.available && availability.model
        ? await embedQueryVector(driver, availability.model, input.query, ctx.signal)
        : undefined;
    const modeUsed: "hybrid" | "keyword" | "semantic" =
      input.mode === "keyword" || !queryVec ? "keyword" : input.mode;

    if (input.scope === "blocks" || input.scope === "all") {
      const conditions = ["b.deleted_at IS NULL"];
      const params: unknown[] = [];
      if (input.namespace) {
        conditions.push(
          "EXISTS (SELECT 1 FROM page p WHERE p.id = b.page_id AND (p.key = ? OR p.key LIKE ?))",
        );
        params.push(normalizePageName(input.namespace), `${normalizePageName(input.namespace)}/%`);
      }
      if (input.journals_only)
        conditions.push(
          "EXISTS (SELECT 1 FROM page p WHERE p.id = b.page_id AND p.journal_day IS NOT NULL)",
        );
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
        conditions.push(
          "EXISTS (SELECT 1 FROM ref r WHERE r.src_block_id = b.id AND r.kind = 'tag' AND r.dst_page_key = ?)",
        );
        params.push(normalizePageName(tag));
      }
      for (const [k, v] of Object.entries(input.properties ?? {})) {
        conditions.push(
          "EXISTS (SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = ? AND bp.value = ?)",
        );
        params.push(k, v);
      }

      const ftsRanked: string[] = [];
      const ftsMeta = new Map<string, { snip: string; rank: number }>();
      if (modeUsed !== "semantic") {
        const sql = `SELECT b.id AS id, bm25(block_fts) AS rank, snippet(block_fts, 0, '**', '**', '...', ${snippetTokens}) AS snip
                     FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
                     WHERE block_fts MATCH ? AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
        const rows = driver.all<{ id: string; rank: number; snip: string }>(sql, [
          input.query,
          ...params,
        ]);
        for (const r of rows) {
          ftsRanked.push(r.id);
          ftsMeta.set(r.id, { snip: r.snip, rank: r.rank });
        }
      }

      const vecRanked: string[] = [];
      const vecDistance = new Map<string, number>();
      if (modeUsed !== "keyword" && queryVec && availability.model) {
        const semHits = semanticCandidates(driver, availability.model, queryVec, "block", 50);
        const allowed = filterIdsBySql(
          driver,
          "block",
          "b",
          semHits.map((h) => h.unitId),
          conditions,
          params,
        );
        for (const h of semHits) {
          if (!allowed.has(h.unitId)) continue;
          vecRanked.push(h.unitId);
          vecDistance.set(h.unitId, h.distance);
        }
      }

      let scored: Array<{ id: string; score: number }>;
      if (modeUsed === "hybrid") {
        scored = rrfFuse(ftsRanked, vecRanked).map((f) => ({ id: f.id, score: f.score }));
      } else if (modeUsed === "semantic") {
        scored = vecRanked.map((id) => ({
          id,
          score: distanceToScore(vecDistance.get(id) ?? Infinity),
        }));
      } else {
        scored = ftsRanked.map((id) => ({
          id,
          score: 1 / (1 + Math.max(0, ftsMeta.get(id)?.rank ?? 0)),
        }));
      }

      for (const { id, score } of scored) {
        const b = driver.get<{
          id: string;
          page_id: string;
          content: string;
          updated_at: number;
          parent_id: string | null;
        }>("SELECT id, page_id, content, updated_at, parent_id FROM block WHERE id = ?", [id]);
        if (!b) continue;
        const page = driver.get<{ name: string; journal_day: number | null }>(
          "SELECT name, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
          [b.page_id],
        );
        if (!page) continue;
        candidates.push({
          kind: "block",
          id: b.id,
          pageId: b.page_id,
          pageName: page.journal_day !== null ? isoFromJournalDay(page.journal_day) : page.name,
          journalDate: page.journal_day !== null ? isoFromJournalDay(page.journal_day) : undefined,
          snippet: ftsMeta.get(id)?.snip ?? naiveSnippet(b.content, input.snippet_chars),
          breadcrumb: breadcrumbForBlock(driver, b.parent_id),
          score,
          updatedAt: b.updated_at,
        });
      }
    }

    if (input.scope === "pages" || input.scope === "all") {
      const conditions = ["p.deleted_at IS NULL"];
      const params: unknown[] = [];
      if (input.journals_only) conditions.push("p.journal_day IS NOT NULL");
      if (pageIds && pageIds.length > 0) {
        conditions.push(`p.id IN (${pageIds.map(() => "?").join(",")})`);
        params.push(...pageIds);
      }

      const ftsRanked: string[] = [];
      const ftsMeta = new Map<string, number>();
      if (modeUsed !== "semantic") {
        const sql = `SELECT p.id AS id, bm25(page_fts) AS rank
                     FROM page_fts JOIN page p ON p.rowid = page_fts.rowid
                     WHERE page_fts MATCH ? AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
        const rows = driver.all<{ id: string; rank: number }>(sql, [input.query, ...params]);
        for (const r of rows) {
          ftsRanked.push(r.id);
          ftsMeta.set(r.id, r.rank);
        }
      }

      const vecRanked: string[] = [];
      const vecDistance = new Map<string, number>();
      if (modeUsed !== "keyword" && queryVec && availability.model) {
        const semHits = semanticCandidates(driver, availability.model, queryVec, "page", 50);
        const allowed = filterIdsBySql(
          driver,
          "page",
          "p",
          semHits.map((h) => h.unitId),
          conditions,
          params,
        );
        for (const h of semHits) {
          if (!allowed.has(h.unitId)) continue;
          vecRanked.push(h.unitId);
          vecDistance.set(h.unitId, h.distance);
        }
      }

      let scored: Array<{ id: string; score: number }>;
      if (modeUsed === "hybrid") {
        scored = rrfFuse(ftsRanked, vecRanked).map((f) => ({ id: f.id, score: f.score }));
      } else if (modeUsed === "semantic") {
        scored = vecRanked.map((id) => ({
          id,
          score: distanceToScore(vecDistance.get(id) ?? Infinity),
        }));
      } else {
        scored = ftsRanked.map((id) => ({
          id,
          score: 1 / (1 + Math.max(0, ftsMeta.get(id) ?? 0)),
        }));
      }

      for (const { id, score } of scored) {
        const p = driver.get<{
          id: string;
          name: string;
          journal_day: number | null;
          updated_at: number;
        }>(
          "SELECT id, name, journal_day, updated_at FROM page WHERE id = ? AND deleted_at IS NULL",
          [id],
        );
        if (!p) continue;
        candidates.push({
          kind: "page",
          id: p.id,
          pageId: p.id,
          pageName: p.journal_day !== null ? isoFromJournalDay(p.journal_day) : p.name,
          journalDate: p.journal_day !== null ? isoFromJournalDay(p.journal_day) : undefined,
          snippet: p.journal_day !== null ? isoFromJournalDay(p.journal_day) : p.name,
          breadcrumb: [],
          score,
          updatedAt: p.updated_at,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const offset = input.cursor
      ? Number.parseInt(Buffer.from(input.cursor, "base64").toString("utf8"), 10)
      : 0;
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
      mode_used: modeUsed,
    };
  },
});
