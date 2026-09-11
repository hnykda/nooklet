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
import { requestBlockFocus } from "../editor/focus-request.js";

export interface VirtualJournalDayProps {
  day: number;
  onNavigate?: (t: NavigateTarget) => void;
}

export function VirtualJournalDay(props: VirtualJournalDayProps): JSX.Element {
  const [pageId, setPageId] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal("");

  /**
   * Commit the placeholder row, creating the page and its first block.
   *
   * `continueEditing` is the difference between the two ways out of this row. Pressing Enter in an
   * outliner means "done with this bullet, give me the next one", so it also creates an empty
   * sibling and focuses it — without that, Enter committed the text and dropped you out of editing
   * entirely, and the only way to keep writing was to hunt for a bullet to click. Blurring means
   * "I'm leaving", so it commits one block and takes focus nowhere.
   */
  async function materialize(continueEditing = false): Promise<void> {
    const value = draft();
    if (value === "" || pageId() !== undefined) return;
    const newPageId = newId();
    const firstBlockId = newId();
    const nextBlockId = continueEditing ? newId() : undefined;
    const firstOrder = orderBetween(null, null);

    // Optimistic: swap to the real BlockTree immediately using the ids we just minted, rather than
    // waiting on the write + the reactive resource refetch round trip.
    //
    // The focus request is module-level, not a prop: this component is about to be replaced by the
    // journal stream's own BlockTree the moment the page exists, so a prop on the tree rendered
    // below would be thrown away before the block it names ever appears.
    if (nextBlockId) requestBlockFocus(nextBlockId);
    setPageId(newPageId);

    await applyOp(newPageId, {
      kind: "page.create",
      name: formatJournalTitle(props.day),
      journalDay: props.day,
      createdAt: Date.now(),
    });
    await applyOp(firstBlockId, {
      kind: "block.create",
      place: { pageId: newPageId, parentId: null, order: firstOrder },
      content: value,
      createdAt: Date.now(),
    });
    if (nextBlockId) {
      await applyOp(nextBlockId, {
        kind: "block.create",
        place: { pageId: newPageId, parentId: null, order: orderBetween(firstOrder, null) },
        content: "",
        createdAt: Date.now(),
      });
    }
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
                      void materialize(true);
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
