/**
 * Keyword search over this device's replica (server-search): the replica's own FTS5 index
 * (`../db/schema-client.ts#ensureClientSearchIndex`), the same query grammar as the server's
 * `search` op (`@nooklet/core`'s `toFtsQuery`), and the same hit shape, so the Search view renders
 * either without caring which answered.
 *
 * Local-first: this is what the Search view shows the moment something is typed — online or not,
 * connected to a server or not. The server's semantic matches are added on top when they arrive
 * (`./search-session.ts`); they never stand in front of this.
 *
 * Mirrors `packages/server/src/ops/search.ts`'s keyword path, with one approximation: the `tags`
 * filter. The server reads its `ref` table, which the replica does not have (sql-schema.md rule 1),
 * so here a tag is matched by extracting the block's own tags from its text (`extractRefs`) plus
 * `Task` for a block with a marker — what `ref` holds for a block's text. A `tags::` block property
 * is not seen. Close enough for a filter; the server's answer, when it comes, is exact.
 */

import {
  extractRefs,
  isoJournalName,
  normalizePageName,
  TASK_TAG,
  toFtsQuery,
} from "@nooklet/core";
import { queryAs } from "../db/client.js";
import type { SearchHit, SearchInput, SearchResult } from "./api-client.js";

/** `properties` keys stored in a `block` column rather than `block_prop` (as on the server). */
const TEXT_COLUMN_PROPS: Readonly<Record<string, string>> = {
  marker: "marker",
  priority: "priority",
  repeat: "repeat",
};

/** FTS candidates read before the JS-side tag filter and the limit — the server's number. */
const CANDIDATES = 500;
/** `snippet()`'s token count for the server's default 200 characters (200 / 8). */
const SNIPPET_TOKENS = 25;

interface BlockRowHit {
  id: string;
  parent_id: string | null;
  content: string;
  marker: string | null;
  updated_at: number;
  page_name: string;
  journal_day: number | null;
  snip: string;
}

interface PageRowHit {
  id: string;
  name: string;
  journal_day: number | null;
  updated_at: number;
}

function wireName(name: string, journalDay: number | null): string {
  return journalDay !== null ? isoJournalName(journalDay) : name;
}

function msOrUndefined(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function blockHasTags(row: BlockRowHit, wanted: readonly string[]): boolean {
  const tags = new Set(extractRefs(row.content).tags.map(normalizePageName));
  if (row.marker !== null) tags.add(normalizePageName(TASK_TAG));
  return wanted.every((t) => tags.has(normalizePageName(t)));
}

/** Breadcrumbs (ancestors' first lines, root first) for many blocks in one recursive query rather
 * than one walk per hit — each read is a round trip to the DB worker. */
async function breadcrumbs(hits: readonly BlockRowHit[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const withParent = hits.filter((h) => h.parent_id !== null);
  if (withParent.length === 0) return out;
  const rows = await queryAs<{ hit: string; content: string; depth: number }>(
    `WITH RECURSIVE anc(hit, parent_id, content, depth) AS (
       SELECT h.value, p.parent_id, p.content, 1
         FROM json_each(?) h JOIN block b ON b.id = h.value JOIN block p ON p.id = b.parent_id
       UNION ALL
       SELECT anc.hit, p.parent_id, p.content, anc.depth + 1
         FROM anc JOIN block p ON p.id = anc.parent_id
        WHERE anc.depth < 100
     )
     SELECT hit, content, depth FROM anc ORDER BY hit, depth DESC`,
    [JSON.stringify(withParent.map((h) => h.id))],
  );
  for (const r of rows) {
    const chain = out.get(r.hit) ?? [];
    chain.push((r.content.split("\n")[0] ?? "").trim());
    out.set(r.hit, chain);
  }
  return out;
}

async function searchBlocks(input: SearchInput, match: string): Promise<SearchHit[]> {
  const conditions = ["b.deleted_at IS NULL", "p.deleted_at IS NULL"];
  const params: unknown[] = [match];
  if (input.namespace) {
    const ns = normalizePageName(input.namespace);
    conditions.push("(p.key = ? OR p.key LIKE ?)");
    params.push(ns, `${ns}/%`);
  }
  if (input.journalsOnly) conditions.push("p.journal_day IS NOT NULL");
  const after = msOrUndefined(input.updatedAfter);
  if (after !== undefined) {
    conditions.push("b.updated_at > ?");
    params.push(after);
  }
  const before = msOrUndefined(input.updatedBefore);
  if (before !== undefined) {
    conditions.push("b.updated_at < ?");
    params.push(before);
  }
  for (const [k, v] of Object.entries(input.properties ?? {})) {
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
  params.push(CANDIDATES);

  let rows = await queryAs<BlockRowHit>(
    `SELECT b.id, b.parent_id, b.content, b.marker, b.updated_at,
            p.name AS page_name, p.journal_day,
            snippet(block_fts, 0, '**', '**', '...', ${SNIPPET_TOKENS}) AS snip
       FROM block_fts JOIN block b ON b.rowid = block_fts.rowid JOIN page p ON p.id = b.page_id
      WHERE block_fts MATCH ? AND ${conditions.join(" AND ")}
      ORDER BY bm25(block_fts) LIMIT ?`,
    params,
  );
  const tags = input.tags?.filter((t) => t.trim() !== "") ?? [];
  if (tags.length > 0) rows = rows.filter((r) => blockHasTags(r, tags));
  rows = rows.slice(0, input.limit ?? 50);

  const crumbs = await breadcrumbs(rows);
  return rows.map((r, i) => {
    const page = wireName(r.page_name, r.journal_day);
    return {
      kind: "block",
      id: r.id,
      page,
      journalDate: r.journal_day !== null ? page : undefined,
      snippet: r.snip,
      breadcrumb: crumbs.get(r.id) ?? [],
      // Rank order only: bm25 values do not compare across queries, and the merge with the
      // server's hits goes by position, not by score.
      score: 1 / (1 + i),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
}

async function searchPages(input: SearchInput, match: string): Promise<SearchHit[]> {
  const conditions = ["p.deleted_at IS NULL"];
  if (input.journalsOnly) conditions.push("p.journal_day IS NOT NULL");
  const rows = await queryAs<PageRowHit>(
    `SELECT p.id, p.name, p.journal_day, p.updated_at
       FROM page_fts JOIN page p ON p.rowid = page_fts.rowid
      WHERE page_fts MATCH ? AND ${conditions.join(" AND ")}
      ORDER BY bm25(page_fts) LIMIT ?`,
    [match, input.limit ?? 50],
  );
  return rows.map((r, i) => {
    const page = wireName(r.name, r.journal_day);
    return {
      kind: "page",
      id: r.id,
      page,
      journalDate: r.journal_day !== null ? page : undefined,
      snippet: page,
      breadcrumb: [],
      score: 1 / (1 + i),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
}

/**
 * Keyword hits from the replica, blocks first then pages (the order the server's keyword mode
 * produces, so switching between the two does not reshuffle). `modeUsed` is always `keyword`.
 *
 * Rejects when the replica has no FTS index (a SQLite without FTS5 — not the case for any build
 * this app ships, `tools/probes/client-fts-cost.mjs`); the view says search is unavailable here.
 */
export async function searchLocal(input: SearchInput): Promise<SearchResult> {
  const match = toFtsQuery(input.query);
  if (match === null) return { hits: [], modeUsed: "keyword" };
  const scope = input.scope ?? "all";
  // A tag or property filter is about blocks: the server's page search ignores both too.
  const [blocks, pages] = await Promise.all([
    scope === "pages" ? [] : searchBlocks(input, match),
    scope === "blocks" ? [] : searchPages(input, match),
  ]);
  const limit = input.limit ?? 50;
  return { hits: [...blocks, ...pages].slice(0, limit), modeUsed: "keyword" };
}

/**
 * Which of `hits` this replica can open: `live` (there, not deleted), `deleted` (deleted here —
 * this device's state is newer than the server's answer, so the hit is dropped) or `absent` (not
 * synced yet). A server hit names an id; only the replica can say whether that id opens here.
 */
export async function presenceOnDevice(
  hits: readonly Pick<SearchHit, "kind" | "id">[],
): Promise<Map<string, "live" | "deleted">> {
  const out = new Map<string, "live" | "deleted">();
  const blockIds = hits.filter((h) => h.kind === "block").map((h) => h.id);
  const pageIds = hits.filter((h) => h.kind === "page").map((h) => h.id);
  const [blocks, pages] = await Promise.all([
    blockIds.length === 0
      ? []
      : queryAs<{ id: string; gone: number }>(
          `SELECT b.id, (b.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS gone
             FROM json_each(?) j JOIN block b ON b.id = j.value JOIN page p ON p.id = b.page_id`,
          [JSON.stringify(blockIds)],
        ),
    pageIds.length === 0
      ? []
      : queryAs<{ id: string; gone: number }>(
          `SELECT p.id, (p.deleted_at IS NOT NULL) AS gone
             FROM json_each(?) j JOIN page p ON p.id = j.value`,
          [JSON.stringify(pageIds)],
        ),
  ]);
  for (const r of blocks) out.set(`block:${r.id}`, r.gone ? "deleted" : "live");
  for (const r of pages) out.set(`page:${r.id}`, r.gone ? "deleted" : "live");
  return out;
}
