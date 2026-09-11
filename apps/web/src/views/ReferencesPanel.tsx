/**
 * Linked and unlinked references (BUILD item 2; PLAN.md §4: "Linked references of page P = blocks
 * whose path refs include P ... grouped by page, most recent page first. Unlinked references =
 * full-text hits for the page name ... in blocks that do not already reference P."). Data comes
 * from `page.backlinks` over HTTP (`../data/store.ts#useLinkedReferences`, since the client-only
 * schema has no `ref`/`path_ref`/FTS tables); grouping is `views/referenceGrouping.ts`, pure and
 * separately tested.
 *
 * Three rules the panel follows, all learned from it getting them wrong:
 *
 * - **Nothing to show means show nothing.** Two headed sections reading "No linked references
 *   yet" and "No unlinked mentions found" on every page is noise; the panel disappears instead.
 * - **Both halves collapse**, and each remembers its state for the session. Linked references
 *   open by default because that is the half people read.
 * - **A failure says so.** This is a network call to `/api/v1/page.backlinks`; when it fails the
 *   panel used to sit on "Loading…" forever, which is indistinguishable from a page that simply
 *   has no backlinks.
 */
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useLinkedReferences } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import { groupLinkedReferences, groupUnlinkedReferences } from "./referenceGrouping.js";

export interface ReferencesPanelProps {
  /** The page name/date passed to `page.backlinks`'s `target`. */
  target: string;
  onNavigate: (t: NavigateTarget) => void;
}

interface Group {
  page: string;
  refs: ReadonlyArray<{ id: string; text: string }>;
}

function ReferenceGroups(props: {
  groups: Group[];
  onNavigate: (t: NavigateTarget) => void;
}): JSX.Element {
  return (
    <For each={props.groups}>
      {(group) => (
        <div class="reference-group">
          <button
            type="button"
            class="reference-group-page"
            onClick={() => props.onNavigate({ kind: "page", name: group.page })}
          >
            {group.page}
          </button>
          <ul>
            <For each={group.refs}>
              {(ref) => (
                <li class="reference-item">
                  <button
                    type="button"
                    class="reference-item-jump"
                    onClick={() => props.onNavigate({ kind: "block", id: ref.id })}
                  >
                    <InlineContent content={ref.text} onNavigate={props.onNavigate} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      )}
    </For>
  );
}

export function ReferencesPanel(props: ReferencesPanelProps): JSX.Element {
  const [backlinks, { refetch }] = useLinkedReferences(() => props.target);
  const [linkedOpen, setLinkedOpen] = createSignal(true);
  const [unlinkedOpen, setUnlinkedOpen] = createSignal(false);

  // Reading a Solid resource that has errored RE-THROWS the error, so every read below goes
  // through here. Without it the first `backlinks()` call threw during render and took the whole
  // panel down — including the error message it was supposed to be showing.
  const data = createMemo(() => (backlinks.error !== undefined ? undefined : backlinks()));

  const linkedGroups = createMemo(() => groupLinkedReferences(data()?.linked ?? []));
  const unlinkedGroups = createMemo(() => groupUnlinkedReferences(data()?.unlinked ?? []));
  const linkedCount = createMemo(() => data()?.linked.length ?? 0);
  const unlinkedCount = createMemo(() => data()?.unlinked.length ?? 0);

  // `loading` is also true on every refetch (the panel re-asks whenever the graph changes), so a
  // spinner keyed on it alone would flash on every edit. Only show one when there is nothing yet.
  const firstLoad = createMemo(() => backlinks.loading && data() === undefined);
  const failed = createMemo(() => !backlinks.loading && backlinks.error !== undefined);
  const hasAnything = createMemo(() => linkedCount() > 0 || unlinkedCount() > 0);

  return (
    <Show when={firstLoad() || failed() || hasAnything()}>
      <div class="references-panel">
        <Show when={firstLoad()}>
          <p class="references-loading">Loading references…</p>
        </Show>

        <Show when={failed()}>
          <p class="references-error" role="alert">
            Couldn't load references.{" "}
            <button type="button" class="references-retry" onClick={() => refetch()}>
              Retry
            </button>
          </p>
        </Show>

        <Show when={linkedCount() > 0}>
          <section class="linked-references" aria-label="Linked references">
            <button
              type="button"
              class="references-toggle"
              aria-expanded={linkedOpen()}
              onClick={() => setLinkedOpen((v) => !v)}
            >
              <span class="references-caret" aria-hidden="true">
                {linkedOpen() ? "▾" : "▸"}
              </span>
              Linked references
              <span class="reference-count">{linkedCount()}</span>
            </button>
            <Show when={linkedOpen()}>
              <ReferenceGroups groups={linkedGroups()} onNavigate={props.onNavigate} />
            </Show>
          </section>
        </Show>

        <Show when={unlinkedCount() > 0}>
          <section class="unlinked-references" aria-label="Unlinked references">
            <button
              type="button"
              class="references-toggle"
              aria-expanded={unlinkedOpen()}
              onClick={() => setUnlinkedOpen((v) => !v)}
            >
              <span class="references-caret" aria-hidden="true">
                {unlinkedOpen() ? "▾" : "▸"}
              </span>
              Unlinked references
              <span class="reference-count">{unlinkedCount()}</span>
            </button>
            <Show when={unlinkedOpen()}>
              <ReferenceGroups groups={unlinkedGroups()} onNavigate={props.onNavigate} />
            </Show>
          </section>
        </Show>
      </div>
    </Show>
  );
}
