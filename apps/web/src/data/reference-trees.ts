/**
 * What the references panel needs to show a reference the way its page shows it (B-550): the
 * block's full content, its children, and its parents for a breadcrumb — read from the LOCAL
 * replica. `page.backlinks` answers from the server with each block's id, page and first line only
 * (the client schema has no `ref`/`path_ref` table, so which blocks reference a page has to come
 * from there); everything about how those blocks look is already here.
 *
 * One read per list of references, whatever its length — the owner's busiest page has 1,074 — in
 * four queries: every reference's ancestor chain, the subtrees under the references no other
 * reference contains, those blocks' properties, and the text of the ancestors for breadcrumbs.
 *
 * Why subtrees only under "outermost" references: a linked reference is a `path_ref` row, and
 * every descendant of a block that links a page is itself a linked reference of it
 * (docs/spec/sql-schema.md rule 12). On the real graph `@alex` has 756 linked references and 91
 * of them are not inside another; the other 665 are those 91's descendants. Fetching a subtree per
 * reference would read the same blocks hundreds of times; the outermost references' subtrees
 * already hold every other one, which `nodes` indexes by id.
 *
 * Reactivity is `store.ts`'s idiom (`stampedFor`), like `./embeds.ts`: any write to blocks, their
 * properties or pages re-reads. The loader never rejects — an errored Solid resource re-throws on
 * read — so a failure comes back as `{ status: "failed" }` and the panel falls back to one line per
 * reference.
 */

import { type BlockSqlRow, toBlockRow } from "@nooklet/core";
import { type Accessor, createMemo, createResource, type Resource } from "solid-js";
import { queryAs } from "../db/client.js";
import { deriveNumbering, isNumbered } from "../editor/numbering.js";
import { stampedFor } from "./store.js";
import type { BlockTreeNode } from "./types.js";

/** Blocks read below the outermost references at most, shallowest first. Linked references are
 * bounded anyway (a subtree under a linked reference is linked references); this is for unlinked
 * mentions, whose subtrees are not, and for a graph shaped nothing like the owner's. */
export const REFERENCE_TREE_ROW_CAP = 20_000;

/** Ancestor walk guard: real outlines are under ~20 levels (sql-schema.md rule 12's own bound). */
const MAX_ANCESTOR_DEPTH = 1000;

export type ReferenceTrees =
  | {
      status: "ok";
      /** The ids this read was asked about, so a caller can tell "not in the replica" (asked, no
       * node) from "asked before this reference existed" (not asked yet). */
      requested: ReadonlySet<string>;
      /** Every requested id's ancestors, nearest first; absent for a block not in the replica. */
      ancestors: ReadonlyMap<string, readonly string[]>;
      /** Every block read — the outermost references and everything under them — children nested
       * in page order, by id. */
      nodes: ReadonlyMap<string, BlockTreeNode>;
      /** The text of every ancestor that is not itself in `nodes`, for breadcrumbs. */
      ancestorText: ReadonlyMap<string, string>;
      /** `list:: number` ordinals of the numbered outermost references, counted among their
       * siblings on their own page (B-551). */
      rootOrdinals?: ReadonlyMap<string, number>;
    }
  | { status: "failed"; message: string };

export type SqlRunner = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** One read for `ids` (the blocks of one references list). Exported for tests; views use
 * `useReferenceTrees`. */
export async function loadReferenceTrees(
  ids: readonly string[],
  sql: SqlRunner = queryAs,
): Promise<ReferenceTrees> {
  const requested = new Set(ids);
  try {
    // Ids go over as ONE JSON parameter (`json_each`), not a placeholder each: a list can be 5,000
    // long, and one string crosses the worker boundary as cheaply as it binds.
    const idsJson = JSON.stringify([...requested]);

    // 1. Which requested blocks are live here, and each one's ancestor chain. The walk does not
    //    stop at deleted ancestors: the chain is only used to fold references into each other and
    //    to label them, and a gap in it would do both wrong.
    const live = await sql<{ id: string }>(
      `SELECT id FROM block WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
      [idsJson],
    );
    const chainRows = await sql<{ start: string; id: string; depth: number }>(
      `WITH RECURSIVE up(start, id, depth) AS (
         SELECT b.id, b.parent_id, 1 FROM block b
         WHERE b.id IN (SELECT value FROM json_each(?)) AND b.deleted_at IS NULL
           AND b.parent_id IS NOT NULL
         UNION ALL
         SELECT u.start, b.parent_id, u.depth + 1 FROM up u JOIN block b ON b.id = u.id
         WHERE b.parent_id IS NOT NULL AND u.depth < ?
       )
       SELECT start, id, depth FROM up ORDER BY start, depth`,
      [idsJson, MAX_ANCESTOR_DEPTH],
    );
    const ancestors = new Map<string, string[]>();
    for (const r of live) ancestors.set(r.id, []);
    for (const r of chainRows) ancestors.get(r.start)?.push(r.id);

    // 2. The outermost references: live, with no ancestor that is also requested.
    const outermost = [...ancestors.entries()]
      .filter(([, chain]) => !chain.some((a) => requested.has(a)))
      .map(([id]) => id);
    const outermostJson = JSON.stringify(outermost);
    const subtree = `WITH RECURSIVE sub(id, depth) AS (
         SELECT value, 0 FROM json_each(?)
         UNION ALL
         SELECT c.id, s.depth + 1 FROM block c JOIN sub s ON c.parent_id = s.id
         WHERE c.deleted_at IS NULL
       )`;
    const rows = await sql<BlockSqlRow>(
      `${subtree}
       SELECT b.* FROM sub s JOIN block b ON b.id = s.id
       ORDER BY s.depth LIMIT ?`,
      [outermostJson, REFERENCE_TREE_ROW_CAP],
    );
    // 3. Their generic properties (`block_prop`, non-null values: a null is a removed key's
    //    tombstone). Same recursion rather than shipping the ids back.
    const propRows = await sql<{ block_id: string; key: string; value: string }>(
      `${subtree}
       SELECT bp.block_id, bp.key, bp.value FROM sub s JOIN block_prop bp ON bp.block_id = s.id
       WHERE bp.value IS NOT NULL`,
      [outermostJson],
    );

    const properties = new Map<string, Record<string, string>>();
    for (const r of propRows) {
      const bag = properties.get(r.block_id);
      if (bag) bag[r.key] = r.value;
      else properties.set(r.block_id, { [r.key]: r.value });
    }
    const nodes = new Map<string, BlockTreeNode>();
    for (const r of rows) {
      nodes.set(r.id, { ...toBlockRow(r), properties: properties.get(r.id) ?? {}, children: [] });
    }
    // Children in page order: `order_key`, then id (00-conventions.md), as `data/tree.ts` sorts.
    const byOrder = [...nodes.values()].sort(
      (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) || (a.id < b.id ? -1 : 1),
    );
    const outermostSet = new Set(outermost);
    for (const node of byOrder) {
      if (outermostSet.has(node.id) || node.parentId === null) continue;
      nodes.get(node.parentId)?.children.push(node);
    }

    // 4. Breadcrumb text: every ancestor of a requested block that was not read above.
    const ancestorIds = new Set<string>();
    for (const chain of ancestors.values()) {
      for (const a of chain) if (!nodes.has(a)) ancestorIds.add(a);
    }
    const ancestorText = new Map<string, string>();
    if (ancestorIds.size > 0) {
      const textRows = await sql<{ id: string; content: string }>(
        `SELECT id, content FROM block WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify([...ancestorIds])],
      );
      for (const r of textRows) ancestorText.set(r.id, r.content);
    }

    // 5. Numbered outermost references: their ordinal depends on the siblings on their page, which
    //    nothing above read (B-551). One read for all of them; `IS` so top-level blocks (NULL
    //    parent) match each other.
    const rootOrdinals = new Map<string, number>();
    const numberedRoots = outermost.filter((id) => isNumbered(nodes.get(id)));
    if (numberedRoots.length > 0) {
      const sibRows = await sql<{ root: string; id: string; list: string | null }>(
        `SELECT r.value AS root, s.id AS id,
                (SELECT bp.value FROM block_prop bp WHERE bp.block_id = s.id AND bp.key = 'list') AS list
         FROM json_each(?) r
         JOIN block b ON b.id = r.value
         JOIN block s ON s.page_id = b.page_id AND s.parent_id IS b.parent_id AND s.deleted_at IS NULL
         ORDER BY r.value, s.order_key, s.id`,
        [JSON.stringify(numberedRoots)],
      );
      const groups = new Map<string, { id: string; list: string | null }[]>();
      for (const r of sibRows) {
        const g = groups.get(r.root);
        if (g) g.push(r);
        else groups.set(r.root, [r]);
      }
      for (const [root, sibs] of groups) {
        const numbered = new Set(sibs.filter((x) => x.list === "number").map((x) => x.id));
        const n = deriveNumbering(
          sibs.map((x) => x.id),
          (id) => numbered.has(id),
        ).get(root);
        if (n !== undefined) rootOrdinals.set(root, n);
      }
    }

    return { status: "ok", requested, ancestors, nodes, ancestorText, rootOrdinals };
  } catch (e) {
    return { status: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** The live trees for one references list. `undefined` input = nothing to read (a closed
 * section). `key` is carried back untouched so a caller can tell whose result `.latest` holds —
 * after navigating to another page it still holds the previous page's until the new read lands. */
export function useReferenceTrees<K>(
  input: Accessor<{ key: K; ids: readonly string[] } | undefined>,
): Resource<{ key: K; trees: ReferenceTrees } | undefined> {
  const [resource] = createResource(
    () => {
      const i = input();
      if (i === undefined) return undefined;
      return stampedFor(i, ["block", "block_prop", "page"]);
    },
    async ({ value }) => ({ key: value.key, trees: await loadReferenceTrees(value.ids) }),
  );
  return resource;
}

/**
 * `useReferenceTrees` for one list of the references panel on page `target`, answering only once
 * the result is THIS page's: `.latest` keeps the previous page's until the new read lands, and
 * folding one page's references with another page's ancestors would drop rows. `undefined` = not
 * read yet (or `enabled` is false); a failed read is still an answer.
 */
export function useReferenceListTrees(
  target: Accessor<string>,
  refs: Accessor<readonly { id: string }[]>,
  enabled: Accessor<boolean>,
): Accessor<ReferenceTrees | undefined> {
  // A string, so a refetch of `page.backlinks` returning the same ids does not start a second read
  // on top of the one the write that caused it already started (the stamp re-reads on any write).
  const ids = createMemo(() =>
    refs()
      .map((r) => r.id)
      .join("\n"),
  );
  const input = createMemo(() =>
    enabled() && ids() !== "" ? { key: target(), ids: ids().split("\n") } : undefined,
  );
  const result = useReferenceTrees(input);
  return createMemo(() => {
    const r = result.latest;
    return r && r.key === target() ? r.trees : undefined;
  });
}
