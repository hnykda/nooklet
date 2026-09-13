/**
 * The pure half of `./EmbedView.tsx`: which rows an embed shows, and whether showing them at all
 * would recurse. No DOM, no Solid — tested directly by `embedRows.test.ts`.
 */

/** The shape both a page tree node and a query-style subtree satisfy. */
export interface EmbedNode {
  id: string;
  collapsed: boolean;
  children: readonly EmbedNode[];
}

/** Rows one embed renders at most; past it a "N more" line links to the source. The owner's
 * largest embed is 60 blocks, so this only ever bites a page embed of a long page — and an
 * inline copy of a 900-block page is not something anyone reads in place. */
export const EMBED_ROW_CAP = 250;

export interface EmbedRows {
  /** Ids in reading order, the first `cap` visible rows. Strings on purpose: `<For>` keys by
   * reference, and a re-read of the graph rebuilds every node object, so keying rows by node
   * would re-create every row on every edit anywhere. Ids are stable across re-reads. */
  ids: string[];
  depth: Map<string, number>;
  /** Visible rows that did not fit under the cap. */
  hidden: number;
}

/**
 * Flatten `roots` into visible rows. `open(node, isRoot)` decides whether a node's children show;
 * the caller owns that rule (stored `collapsed`, a root that is always open, view-local toggles).
 */
export function visibleEmbedRows(
  roots: readonly EmbedNode[],
  open: (node: EmbedNode, isRoot: boolean) => boolean,
  cap: number = EMBED_ROW_CAP,
): EmbedRows {
  const ids: string[] = [];
  const depth = new Map<string, number>();
  let hidden = 0;
  const walk = (nodes: readonly EmbedNode[], d: number, isRoot: boolean): void => {
    for (const node of nodes) {
      if (ids.length < cap) {
        ids.push(node.id);
        depth.set(node.id, d);
      } else {
        hidden++;
      }
      if (node.children.length > 0 && open(node, isRoot)) walk(node.children, d + 1, false);
    }
  };
  walk(roots, 0, true);
  return { ids, depth, hidden };
}

/**
 * Does rendering `roots` reach a block that is already being rendered further up (`path`: the row
 * the embed is written in, then each embedded block on the way down)?
 *
 * That is exactly the case that never ends: the tree contains a block on the path, which contains
 * this embed, which renders the tree again. It covers a block embedding itself, a block embedding
 * one of its own ancestors, a page embedding itself (the host row is one of the page's blocks),
 * and two pages embedding each other (caught one level down). The whole tree is checked, collapsed
 * parts included — expanding one must not start the recursion. `refDepth` still bounds anything
 * this misses, such as an embed rendered where no host row is known (the shelf, a backlink).
 */
export function embedReachesPath(roots: readonly EmbedNode[], path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const onPath = new Set(path);
  const stack = [...roots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (onPath.has(node.id)) return true;
    stack.push(...node.children);
  }
  return false;
}
