/**
 * A virtual (not-yet-existing) journal day: PLAN.md §8 — "today is virtual until it has a block",
 * and by extension any day the calendar opens. Renders one always-editable placeholder row;
 * committing it (blur, or Enter) creates the page AND its first block together — nothing is
 * written before that. From then on every edit is `BlockTree`'s job, and the tree is the one this
 * component renders: the section showing it keeps it once the day has started
 * (`JournalDayOutline.tsx`), so the tree the caret went into is never swapped for another (B-411).
 */
import {
  isoJournalName,
  makeOp,
  newId,
  type Op,
  type OpPayload,
  orderBetween,
} from "@nooklet/core";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import { appendToJournalDay } from "../data/journal-day.js";
import { applyOps, getOpClock } from "../data/store.js";
import { journalTemplateOpsFor, loadJournalTemplate } from "../data/templates.js";
import type { NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import {
  blockFocusRequest,
  clearBlockFocusRequest,
  requestBlockFocus,
} from "../editor/focus-request.js";
import type { Clock } from "../editor/types.js";

/**
 * Where the draft goes while the journal stream does not yet know whether the day exists
 * (B-410). On a fresh client that is until the first sync has filled the replica — seconds on the
 * owner's 952-page graph — and a draft shown then was a draft for a day the server may already
 * have: Enter created a second page for that day, which the server rejected along with every line
 * typed after it, silently. Nothing here takes input; the draft replaces it once the stream answers.
 */
export function JournalDayLoading(): JSX.Element {
  return (
    <div class="vr-draft vr-draft-loading" aria-busy="true">
      <div class="vr-row vr-row-draft">
        <span class="vr-bullet-wrap" aria-hidden="true">
          <span class="vr-bullet">
            <span class="vr-bullet-dot" />
          </span>
        </span>
        <div class="vr-row-main">
          <div class="vr-content">
            <span class="vr-draft-pending">Loading…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface VirtualJournalDayProps {
  day: number;
  onNavigate?: (t: NavigateTarget) => void;
  /** `true` once this draft has written the day and renders the day's tree itself; `false` again
   * if that write failed and the draft is back. */
  onStarted?: (started: boolean) => void;
}

/** What writing the day needs from the replica worker, fetched before it is needed (B-411). */
interface Prepared {
  template: Awaited<ReturnType<typeof loadJournalTemplate>>;
  clock: Clock;
  /** How many ops `clock` can still mint. */
  size: number;
}

/** Ops a day with `lines` typed lines takes: the page, the template's blocks, one per line. */
function opsNeeded(template: Prepared["template"], lines: number): number {
  return 1 + (template?.count ?? 0) + lines;
}

export function VirtualJournalDay(props: VirtualJournalDayProps): JSX.Element {
  const [pageId, setPageId] = createSignal<string | undefined>(undefined);
  // The batch that started the day, which the day's tree is drawn from before its first fetch.
  let startOps: readonly Op[] = [];
  const [draft, setDraft] = createSignal("");
  // Lines Enter has closed that are not written yet. Only non-empty while a commit waits for
  // `prepare` (a busy replica), or after a failed write put them back.
  const [closed, setClosed] = createSignal<readonly string[]>([]);
  const [error, setError] = createSignal<string | undefined>(undefined);

  let textarea: HTMLTextAreaElement | undefined;
  let disposed = false;
  let committing = false;
  let prepared: Prepared | undefined;
  let preparing: Promise<Prepared> | undefined;

  onCleanup(() => {
    disposed = true;
    // A commit waiting on the worker reads the draft when it resumes, and writes it.
    if (committing || pageId() !== undefined) return;
    const text = [...closed(), draft()].filter((line) => line !== "").join("\n");
    // Cleanup runs before Solid removes the textarea, so it still holds the caret if it had it.
    if (text !== "") void keepUncommittedDraft(text, document.activeElement === textarea);
  });

  /**
   * Torn down with typed text that was never committed (B-243).
   *
   * The section swaps this draft out the moment the local replica has a page for the day — since
   * B-410 no longer on a fresh client's first sync, but still when another device writes the day
   * while someone is typing here. Nothing committed the text: no blur, no Enter. It goes to the end
   * of the page that now exists, with the caret after it if the caret was here. With no such page
   * (unmounted for another reason) it is committed the normal way. The blur that removing a
   * focused textarea may fire is ignored (`disposed`), so this is the only writer.
   */
  async function keepUncommittedDraft(value: string, hadCaret: boolean): Promise<void> {
    const blockId = await appendToJournalDay(props.day, value);
    if (blockId === null) {
      await commit();
      return;
    }
    if (hadCaret) requestBlockFocus(blockId);
  }

  /**
   * Fetch the journal template and an HLC pool for the day's first write, once, ahead of it — on
   * focus. Both are worker round trips, and while they were awaited at Enter the line was already
   * gone from the screen with no editor anywhere: keys typed then were lost, and under a busy
   * replica that was every key for seconds (B-411). Prepared in advance, Enter writes and swaps to
   * the day's tree in one synchronous step.
   *
   * The pool is minted before anything the day's tree will write, so the day's ops carry the older
   * HLCs. That matters: a `block.text` older than the `block.create` it edits loses to it.
   */
  function prepare(size: number): Promise<Prepared> {
    if (prepared && prepared.size >= size) return Promise.resolve(prepared);
    preparing ??= (async () => {
      try {
        // A pool that turned out too small (more lines typed while waiting) is replaced, but the
        // template stays the one it was sized from.
        const template = prepared ? prepared.template : await loadJournalTemplate();
        // Room for a few rows by default, so even a commit that waited needs no second trip.
        const poolSize = Math.max(size, opsNeeded(template, 4));
        const clock = await getOpClock(poolSize);
        prepared = { template, clock, size: poolSize };
        return prepared;
      } finally {
        preparing = undefined;
      }
    })();
    return preparing;
  }

  /** Enter: close the typed line and open the next one, the way an outliner row does. */
  function onEnter(): void {
    if (draft() === "" && closed().length === 0) return;
    setClosed((lines) => [...lines, draft()]);
    setDraft("");
    void commit();
  }

  /**
   * Write the day: the page, the journal template (ADR 019), then one block per typed line —
   * every line Enter closed, then what the textarea holds now. After an Enter that last line is the
   * new, still-empty row, which is where the caret goes if it is still here. A blur with no Enter
   * writes the one line and takes the caret nowhere.
   *
   * Everything from reading the lines to showing the day's tree is synchronous, so a key cannot
   * land between them: while `prepare` is still out, the textarea stays and keeps taking what is
   * typed (Enter closing lines, shown above it), and the resumed commit writes all of it.
   */
  async function commit(): Promise<void> {
    if (committing || pageId() !== undefined) return;
    if (draft() === "" && closed().length === 0) return;
    committing = true;
    setError(undefined);
    let focusId: string | undefined;
    try {
      let prep = prepared ?? (await prepare(0));
      while (prep.size < opsNeeded(prep.template, closed().length + 1)) {
        prep = await prepare(opsNeeded(prep.template, closed().length + 1));
      }
      prepared = undefined; // spent: its HLCs are about to be used

      const lines = [...closed(), draft()];
      const newPageId = newId();
      const { ops, lastBlockId } = dayOps(prep, newPageId, lines);
      // Posted now, before the tree below exists and can post anything of its own.
      const written = applyOps(ops);
      // The module-level request, claimed by the tree below the moment it renders the block from
      // `startOps` — before this handler returns, so the next key already has an editor.
      if (document.activeElement === textarea) {
        focusId = lastBlockId;
        requestBlockFocus(lastBlockId);
      }
      startOps = ops;
      setPageId(newPageId);
      props.onStarted?.(true);
      await written;
      setClosed([]);
      setDraft("");
    } catch (err) {
      // The write is one transaction (`SyncClient.applyLocal`), so a failure anywhere means nothing
      // was written: the tree just shown is for a page that does not exist. Put the typed lines
      // back — the empty row Enter opened goes back to being the end of the line before it — drop
      // the caret request for a block that was never created, and say why (B-131).
      const lines = [...closed(), draft()];
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      setClosed(lines.slice(0, -1));
      setDraft(lines.at(-1) ?? "");
      if (focusId && blockFocusRequest() === focusId) clearBlockFocusRequest();
      if (pageId() !== undefined) {
        setPageId(undefined);
        props.onStarted?.(false);
      }
      setError(`Could not start this day: ${describeError(err)}`);
    } finally {
      committing = false;
    }
  }

  /**
   * One batch, one clock: page, template and typed blocks land together, and the stream sees one
   * change rather than three — the same shape a day created through the API gets
   * (`data-api.ts#journal`). The template and the pool come from one `prepare`, so a template
   * edited elsewhere in between cannot leave the pool short.
   */
  function dayOps(
    prep: Prepared,
    newPageId: string,
    lines: readonly string[],
  ): { ops: Op[]; lastBlockId: string } {
    const { clock, template } = prep;
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
    let order: string | null = null;
    if (template) {
      const inserted = journalTemplateOpsFor(template.node, newPageId, props.day, mint);
      ops.push(...inserted.ops);
      order = inserted.lastOrder;
    }
    let lastBlockId = "";
    for (const content of lines) {
      lastBlockId = newId();
      order = orderBetween(order, null);
      ops.push(
        mint(lastBlockId, {
          kind: "block.create",
          place: { pageId: newPageId, parentId: null, order },
          content,
          createdAt: now,
        }),
      );
    }
    return { ops, lastBlockId };
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
          <For each={closed()}>
            {(line) => (
              <div class="vr-row vr-row-draft">
                <span class="vr-bullet-wrap" aria-hidden="true">
                  <span class="vr-bullet">
                    <span class="vr-bullet-dot" />
                  </span>
                </span>
                <div class="vr-row-main">
                  <div class="vr-content vr-draft-line">{line}</div>
                </div>
              </div>
            )}
          </For>
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
                  onFocus={() => void prepare(0).catch(() => {})}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onBlur={() => !disposed && void commit()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onEnter();
                    }
                  }}
                />
              </div>
            </div>
          </div>
          <Show when={error()}>
            {(e) => (
              <div class="vr-draft-error" role="alert">
                {e()}
              </div>
            )}
          </Show>
        </div>
      }
    >
      {(id) => <BlockTree pageId={id()} initialOps={startOps} onNavigate={props.onNavigate} />}
    </Show>
  );
}
