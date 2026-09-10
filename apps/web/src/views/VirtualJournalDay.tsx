/**
 * A virtual (not-yet-existing) journal day: PLAN.md §8 — "today is virtual until it has a block",
 * and by extension any day the calendar opens. Renders one always-editable placeholder row;
 * committing it (blur, or Enter) creates the page AND its first block together — nothing is
 * written before that. Once materialized, every further edit on this page is `BlockTree`'s job.
 */
import { formatJournalTitle, newId, orderBetween } from "@nooklet/core";
import { createSignal, type JSX, Show } from "solid-js";
import { applyOp } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";

export interface VirtualJournalDayProps {
  day: number;
  onNavigate?: (t: NavigateTarget) => void;
}

export function VirtualJournalDay(props: VirtualJournalDayProps): JSX.Element {
  const [pageId, setPageId] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal("");

  async function materialize(): Promise<void> {
    const value = draft();
    if (value === "" || pageId() !== undefined) return;
    const newPageId = newId();
    // Optimistic: swap to the real BlockTree immediately using the id we just minted, rather than
    // waiting on the write + the reactive resource refetch round trip.
    setPageId(newPageId);
    await applyOp(newPageId, {
      kind: "page.create",
      name: formatJournalTitle(props.day),
      journalDay: props.day,
      createdAt: Date.now(),
    });
    await applyOp(newId(), {
      kind: "block.create",
      place: { pageId: newPageId, parentId: null, order: orderBetween(null, null) },
      content: value,
      createdAt: Date.now(),
    });
  }

  return (
    <Show
      when={pageId()}
      fallback={
        <div class="block-tree">
          <ul class="block-list">
            <li class="block-row block-row-first">
              <div class="block-row-main">
                <span class="block-bullet" aria-hidden="true">
                  •
                </span>
                <textarea
                  class="block-content-input"
                  value={draft()}
                  rows={1}
                  placeholder="Start typing…"
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onBlur={() => void materialize()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void materialize();
                    }
                  }}
                />
              </div>
            </li>
          </ul>
        </div>
      }
    >
      {(id) => <BlockTree pageId={id()} onNavigate={props.onNavigate} />}
    </Show>
  );
}
