/**
 * What a `{{embed [[Page]]}}` / `{{embed ((id))}}` shows: the embedded page's blocks, or the
 * embedded block with its subtree, read from the LOCAL replica (audit 2026-09-12 §2 item 8, B-210).
 *
 * Read-only data: `../editor/render/EmbedView.tsx` renders it as an outline whose rows click
 * through to the real block. Editing inside an embed would need a second `BlockTree` with its own
 * surface, and is not attempted here.
 *
 * Both kinds go through the worker's `getPageTree`, the same tree builder the outliner renders
 * from, so an embed can never order siblings differently from the page it came from. A block embed
 * fetches its whole page to find the subtree; pages are small (the owner's largest is 961 blocks)
 * and embeds are rare (six in 18.6k blocks), so a dedicated subtree query is not worth a second
 * tree builder.
 *
 * Reactivity is `store.ts`'s idiom: the resource source carries a version stamp over the tables an
 * embed depends on, so a change anywhere re-reads it. The fetcher never rejects — an errored Solid
 * resource re-throws on read and would take the host block's row down with it — failures come back
 * as `{ status: "failed" }` and render as words.
 */

import { normalizePageName, type PageRow, parseJournalTitle } from "@nooklet/core";
import { type Accessor, createResource, type Resource } from "solid-js";
import { getPageTree, queryAs } from "../db/client.js";
import { stampedFor } from "./store.js";
import type { BlockTreeNode, PageTreeResult } from "./types.js";

export type EmbedTarget = { kind: "page"; name: string } | { kind: "block"; id: string };

export type EmbedData =
  /** A page embed: the page's top-level blocks (possibly none). */
  | { status: "page"; page: PageRow; blocks: BlockTreeNode[] }
  /** A block embed: the block itself, children nested as on its page. */
  | { status: "block"; page: PageRow; node: BlockTreeNode }
  /** No live page by that name, or no live block with that id. */
  | { status: "missing" }
  | { status: "failed"; message: string };

export type SqlRunner = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface EmbedDeps {
  sql: SqlRunner;
  pageTree: (pageId: string) => Promise<PageTreeResult | undefined>;
}

const defaultDeps: EmbedDeps = { sql: queryAs, pageTree: getPageTree };

/** Depth-first search of a page tree, since an embedded block can sit at any depth. */
export function findTreeNode(
  nodes: readonly BlockTreeNode[],
  id: string,
): BlockTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findTreeNode(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** A page id by name, with the same two lookups `store.ts#usePageByName` does: the normalized key,
 * then — for a journal written in any title format — the day number. */
async function findPageId(sql: SqlRunner, name: string): Promise<string | undefined> {
  const byKey = await sql<{ id: string }>(
    "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL LIMIT 1",
    [normalizePageName(name)],
  );
  if (byKey[0]) return byKey[0].id;
  const day = parseJournalTitle(name);
  if (day === null) return undefined;
  const byDay = await sql<{ id: string }>(
    "SELECT id FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
    [day],
  );
  return byDay[0]?.id;
}

/** One read of an embed's target. Exported for `embeds.test.ts`; views use `useEmbed`. */
export async function loadEmbed(
  target: EmbedTarget,
  deps: EmbedDeps = defaultDeps,
): Promise<EmbedData> {
  try {
    if (target.kind === "page") {
      const pageId = await findPageId(deps.sql, target.name);
      if (pageId === undefined) return { status: "missing" };
      const tree = await deps.pageTree(pageId);
      if (!tree) return { status: "missing" };
      return { status: "page", page: tree.page, blocks: tree.blocks };
    }
    // The block's page must be live too: a block on a trashed page is not reachable anywhere
    // else in the app, and an embed must not be the one place it still shows.
    const rows = await deps.sql<{ page_id: string }>(
      `SELECT b.page_id FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
       WHERE b.id = ? AND b.deleted_at IS NULL LIMIT 1`,
      [target.id],
    );
    const pageId = rows[0]?.page_id;
    if (pageId === undefined) return { status: "missing" };
    const tree = await deps.pageTree(pageId);
    const node = tree ? findTreeNode(tree.blocks, target.id) : undefined;
    // `undefined` although the row is live: an ancestor was deleted and the page tree (rightly)
    // no longer reaches it.
    if (!tree || !node) return { status: "missing" };
    return { status: "block", page: tree.page, node };
  } catch (e) {
    return { status: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** The live embed for `target`: re-read whenever pages, blocks or block properties change.
 * `undefined` target = nothing to read. Read it through `.latest` so a re-read keeps showing the
 * previous tree instead of suspending the enclosing boundary. */
export function useEmbed(
  target: Accessor<EmbedTarget | undefined>,
): Resource<EmbedData | undefined> {
  const [resource] = createResource(
    () => {
      const t = target();
      if (t === undefined) return undefined;
      return stampedFor(t, ["page", "block", "block_prop"]);
    },
    ({ value }) => loadEmbed(value),
  );
  return resource;
}
