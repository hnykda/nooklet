/**
 * `graph.links` — the page-to-page link graph: one node per page, one edge per "page A's blocks
 * reference page B".
 *
 * Why it is a server op. `ref` is a server-only derived table (docs/spec/sql-schema.md rule 1);
 * the client's SQLite replica carries `page`/`block` but nothing derived, so a client cannot
 * compute a single edge on its own. Exactly the reason `search` and `page.backlinks` go over HTTP
 * too. The web client's graph view (`apps/web/src/views/GraphView.tsx`) is the main caller; an
 * agent can use it to ask what the graph is *shaped* like ("which pages are hubs?") rather than
 * what it says, which is what `search` is for.
 *
 * Journals are excluded by default, and that is a bigger filter than it looks: in a daily-notes
 * graph most links are *written* in journal entries, so dropping journal nodes also drops every
 * reference whose source block lives on one. Excluding them leaves the page-to-page skeleton,
 * which is the useful picture; including them gives you the full thing plus several hundred
 * date nodes. `note` says which of the two you got.
 */

import { z } from "zod";
import { wirePageNameOf } from "../rows.js";
import { defineOp } from "./registry.js";

/** Nodes returned at most. Not `schemas.ts`'s shared `Limit` (max 500): a graph is useless cut to
 * 500 pages, and the caller is a renderer, not a paginating reader — there is no cursor here. */
const NodeLimit = z
  .number()
  .int()
  .min(1)
  .max(5000)
  .default(1500)
  .describe("Max nodes (default 1500, max 5000); the most-connected pages are kept");

export const graphLinks = defineOp({
  name: "graph.links",
  summary: "Page-to-page link graph (nodes and edges)",
  description:
    "Returns the whole graph as nodes (pages) and edges (references between them), for drawing a " +
    "graph view or for finding hubs and clusters. An edge from A to B means some block on page A " +
    "references page B via [[link]], #tag, or a block ref. Journals are excluded unless " +
    "include_journals is true - note that this also drops references written in journal entries, " +
    "which in a daily-notes graph is most of them. Capped at limit nodes, keeping the " +
    "most-connected ones; truncated and note say what was left out. This is structure only: it " +
    "returns no block text, so use page_backlinks to see what a link actually says.",
  input: z
    .object({
      include_journals: z
        .boolean()
        .default(false)
        .describe("Include journal pages, and the references written in them"),
      limit: NodeLimit,
    })
    .strict(),
  output: z.object({
    nodes: z.array(
      z.object({
        id: z.string().describe("Page id"),
        name: z.string().describe("Page name; a journal's ISO date, per rule 18"),
        is_journal: z.boolean(),
        ref_count: z
          .number()
          .int()
          .describe("References touching this page, incoming plus outgoing, before any cap"),
      }),
    ),
    edges: z.array(
      z.object({
        from: z.string().describe("Page id the reference was written on"),
        to: z.string().describe("Page id it points at"),
        count: z.number().int().describe("How many references, so an edge can be weighted"),
      }),
    ),
    total_nodes: z.number().int().describe("Pages that matched before limit was applied"),
    total_edges: z.number().int(),
    truncated: z.boolean(),
    note: z
      .string()
      .optional()
      .describe("Present when something was left out of nodes/edges; says what and why"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    `${out.nodes.length} page(s), ${out.edges.length} link(s)` +
    (out.truncated ? ` (truncated from ${out.total_nodes})` : "") +
    (out.note ? ` - ${out.note}` : ""),
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const notJournal = (alias: string): string =>
      input.include_journals ? "" : ` AND ${alias}.journal_day IS NULL`;

    // Resolve the destination through `page.key`, NOT through `ref.dst_page_id`. Rule 11 makes
    // `dst_page_id` a denormalized convenience column that is NULL until the target page exists
    // and only becomes correct when rule 18's refresh runs on page creation; `dst_page_key` is
    // the normalized name as written and is always right. Joining on the key also means the
    // (unique, partial) `page_key` index does the work, and a page referenced before it existed
    // shows up the moment it does.
    //
    // `dp.id != r.src_page_id` drops self-links: a page that links itself draws a loop that says
    // nothing, and it would inflate that node's degree against every other node's.
    //
    // The join to `block` is not decoration. Deletes here are soft, and `rebuildRefRows`
    // (../apply-ops.ts) re-extracts from a soft-deleted block's still-present content, so `ref`
    // keeps rows for blocks nobody can see any more. Filter them at read time, exactly as
    // `page.backlinks` does — otherwise deleting the one bullet that said `[[Aurora]]` leaves the
    // edge drawn for ever.
    const edgeRows = driver.all<{ from_id: string; to_id: string; n: number }>(
      `SELECT r.src_page_id AS from_id, dp.id AS to_id, COUNT(*) AS n
       FROM ref r
       JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
       JOIN page sp ON sp.id = r.src_page_id AND sp.deleted_at IS NULL${notJournal("sp")}
       JOIN page dp ON dp.key = r.dst_page_key AND dp.deleted_at IS NULL${notJournal("dp")}
       WHERE r.dst_page_key IS NOT NULL AND dp.id != r.src_page_id
       GROUP BY r.src_page_id, dp.id`,
    );

    const pageRows = driver.all<{ id: string; name: string; journal_day: number | null }>(
      `SELECT id, name, journal_day FROM page WHERE deleted_at IS NULL${notJournal("page")}`,
    );

    const degree = new Map<string, number>();
    for (const e of edgeRows) {
      degree.set(e.from_id, (degree.get(e.from_id) ?? 0) + e.n);
      degree.set(e.to_id, (degree.get(e.to_id) ?? 0) + e.n);
    }

    // Sort by degree so that capping keeps the pages that carry the structure and throws away
    // leaves and orphans, rather than whatever the page table happened to return first. Pages
    // with no links at all are included while there is room: they are part of "what is in here",
    // and they are the first thing a cap should drop.
    const ranked = pageRows
      .map((p) => ({
        id: p.id,
        name: wirePageNameOf(p),
        is_journal: p.journal_day !== null,
        ref_count: degree.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.ref_count - a.ref_count || a.name.localeCompare(b.name));

    const nodes = ranked.slice(0, input.limit);
    const kept = new Set(nodes.map((n) => n.id));
    const edges = edgeRows
      .filter((e) => kept.has(e.from_id) && kept.has(e.to_id))
      .map((e) => ({ from: e.from_id, to: e.to_id, count: e.n }));

    const truncated = nodes.length < ranked.length;
    const notes: string[] = [];
    if (truncated) {
      notes.push(
        `showing the ${nodes.length} most-connected of ${ranked.length} pages; ` +
          `${edgeRows.length - edges.length} link(s) to the rest are not drawn`,
      );
    }
    if (!input.include_journals) {
      const journals =
        driver.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM page WHERE deleted_at IS NULL AND journal_day IS NOT NULL",
        )?.n ?? 0;
      if (journals > 0) {
        notes.push(
          `${journals} journal page(s) and the references written in them are excluded ` +
            "(include_journals: true to show them)",
        );
      }
    }

    return {
      nodes,
      edges,
      total_nodes: ranked.length,
      total_edges: edgeRows.length,
      truncated,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    };
  },
});
