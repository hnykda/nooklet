/**
 * Which references the panel lists as rows of their own, and what a row's breadcrumb says (B-550).
 * Pure, over what `../data/reference-trees.ts` read; tested by `referenceNesting.test.ts`.
 *
 * A reference inside another reference in the same list is not a row of its own: it is already on
 * screen, nested under that one, as it is on its page. Logseq does the same
 * (`frontend/components/reference.cljs`, 0.10.9: children render under the block that references
 * the page). Without this, a journal block linking `[[@Alex]]` with ten children listed eleven
 * rows — the block with its children, then each child again with its own children — because every
 * descendant of a linking block is a linked reference too (docs/spec/sql-schema.md rule 12).
 *
 * "In the same list" means the list being shown — after the filter. A block whose parent the
 * filter hides becomes a row of its own, with that parent in its breadcrumb. The other way round
 * is not undone: a filtered-out child of a block that is shown stays visible inside that block's
 * outline, which renders the block's real subtree rather than a filtered one.
 */
import type { ReferenceTrees } from "../data/reference-trees.js";

export type LoadedReferenceTrees = Extract<ReferenceTrees, { status: "ok" }>;

/** The trees when the read succeeded; `undefined` for not read yet and for a failed read. */
export function loadedTrees(trees: ReferenceTrees | undefined): LoadedReferenceTrees | undefined {
  return trees?.status === "ok" ? trees : undefined;
}

export interface BreadcrumbParent {
  id: string;
  content: string;
}

/**
 * `groups` without the references nested inside another reference in `groups`. With no trees (the
 * read failed), everything stays a row. A reference the trees were not asked about yet — the list
 * refetched and the read for it has not landed — is held back rather than shown as a row for the
 * moment it takes, since it is most often a new child that will fold under its parent. Groups
 * cannot empty: the outermost reference of a page is always a row.
 */
export function foldNestedReferences<R extends { id: string }, G extends { refs: readonly R[] }>(
  groups: readonly G[],
  trees: LoadedReferenceTrees | undefined,
): G[] {
  if (!trees) return [...groups];
  const listed = new Set<string>();
  for (const g of groups) for (const r of g.refs) listed.add(r.id);
  const isRow = (id: string): boolean => {
    if (!trees.requested.has(id)) return false;
    return !(trees.ancestors.get(id) ?? []).some((a) => listed.has(a));
  };
  const out: G[] = [];
  for (const g of groups) {
    const refs = g.refs.filter((r) => isRow(r.id));
    if (refs.length === 0) continue;
    out.push(refs.length === g.refs.length ? g : { ...g, refs });
  }
  return out;
}

/** A reference's parents, outermost first, with their text; `[]` for a top-level block or one the
 * trees know nothing about. */
export function referenceParents(
  id: string,
  trees: LoadedReferenceTrees | undefined,
): BreadcrumbParent[] {
  const chain = trees?.ancestors.get(id);
  if (!trees || !chain) return [];
  return [...chain].reverse().map((a) => ({
    id: a,
    content: trees.nodes.get(a)?.content ?? trees.ancestorText.get(a) ?? "",
  }));
}

/** Two breadcrumbs that say the same thing: the same blocks with the same text. */
export function sameParents(
  a: readonly BreadcrumbParent[],
  b: readonly BreadcrumbParent[],
): boolean {
  return (
    a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.content === b[i]?.content)
  );
}

/** The breadcrumb a row shows: none when the row just above it in the same group has the same
 * parents. On the real graph's `task` page most references are DONE items under one "todo" block
 * per day, and repeating "todo" over each of them doubled the list's height to say nothing new —
 * consecutive siblings read as siblings without it. */
export function visibleParents(
  id: string,
  previousId: string | undefined,
  trees: LoadedReferenceTrees | undefined,
): BreadcrumbParent[] {
  const mine = referenceParents(id, trees);
  if (mine.length === 0 || previousId === undefined) return mine;
  return sameParents(mine, referenceParents(previousId, trees)) ? [] : mine;
}

/** What one breadcrumb step shows: the parent's first line that says something. A block's text can
 * run to pages, and a breadcrumb is a way to tell where you are, not a second copy of the parent.
 *
 * The step renders through `InlineContent`, and the inline tokenizer draws NOTHING for a heading
 * line, a fence's opening or closing line, or a thematic break — they are block-level. Taken as
 * written, `## 🔖 Articles` was an empty step: the breadcrumb vanished, or began with a stray "›"
 * (B-552; 94 steps on the owner's graph). So a heading loses its `#`s, those other lines are
 * skipped, and a parent with nothing left says so rather than rendering as a gap. */
export function breadcrumbLabel(content: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim().replace(/^#{1,6}\s+/, "");
    if (t === "" || /^(`{3,}|~{3,})/.test(t) || /^([-*_])(\s*\1){2,}$/.test(t)) continue;
    return t;
  }
  return "(empty)";
}
