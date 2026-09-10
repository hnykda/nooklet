/**
 * Linked and unlinked references (BUILD item 2; PLAN.md §4: "Linked references of page P = blocks
 * whose path refs include P ... grouped by page, most recent page first. Unlinked references =
 * full-text hits for the page name ... in blocks that do not already reference P."). Data comes
 * from `page.backlinks` over HTTP (`../data/store.ts#useLinkedReferences`, since the client-only
 * schema has no `ref`/`path_ref`/FTS tables); grouping is `views/referenceGrouping.ts`, pure and
 * separately tested.
 */
import { For, type JSX, Show } from "solid-js";
import { useLinkedReferences } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import { groupLinkedReferences, groupUnlinkedReferences } from "./referenceGrouping.js";

export interface ReferencesPanelProps {
  /** The page name/date passed to `page.backlinks`'s `target`. */
  target: string;
  onNavigate: (t: NavigateTarget) => void;
}

export function ReferencesPanel(props: ReferencesPanelProps): JSX.Element {
  const [backlinks] = useLinkedReferences(() => props.target);
  const linkedGroups = () => groupLinkedReferences(backlinks()?.linked ?? []);
  const unlinkedGroups = () => groupUnlinkedReferences(backlinks()?.unlinked ?? []);

  return (
    <div class="references-panel">
      <section class="linked-references" aria-label="Linked references">
        <h3>
          Linked references
          <Show when={backlinks()}>
            {(b) => <span class="reference-count"> ({b().linked.length})</span>}
          </Show>
        </h3>
        <Show when={backlinks.loading}>
          <p>Loading…</p>
        </Show>
        <Show when={!backlinks.loading && linkedGroups().length === 0}>
          <p class="references-empty">No linked references yet.</p>
        </Show>
        <For each={linkedGroups()}>
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
      </section>

      <details class="unlinked-references">
        <summary>
          Unlinked references
          <Show when={backlinks()}>
            {(b) => <span class="reference-count"> ({b().unlinked.length})</span>}
          </Show>
        </summary>
        <Show when={!backlinks.loading && unlinkedGroups().length === 0}>
          <p class="references-empty">No unlinked mentions found.</p>
        </Show>
        <For each={unlinkedGroups()}>
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
      </details>
    </div>
  );
}
