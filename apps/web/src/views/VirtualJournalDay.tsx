/**
 * A virtual (not-yet-existing) journal day: PLAN.md §8 — "today is virtual until it has a block",
 * and by extension any day the calendar opens. Renders one always-editable placeholder row;
 * committing it (blur, or Enter) creates the page AND its first block together — nothing is
 * written before that. Once materialized, every further edit on this page is `BlockTree`'s job.
 */
import {
  isoJournalName,
  makeOp,
  newId,
  type Op,
  type OpPayload,
  orderBetween,
} from "@nooklet/core";
import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { appendToJournalDay } from "../data/journal-day.js";
import { applyOps, getOpClock } from "../data/store.js";
import { journalTemplateOpsFor, loadJournalTemplate } from "../data/templates.js";
import type { NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { blockFocusRequest, requestBlockFocus } from "../editor/focus-request.js";

export interface VirtualJournalDayProps {
  day: number;
  onNavigate?: (t: NavigateTarget) => void;
}

export function VirtualJournalDay(props: VirtualJournalDayProps): JSX.Element {
  const [pageId, setPageId] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal("");

  // The block Enter asked to put the caret in.
  let focusTarget: string | undefined;
  let textarea: HTMLTextAreaElement | undefined;
  let disposed = false;

  /**
   * Hand the focus request back if we are torn down after it was claimed (B-107).
   *
   * After Enter, this component mounts its own `BlockTree` for the page it just created, and the
   * stream mounts another for the same page once its resource sees it — at which point this one
   * is unmounted, always within a fraction of a second. Whichever tree's fetch resolves first
   * claims the focus request: for today it is the stream's (one query); for a calendar-opened day
   * it is ours (`usePinnedJournalDay` runs two), which attached its editor at ~43 ms and was
   * torn down at ~44 ms (measured; docs/BUGS.md B-107). The request had been consumed, so the
   * successor never attached an editor and the caret went nowhere. Re-issuing it on the way out
   * lets the successor claim it; if the successor had already claimed it itself, the repeat is a
   * no-op on the block it is editing.
   *
   * No attempt to tell "torn down while holding the caret" from "the caret left first": the
   * teardown's own `surface.detach()` blurs the editor with no `relatedTarget`, exactly like a
   * click on the page background does, and nobody clicks away inside the swap's window.
   */
  onCleanup(() => {
    disposed = true;
    if (focusTarget && blockFocusRequest() !== focusTarget) requestBlockFocus(focusTarget);
    if (pageId() === undefined && draft() !== "") {
      // Cleanup runs before Solid removes the textarea, so it still holds the caret if it had it.
      void keepUncommittedDraft(draft(), document.activeElement === textarea);
    }
  });

  /**
   * Torn down with typed text that was never committed (B-243).
   *
   * The stream swaps this draft out the moment the local replica has a page for the day, and on a
   * fresh client that happens when the first sync lands, while someone may be typing here. Nothing
   * committed the text: no blur, no Enter. It was simply dropped, and the sync indicator then said
   * "synced". It goes to the end of the page that now exists, with the caret after it if the
   * caret was here. With no such page (unmounted for another reason) it is committed the normal
   * way. The blur that removing a focused textarea may fire is ignored (`disposed`), so this is
   * the only writer.
   */
  async function keepUncommittedDraft(value: string, hadCaret: boolean): Promise<void> {
    const blockId = await appendToJournalDay(props.day, value);
    if (blockId === null) {
      await materialize();
      return;
    }
    if (hadCaret) requestBlockFocus(blockId);
  }

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

    // Optimistic: swap to the real BlockTree immediately using the ids we just minted, rather than
    // waiting on the write + the reactive resource refetch round trip.
    //
    // The focus request is module-level, not a prop: this component is about to be replaced by the
    // journal stream's own BlockTree the moment the page exists, so a prop on the tree rendered
    // below would be thrown away before the block it names ever appears.
    if (nextBlockId) requestBlockFocus(nextBlockId);
    focusTarget = nextBlockId;
    setPageId(newPageId);

    // ADR 019: a new day starts with the journal template, if one is chosen, and what was typed
    // follows it — the same shape a day created through the API gets (`data-api.ts#journal`).
    // One batch, one clock: page, template and typed block land together, and the stream sees one
    // change rather than three. The template is loaded once and the HLC pool sized from that same
    // node, so a template edited on another device mid-flight cannot leave the pool short.
    const template = await loadJournalTemplate();
    const clock = await getOpClock((template?.count ?? 0) + 3);
    const mint = (entity: string, payload: OpPayload): Op =>
      makeOp(clock.next(), clock.device, entity, payload);
    const now = Date.now();

    const ops: Op[] = [
      mint(newPageId, {
        kind: "page.create",
        name: isoJournalName(props.day),
        journalDay: props.day,
        createdAt: now,
      }),
    ];
    let lastOrder: string | null = null;
    if (template) {
      const inserted = journalTemplateOpsFor(template.node, newPageId, props.day, mint);
      ops.push(...inserted.ops);
      lastOrder = inserted.lastOrder;
    }
    const firstOrder = orderBetween(lastOrder, null);
    ops.push(
      mint(firstBlockId, {
        kind: "block.create",
        place: { pageId: newPageId, parentId: null, order: firstOrder },
        content: value,
        createdAt: now,
      }),
    );
    if (nextBlockId) {
      ops.push(
        mint(nextBlockId, {
          kind: "block.create",
          place: { pageId: newPageId, parentId: null, order: orderBetween(firstOrder, null) },
          content: "",
          createdAt: now,
        }),
      );
    }
    await applyOps(ops);
  }

  return (
    <Show
      when={pageId()}
      fallback={
        // Real outliner markup, not a lookalike (docs/BUGS.md B-12). This row becomes a `BlockTree`
        // row the instant it is committed, so rendering it with the same classes the tree uses
        // (`../editor/editor.css`) is what stops the handover from being a visible jump — and
        // stops the placeholder from drifting out of sync with the real thing every time the
        // outliner's bullet, indent or line-height changes.
        <div class="vr-draft">
          <div class="vr-row vr-row-draft">
            <span class="vr-bullet-wrap" aria-hidden="true">
              <span class="vr-bullet">
                <span class="vr-bullet-dot" />
              </span>
            </span>
            <div class="vr-row-main">
              <div class="vr-content">
                <textarea
                  ref={textarea}
                  class="vr-draft-input"
                  value={draft()}
                  rows={1}
                  placeholder="Start typing…"
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onBlur={() => !disposed && void materialize()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void materialize(true);
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      }
    >
      {(id) => <BlockTree pageId={id()} onNavigate={props.onNavigate} />}
    </Show>
  );
}
