import type { SqlDriver } from "@nooklet/core";
import { normalizePageName, toFtsQuery } from "@nooklet/core";
import { z } from "zod";
import {
  checkSemanticAvailability,
  distanceToScore,
  embedQueryForSearch,
  rrfFuse,
  type SemanticFallback,
  semanticCandidates,
} from "../embeddings/index.js";
import { wirePageNameOf } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { resolvePageIds } from "./resolve.js";
import { Cursor, Limit, PageRef, PropertyKey } from "./schemas.js";

/** `properties` keys whose value is stored verbatim in a `block` column rather than `block_prop`.
 * `scheduled`/`deadline`/`done` are reserved too but stored as a day number, time and epoch ms, so
 * an exact string compare is not meaningful for them; they are not mapped (B-238 says so). */
const TEXT_COLUMN_PROPS: Readonly<Record<string, string>> = {
  marker: "marker",
  priority: "priority",
  repeat: "repeat",
};

/** `updated_after`/`updated_before` as epoch ms, or `invalid` — a silently-NaN bound would compare
 * every row as false and return nothing, which reads as "no results" rather than "bad input". */
function parseWhen(field: string, value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new OpError(
      "invalid",
      `${field} is not a date: "${value}"`,
      "use an ISO date or date-time, e.g. 2026-09-01 or 2026-09-01T12:00:00Z",
    );
  }
  return ms;
}

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
    'similarity; "keyword" for words (each matches as a prefix: "rational" finds "rationality"), ' +
    '"quoted phrases" (exact) and -exclusions; "semantic" for ' +
    "meaning-based matches (falls back to keyword if semantic search is unavailable - mode_used " +
    "says which ran, and fallback says why: not set up, still indexing, embedding server " +
    "unreachable, ...). Filters: tags (all must match), properties (exact key=value, e.g. finding " +
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
    // B-520: `mode_used` alone reached the reader as "Fell back to keyword search", with nothing
    // to say whether to open Settings, start Ollama, or wait for indexing. `../embeddings/
    // semantic-search.ts` owns the reasons and their wording.
    fallback: z
      .object({
        reason: z.enum([
          "sqlite_vec_unavailable",
          "not_configured",
          "indexing",
          "index_incomplete",
          "provider_unreachable",
          "model_missing",
          "query_embedding_failed",
        ]),
        message: z.string().describe("One sentence saying why, fit to show as-is"),
        provider: z.string().optional(),
        model: z.string().optional(),
        host: z.string().optional().describe("The embedding server's address"),
        indexed: z.number().int().optional().describe("Vectors stored so far"),
        total: z.number().int().optional().describe("Units the finished index will hold"),
        errors: z.number().int().optional().describe("Units that failed to embed"),
        error: z.string().optional().describe("The underlying error, verbatim"),
      })
      .optional()
      .describe(
        "Present exactly when mode_used is not the mode requested: why semantic search did not run",
      ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { mcp: { alwaysLoad: true } },
  render: (out) =>
    `${out.hits.length} hit(s) (${out.mode_used})${out.fallback ? ` - ${out.fallback.message}` : ""}`,
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const updatedAfter =
      input.updated_after !== undefined ? parseWhen("updated_after", input.updated_after) : null;
    const updatedBefore =
      input.updated_before !== undefined ? parseWhen("updated_before", input.updated_before) : null;
    const pageIds = input.pages ? await resolvePageIds(ctx, input.pages) : undefined;
    if (input.pages && input.pages.length > 0 && pageIds && pageIds.length === 0) {
      // Nothing was searched, so nothing fell back: answering "keyword" here told an agent that
      // semantic search was unavailable when it had not even been tried (B-521).
      return { hits: [], mode_used: input.mode };
    }

    // Built once, never the raw string: FTS5's query language throws on ordinary punctuation
    // (`c++`, `what's`, `e-mail`), and a throw here was an HTTP 500. `null` means the query had
    // nothing positive to match — exclusions only — which is "no keyword hits", not an error.
    const ftsQuery = toFtsQuery(input.query);
    const snippetTokens = Math.max(4, Math.round(input.snippet_chars / 8));
    const candidates: Candidate[] = [];

    // Soft-fail per ADR 010: hybrid/semantic degrade to keyword whenever sqlite-vec isn't loaded,
    // no active embedding model exists, or embedding the query itself fails (network/Ollama down)
    // — and `fallback` records which of those it was (B-520).
    const availability =
      input.mode !== "keyword" ? checkSemanticAvailability(driver) : { available: false as const };
    const embedded =
      availability.available && availability.model
        ? await embedQueryForSearch(driver, availability.model, input.query, ctx.signal)
        : undefined;
    const queryVec = embedded?.vector;
    const modeUsed: "hybrid" | "keyword" | "semantic" =
      input.mode === "keyword" || !queryVec ? "keyword" : input.mode;
    const fallback: SemanticFallback | undefined =
      modeUsed === input.mode ? undefined : (availability.fallback ?? embedded?.fallback);

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
      if (updatedAfter !== null) {
        conditions.push("b.updated_at > ?");
        params.push(updatedAfter);
      }
      if (updatedBefore !== null) {
        conditions.push("b.updated_at < ?");
        params.push(updatedBefore);
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
        // Reserved task keys live in `block` columns (ADR 011), never in `block_prop` — looking
        // there made the description's own example, {"marker":"TODO"}, match nothing (B-238).
        // `hasOwn`, not a plain index: `constructor` is a valid property key, and indexing the
        // object literal with it returned `Object` itself, spliced into the SQL as a 500.
        const column = Object.hasOwn(TEXT_COLUMN_PROPS, k) ? TEXT_COLUMN_PROPS[k] : undefined;
        if (column) {
          conditions.push(`b.${column} = ?`);
          params.push(v);
          continue;
        }
        conditions.push(
          "EXISTS (SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = ? AND bp.value = ?)",
        );
        params.push(k, v);
      }

      const ftsRanked: string[] = [];
      const ftsMeta = new Map<string, { snip: string; rank: number }>();
      if (modeUsed !== "semantic" && ftsQuery !== null) {
        const sql = `SELECT b.id AS id, bm25(block_fts) AS rank, snippet(block_fts, 0, '**', '**', '...', ${snippetTokens}) AS snip
                     FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
                     WHERE block_fts MATCH ? AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
        const rows = driver.all<{ id: string; rank: number; snip: string }>(sql, [
          ftsQuery,
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
          pageName: wirePageNameOf(page),
          journalDate: page.journal_day !== null ? wirePageNameOf(page) : undefined,
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
      if (modeUsed !== "semantic" && ftsQuery !== null) {
        const sql = `SELECT p.id AS id, bm25(page_fts) AS rank
                     FROM page_fts JOIN page p ON p.rowid = page_fts.rowid
                     WHERE page_fts MATCH ? AND ${conditions.join(" AND ")} ORDER BY rank LIMIT 500`;
        const rows = driver.all<{ id: string; rank: number }>(sql, [ftsQuery, ...params]);
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
          pageName: wirePageNameOf(p),
          journalDate: p.journal_day !== null ? wirePageNameOf(p) : undefined,
          snippet: wirePageNameOf(p),
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
      fallback,
    };
  },
});
