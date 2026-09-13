/**
 * The references panel's lists (`./ReferencesPanel.tsx`), and one reference in them, shown the way
 * its page shows the block (B-550): a
 * breadcrumb of its parent blocks when it is not top-level, then the block itself — full content,
 * task marker, properties, dates — with its children nested under it, read-only. It used to be the
 * block's first line as inline text in a button, so a block with an outline under it read as a
 * flat sentence.
 *
 * The block and its subtree render through `../editor/render/ReadOnlyOutline.tsx`, the renderer
 * `{{embed}}` uses: a row clicks through to its block, links inside go to their targets, a bullet
 * with children folds in this view only. Stored `collapsed` is honoured, root included — the block
 * looks as it does on its page.
 *
 * Until the replica has the block (a fresh device still syncing, a server ahead of it) the row
 * falls back to the first line the server sent, as before.
 */
import { createMemo, For, type JSX, Show } from "solid-js";
import { lookupBlockText } from "../data/block-ref-cache.js";
import { displayRefName } from "../data/page-title.js";
import type { NavigateTarget } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import { ReadOnlyOutline } from "../editor/render/ReadOnlyOutline.js";
import type { RenderCtx } from "../editor/render/tokens.js";
import {
  type BreadcrumbParent,
  breadcrumbLabel,
  type LoadedReferenceTrees,
  sameParents,
  visibleParents,
} from "./referenceNesting.js";

/** Rows one reference renders at most (the block and what is unfolded under it); past it, a
 * "N more blocks" button opens the block. The owner's largest subtree under a reference is 233
 * blocks (`camp`); a panel is for scanning, and the block's own page is one click away. */
export const REFERENCE_ROW_CAP = 50;

interface Group {
  page: string;
  refs: ReadonlyArray<{ id: string; text: string }>;
}

/** A references list: one heading per page, that page's references under it. */
export function ReferenceGroups(props: {
  groups: readonly Group[];
  trees: () => LoadedReferenceTrees | undefined;
  onNavigate: (t: NavigateTarget) => void;
}): JSX.Element {
  // Keyed by page name and block id — strings — not by the group and ref objects: every refetch of
  // `page.backlinks` (one per pause in typing) rebuilds those, and a row is now a whole rendered
  // outline holding its own fold state, too much to throw away and rebuild each time.
  const pages = createMemo(() => props.groups.map((g) => g.page));
  const byPage = createMemo(() => new Map(props.groups.map((g) => [g.page, g.refs])));
  const refsOf = (page: string) => byPage().get(page) ?? [];
  return (
    <For each={pages()}>
      {(page) => (
        <div class="reference-group">
          <button
            type="button"
            class="reference-group-page"
            onClick={() => props.onNavigate({ kind: "page", name: page })}
          >
            {displayRefName(page)}
          </button>
          <ul>
            <For each={refsOf(page).map((r) => r.id)}>
              {(id, i) => (
                <ReferenceItem
                  id={id}
                  text={refsOf(page).find((r) => r.id === id)?.text ?? ""}
                  previousId={refsOf(page)[i() - 1]?.id}
                  trees={props.trees}
                  onNavigate={props.onNavigate}
                />
              )}
            </For>
          </ul>
        </div>
      )}
    </For>
  );
}

/** The parents of a nested reference, outermost first; each step opens that block. */
export function ReferenceBreadcrumb(props: {
  parents: readonly BreadcrumbParent[];
  onNavigate: (t: NavigateTarget) => void;
}): JSX.Element {
  return (
    <Show when={props.parents.length > 0}>
      <nav class="reference-breadcrumb" aria-label="Parent blocks">
        <For each={props.parents}>
          {(parent, i) => {
            const go = (e: MouseEvent | KeyboardEvent): void => {
              // A web link inside the step keeps its own default; a `[[page]]` link stops its own
              // click before it gets here.
              if (e.target instanceof Element && e.target.closest("a[href]")) return;
              e.preventDefault();
              props.onNavigate({ kind: "block", id: parent.id });
            };
            return (
              <>
                <Show when={i() > 0}>
                  <span class="reference-breadcrumb-sep" aria-hidden="true">
                    ›
                  </span>
                </Show>
                {/* biome-ignore lint/a11y/useSemanticElements: the step opens its block but hosts inline rendered content (page links) that cannot live inside an <a> or a <button> — the embed row's reasoning. */}
                <span
                  class="reference-breadcrumb-item"
                  role="link"
                  tabIndex={0}
                  data-parent-id={parent.id}
                  title={breadcrumbLabel(parent.content)}
                  onClick={go}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") go(e);
                  }}
                >
                  <InlineContent
                    content={breadcrumbLabel(parent.content)}
                    onNavigate={props.onNavigate}
                  />
                </span>
              </>
            );
          }}
        </For>
      </nav>
    </Show>
  );
}

export function ReferenceItem(props: {
  id: string;
  /** The first line the server sent: shown until (or unless) the replica has the block. */
  text: string;
  /** The reference rendered just above this one in the same group, if any: a breadcrumb that
   * repeats its breadcrumb is left out (`referenceNesting.ts#visibleParents`). */
  previousId?: string;
  trees: () => LoadedReferenceTrees | undefined;
  onNavigate: (t: NavigateTarget) => void;
}): JSX.Element {
  const node = () => props.trees()?.nodes.get(props.id);
  // Compared by content, so a re-read that changes nothing along the chain keeps the breadcrumb.
  const parents = createMemo(() => visibleParents(props.id, props.previousId, props.trees()), [], {
    equals: sameParents,
  });
  const ctx: RenderCtx = {
    source: "",
    onNavigate: props.onNavigate,
    // `((id))` shows the referenced block's text, as on an outliner row.
    resolveBlockRef: (id) => {
      const content = lookupBlockText(id);
      return content === undefined ? undefined : { content };
    },
  };

  return (
    <li class="reference-item" data-reference-id={props.id}>
      <Show
        when={node() !== undefined}
        fallback={
          <button
            type="button"
            class="reference-item-jump"
            onClick={() => props.onNavigate({ kind: "block", id: props.id })}
          >
            <InlineContent content={props.text} onNavigate={props.onNavigate} />
          </button>
        }
      >
        <ReferenceBreadcrumb parents={parents()} onNavigate={props.onNavigate} />
        <ReadOnlyOutline
          // biome-ignore lint/style/noNonNullAssertion: inside `when={node() !== undefined}`.
          roots={[node()!]}
          cap={REFERENCE_ROW_CAP}
          ctx={ctx}
          onMore={() => props.onNavigate({ kind: "block", id: props.id })}
        />
      </Show>
    </li>
  );
}
