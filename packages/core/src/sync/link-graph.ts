/**
 * The page-to-page link graph over the reference index (`./ref-index.ts`): one node per page, one
 * edge per "page A's blocks reference page B". The server's `graph.links` op and a client
 * replica's graph view (B-641) both read it here.
 *
 * Journals are excluded by default, and that is a bigger filter than it looks: in a daily-notes
 * graph most links are *written* in journal entries, so dropping journal nodes also drops every
 * reference whose source block lives on one. `note` says which of the two you got.
 */

import { isoJournalName } from "../journal.js";
import type { SqlDriver } from "./driver.js";

export interface LinkGraph {
  nodes: Array<{ id: string; name: string; is_journal: boolean; ref_count: number }>;
  edges: Array<{ from: string; to: string; count: number }>;
  total_nodes: number;
  total_edges: number;
  truncated: boolean;
  note?: string;
}

function wirePageNameOf(row: { name: string; journal_day: number | null }): string {
  return row.journal_day !== null ? isoJournalName(row.journal_day) : row.name;
}

/** `limit`: nodes kept at most, the most-connected first (the server's default is 1500). */
export function linkGraph(
  driver: SqlDriver,
  input: { includeJournals: boolean; limit: number },
): LinkGraph {
  const limit = input.limit;
  const notJournal = (alias: string): string =>
    input.includeJournals ? "" : ` AND ${alias}.journal_day IS NULL`;

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

  const nodes = ranked.slice(0, limit);
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
  if (!input.includeJournals) {
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
}
