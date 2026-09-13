/**
 * Evaluating a ```` ```query ```` fence (ADR 011; language in `@nooklet/core`'s `query.ts`)
 * against the LOCAL replica — the same SQLite tables `store.ts` reads — so a query works offline
 * and re-runs the moment the graph changes, with no server round trip.
 *
 * Two-stage evaluation, because the client schema has no `ref` table (docs/spec/sql-schema.md
 * rule 1): `queryPrefilter` turns the query into a SQL condition that every matching block
 * satisfies (marker/priority/date columns, page key, "content could hold a reference"), SQLite
 * narrows the candidates, then `matchQuery` applies the exact semantics in JavaScript
 * (`extractRefs` over the block text, property values, timezone-correct days). Task queries —
 * the vast majority of what people write, research/13 §2.2 — are cut down to a few hundred rows
 * by the indexed `marker` column before any JavaScript runs.
 *
 * Reactivity follows `store.ts`'s idiom: the resource's source returns a *fresh object* carrying
 * a version counter, because Solid only refetches when the source value changes and a stable
 * scalar source never does (see `stamped` there — the bug that motivated it took six resources
 * with it). The worker's change bus takes one listener and `store.ts` owns it, so this file goes
 * through `stampedFor` rather than subscribing itself.
 */

import {
  classifyBlockContent,
  compareForQuery,
  matchQuery,
  type Priority,
  type Query,
  type QueryBlock,
  queryNeedsProperties,
  queryPrefilter,
  type TaskMarker,
  todayJournalDay,
} from "@nooklet/core";
import { type Accessor, createResource, type Resource } from "solid-js";
import { queryAs } from "../db/client.js";
import { stampedFor } from "./store.js";

/** Rows SQLite hands to JavaScript at most; past this the result carries `truncated: true` and
 * says so. A query broad enough to hit it (`řeka` alone over a 17k-block graph) is still
 * answered, just not exhaustively. */
export const QUERY_CANDIDATE_CAP = 20_000;
/** Hits rendered when the query has no `limit:`. */
export const QUERY_DEFAULT_LIMIT = 200;
/** How deep below a hit its children are shown. */
export const QUERY_CHILD_DEPTH = 3;
/** Descendants shown per hit, at most. */
export const QUERY_CHILD_CAP = 60;

export interface QueryResultBlock {
  id: string;
  pageId: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  children: QueryResultBlock[];
}

export interface QueryPageGroup {
  pageId: string;
  pageName: string;
  pageJournalDay: number | null;
  hits: QueryResultBlock[];
}

export interface QueryResults {
  /** Blocks the query matched (before `limit:`). */
  matched: number;
  /** Hits actually listed (after `limit:`), counting those folded under an ancestor hit. */
  shown: number;
  /** Hits not listed on their own because an ancestor is also a hit — they appear nested. */
  nested: number;
  groups: QueryPageGroup[];
  /** `QUERY_CANDIDATE_CAP` was reached: `matched` is a lower bound. */
  truncated: boolean;
}

interface CandidateRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  scheduled_day: number | null;
  deadline_day: number | null;
  due_day: number | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
  page_name: string;
  page_key: string;
  page_journal_day: number | null;
}

interface PropRow {
  block_id: string;
  key: string;
  value: string;
}

interface ChildRow {
  root: string;
  id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  page_id: string;
}

type Candidate = QueryBlock & { pageId: string; orderKey: string };

function isQueryFence(content: string): boolean {
  // Cheap gate first; `classifyBlockContent` is the grammar's own answer (CLS-F, §2.7).
  if (!content.startsWith("```") && !content.startsWith("~~~")) return false;
  const c = classifyBlockContent(content);
  return c.kind === "fence" && c.lang === "query";
}

const CANDIDATE_SELECT = `SELECT b.id, b.page_id, b.parent_id, b.order_key, b.content, b.marker, b.priority,
    b.scheduled_day, b.deadline_day, b.due_day, b.done_at, b.created_at, b.updated_at,
    p.name AS page_name, p.key AS page_key, p.journal_day AS page_journal_day
  FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
  WHERE b.deleted_at IS NULL AND `;

export type SqlRunner = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** One evaluation. `today`/`sql` are injectable for tests; production callers pass nothing. */
export async function runQuery(
  query: Query,
  opts: { today?: number; sql?: SqlRunner } = {},
): Promise<QueryResults> {
  const sql: SqlRunner = opts.sql ?? queryAs;
  const env = { today: opts.today ?? todayJournalDay() };
  const pre = queryPrefilter(query.where, env);

  const rows = await sql<CandidateRow>(`${CANDIDATE_SELECT}${pre.sql} LIMIT ?`, [
    ...pre.params,
    QUERY_CANDIDATE_CAP + 1,
  ]);
  const truncated = rows.length > QUERY_CANDIDATE_CAP;
  if (truncated) rows.length = QUERY_CANDIDATE_CAP;

  const props = new Map<string, Record<string, string>>();
  if (rows.length > 0 && queryNeedsProperties(query.where)) {
    // Same prefilter, so the property rows are exactly those of the candidates — no id list to
    // ship back across the worker boundary.
    const propRows = await sql<PropRow>(
      `SELECT bp.block_id, bp.key, bp.value FROM block_prop bp
         JOIN block b ON b.id = bp.block_id
         JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
       WHERE b.deleted_at IS NULL AND bp.value IS NOT NULL AND ${pre.sql}`,
      pre.params,
    );
    for (const r of propRows) {
      let m = props.get(r.block_id);
      if (!m) {
        m = {};
        props.set(r.block_id, m);
      }
      m[r.key] = r.value;
    }
  }

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    pageId: r.page_id,
    orderKey: r.order_key,
    content: r.content,
    marker: r.marker,
    priority: r.priority,
    scheduledDay: r.scheduled_day,
    deadlineDay: r.deadline_day,
    dueDay: r.due_day,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pageName: r.page_name,
    pageKey: r.page_key,
    pageJournalDay: r.page_journal_day,
    properties: props.get(r.id) ?? {},
  }));

  // A query block is never a result — least of all its own: `text:work` would otherwise list the
  // fence that says `text:work`, and two queries could match each other forever.
  const matched = candidates.filter(
    (b) => !isQueryFence(b.content) && matchQuery(query.where, b, env),
  );
  matched.sort(
    compareForQuery(query.sort, env, (a, b) => {
      const x = a as Candidate;
      const y = b as Candidate;
      if (x.orderKey !== y.orderKey) return x.orderKey < y.orderKey ? -1 : 1;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    }),
  );

  const limit = query.limit ?? QUERY_DEFAULT_LIMIT;
  const shown = matched.slice(0, limit);
  const tree: Map<string, Subtree> =
    shown.length > 0
      ? await fetchChildren(
          sql,
          shown.map((b) => b.id),
        )
      : new Map();

  // A hit whose ancestor is also a hit is shown once, nested under that ancestor, rather than
  // listed twice — a project TODO with TODO subtasks is the common case.
  const inSubtreeOf = (ancestor: string, id: string): boolean =>
    tree.get(ancestor)?.rows.some((row) => row.id === id) ?? false;
  const nestedIds = new Set<string>();
  for (const [root, sub] of tree) {
    for (const row of sub.rows)
      if (row.id !== root && sub.hitIds.has(row.id)) nestedIds.add(row.id);
  }

  // Being in an ancestor hit's subtree is not the same as being rendered there: `toResultBlock`
  // stops at `QUERY_CHILD_CAP` descendants. A TODO subtask after the first 60 notes of a TODO
  // project was folded under the project, cut from it, and so listed nowhere while the header
  // still counted it (B-133). Render the outermost hits first, then list on its own any hit that
  // none of them actually emitted — outermost of those first, since each one rendered can bring
  // its own nested hits back into view.
  const emitted = new Set<string>();
  const listed = new Map<string, QueryResultBlock>();
  const list = (b: Candidate): void => {
    listed.set(b.id, toResultBlock(b, tree.get(b.id)?.rows ?? [], emitted));
  };
  for (const b of shown) if (!nestedIds.has(b.id)) list(b);
  let cut = shown.filter((b) => !listed.has(b.id) && !emitted.has(b.id));
  while (cut.length > 0) {
    // Never empty: the subtree relation is a tree, so some cut hit is inside no other cut hit's.
    const outermost = cut.filter((b) => !cut.some((a) => a !== b && inSubtreeOf(a.id, b.id)));
    for (const b of outermost) list(b);
    cut = cut.filter((b) => !listed.has(b.id) && !emitted.has(b.id));
  }

  const groups: QueryPageGroup[] = [];
  const byPage = new Map<string, QueryPageGroup>();
  for (const b of shown) {
    const hit = listed.get(b.id);
    if (!hit) continue;
    let g = byPage.get(b.pageId);
    if (!g) {
      g = { pageId: b.pageId, pageName: b.pageName, pageJournalDay: b.pageJournalDay, hits: [] };
      byPage.set(b.pageId, g);
      groups.push(g);
    }
    g.hits.push(hit);
  }

  return {
    matched: matched.length,
    shown: shown.length,
    nested: shown.length - listed.size,
    groups,
    truncated,
  };
}

interface Subtree {
  rows: ChildRow[];
  hitIds: Set<string>;
}

async function fetchChildren(sql: SqlRunner, ids: string[]): Promise<Map<string, Subtree>> {
  const rows = await sql<ChildRow>(
    `WITH RECURSIVE sub(id, root, depth) AS (
       SELECT id, id, 0 FROM block WHERE id IN (${ids.map(() => "?").join(",")})
       UNION ALL
       SELECT c.id, s.root, s.depth + 1 FROM block c JOIN sub s ON c.parent_id = s.id
       WHERE c.deleted_at IS NULL AND s.depth < ?
     )
     SELECT s.root AS root, b.id, b.parent_id, b.order_key, b.content, b.marker, b.priority, b.page_id
     FROM sub s JOIN block b ON b.id = s.id
     WHERE s.depth > 0
     ORDER BY s.root, s.depth, b.order_key`,
    [...ids, QUERY_CHILD_DEPTH],
  );
  const hitIds = new Set(ids);
  const out = new Map<string, Subtree>();
  for (const r of rows) {
    let s = out.get(r.root);
    if (!s) {
      s = { rows: [], hitIds };
      out.set(r.root, s);
    }
    s.rows.push(r);
  }
  return out;
}

function toResultBlock(
  b: {
    id: string;
    pageId: string;
    content: string;
    marker: TaskMarker | null;
    priority: Priority | null;
  },
  descendants: ChildRow[],
  /** Every descendant id actually emitted is added here (the cap may cut the rest). */
  emitted: Set<string>,
): QueryResultBlock {
  const byParent = new Map<string, ChildRow[]>();
  for (const r of descendants) {
    const list = byParent.get(r.parent_id ?? "") ?? [];
    list.push(r);
    byParent.set(r.parent_id ?? "", list);
  }
  let budget = QUERY_CHILD_CAP;
  const build = (parentId: string): QueryResultBlock[] => {
    const rows = (byParent.get(parentId) ?? []).sort((x, y) =>
      x.order_key < y.order_key ? -1 : 1,
    );
    const out: QueryResultBlock[] = [];
    for (const r of rows) {
      if (budget <= 0) break;
      budget--;
      emitted.add(r.id);
      out.push({
        id: r.id,
        pageId: r.page_id,
        content: r.content,
        marker: r.marker,
        priority: r.priority,
        children: build(r.id),
      });
    }
    return out;
  };
  return {
    id: b.id,
    pageId: b.pageId,
    content: b.content,
    marker: b.marker,
    priority: b.priority,
    children: build(b.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Reactive wrapper
// ---------------------------------------------------------------------------------------------

/** Live results for a parsed query; `undefined` query = nothing to run. Refetches after every
 * local or pulled write to `block`/`block_prop`/`page` (the tables a query can read). Read
 * `.latest` to keep the previous result on screen while a refetch runs. */
export function useQueryResults(
  query: Accessor<Query | undefined>,
): Resource<QueryResults | undefined> {
  const [resource] = createResource(
    () => {
      const q = query();
      if (!q) return undefined;
      return stampedFor(q, ["block", "block_prop", "page"]);
    },
    ({ value: q }) => runQuery(q),
  );
  return resource;
}
