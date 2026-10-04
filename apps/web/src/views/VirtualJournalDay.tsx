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
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { matchSlashTrigger } from "../commands/slash/trigger.js";
import { describeError } from "../data/api-client.js";
import { appendToJournalDay } from "../data/journal-day.js";
import { clearDraftLines, readDraftLines, saveDraftLines } from "../data/journal-draft-store.js";
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

/**
 * A line typed in the draft, with the outline depth Tab and Shift+Tab gave it while the draft still
 * held the keys (B-609). Depth 0 is a top-level block of the day.
 */
export interface DraftLine {
  text: string;
  depth: number;
}

/** Ops a day with `lines` typed lines takes: the page, the template's blocks, one per line. */
function opsNeeded(template: Prepared["template"], lines: number): number {
  return 1 + (template?.count ?? 0) + lines;
}

export function VirtualJournalDay(props: VirtualJournalDayProps): JSX.Element {
  const [pageId, setPageId] = createSignal<string | undefined>(undefined);
  // The batch that started the day, which the day's tree is drawn from before its first fetch.
  let startOps: readonly Op[] = [];
  // B-619: a copy left by a page load that ended before its commit (see the effect below) starts
  // the draft off. Read before anything can save over it. Lines carry their depth (B-609).
  const kept = readDraftLines(props.day);
  const keptLast = kept?.at(-1);
  const [draft, setDraft] = createSignal(keptLast?.text ?? "");
  // The depth of the line in the textarea. Tab and Shift+Tab change it while the draft still holds
  // the keys; see `onTab`.
  const [draftDepth, setDraftDepth] = createSignal(keptLast?.depth ?? 0);
  // Lines Enter has closed that are not written yet. Only non-empty while a commit waits for
  // `prepare` (a busy replica, or simply a type-ahead burst faster than the worker's round trips),
  // or after a failed write put them back.
  const [closed, setClosed] = createSignal<readonly DraftLine[]>(kept?.slice(0, -1) ?? []);
  const allLines = (): DraftLine[] => [...closed(), { text: draft(), depth: draftDepth() }];
  const [error, setError] = createSignal<string | undefined>(undefined);

  let textarea: HTMLTextAreaElement | undefined;
  let disposed = false;
  let committing = false;
  let prepared: Prepared | undefined;
  let preparing: Promise<Prepared> | undefined;

  // B-619: what is typed here exists only in this page until `commit` has built its ops, which
  // waits on worker round trips (`prepare`). Kept synchronously in `localStorage` for exactly that
  // long (`../data/journal-draft-store.ts`), so a reload in between does not lose it; `commit`
  // clears the copy once `applyOps` has recorded the ops in the B-247 journal.
  createEffect(() => {
    if (pageId() !== undefined) return;
    saveDraftLines(props.day, allLines());
  });

  // The kept copy is written straight away: every line of it was typed, and a blur would have
  // written it.
  onMount(() => {
    if (kept) void commit();
  });

  onCleanup(() => {
    disposed = true;
    // A commit waiting on the worker reads the draft when it resumes, and writes it.
    if (committing || pageId() !== undefined) return;
    const text = allLines()
      .map((line) => line.text)
      .filter((line) => line !== "")
      .join("\n");
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
    setClosed(allLines());
    setDraft("");
    // The new row starts where the one Enter closed was, as in the outliner.
    void commit();
  }

  /**
   * Tab / Shift+Tab while the draft still holds the keys (B-609). Enter commits at once when
   * `prepare` has answered, but a burst typed straight after focusing — `aaa`⏎`bbb`⇥⏎`ccc`⇧⇥ with
   * no delay, or a phone keyboard delivering a batch — arrives before the worker's two round trips
   * do, so the commit waits and these keys land here. The textarea used to let Tab do the browser
   * default: focus jumped to the next focusable thing on the page (the help button), the Enter
   * after it pressed that button, the text after it was typed into nothing, and the day was written
   * flat with lines missing. So Tab is the outliner's Tab here too: it nests the line under the
   * one above (one level deeper at most, never the first line), and the commit writes that tree.
   */
  function onTab(outdent: boolean): void {
    const above = closed().at(-1);
    if (outdent) setDraftDepth((d) => Math.max(0, d - 1));
    else if (above) setDraftDepth((d) => Math.min(d + 1, above.depth + 1));
  }

  /**
   * Backspace at the start of the line: join it to the line above, the way the outliner's
   * Backspace merges a row into its predecessor. Only reachable while lines are waiting for the
   * commit, and without it an Enter typed by mistake in a burst would be written as an empty block.
   */
  function onBackspaceAtStart(): boolean {
    const above = closed().at(-1);
    if (!above || !textarea) return false;
    const rest = draft();
    setClosed((lines) => lines.slice(0, -1));
    setDraftDepth(above.depth);
    setDraft(above.text + rest);
    textarea.value = above.text + rest;
    textarea.setSelectionRange(above.text.length, above.text.length);
    return true;
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

      const lines = allLines();
      const newPageId = newId();
      const { ops, lastBlockId } = dayOps(prep, newPageId, lines);
      // Posted now, before the tree below exists and can post anything of its own.
      const written = applyOps(ops);
      // `applyOps` copied the batch into the B-247 journal synchronously, so that copy carries the
      // lines from here; the draft's own copy goes (a failure below saves it again via the effect).
      clearDraftLines(props.day);
      // The module-level request, claimed by the tree below the moment it renders the block from
      // `startOps` — before this handler returns, so the next key already has an editor.
      if (document.activeElement === textarea) {
        focusId = lastBlockId;
        // Where the caret is in the line, not always its end: `/` typed mid-line (B-646) commits
        // with the caret right after it, and that is where the menu has to open.
        const at = textarea?.selectionStart ?? null;
        requestBlockFocus(
          lastBlockId,
          at !== null && at < draft().length ? { offset: at } : undefined,
        );
      }
      startOps = ops;
      setPageId(newPageId);
      props.onStarted?.(true);
      await written;
      setClosed([]);
      setDraft("");
      setDraftDepth(0);
    } catch (err) {
      // The write is one transaction (`SyncClient.applyLocal`), so a failure anywhere means nothing
      // was written: the tree just shown is for a page that does not exist. Put the typed lines
      // back — the empty row Enter opened goes back to being the end of the line before it — drop
      // the caret request for a block that was never created, and say why (B-131).
      const lines = allLines();
      if (lines.length > 1 && lines.at(-1)?.text === "") lines.pop();
      setClosed(lines.slice(0, -1));
      setDraft(lines.at(-1)?.text ?? "");
      setDraftDepth(lines.at(-1)?.depth ?? 0);
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
    lines: readonly DraftLine[],
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
    // `open[d]` is the latest block at depth `d` and the last order among its children: the
    // parent a line at depth `d + 1` goes under, and where among its children it goes. Depths are
    // kept valid by `onTab` (never more than one deeper than the line above), and clamped here too
    // so a bad depth can only flatten a line, never orphan it.
    const open: Array<{ id: string | null; lastChildOrder: string | null }> = [
      { id: null, lastChildOrder: order },
    ];
    let lastBlockId = "";
    for (const { text: content, depth: wanted } of lines) {
      const depth = Math.min(wanted, open.length - 1);
      const parent = open[depth] as { id: string | null; lastChildOrder: string | null };
      lastBlockId = newId();
      const blockOrder = orderBetween(parent.lastChildOrder, null);
      parent.lastChildOrder = blockOrder;
      open.length = depth + 1;
      open.push({ id: lastBlockId, lastChildOrder: null });
      ops.push(
        mint(lastBlockId, {
          kind: "block.create",
          place: { pageId: newPageId, parentId: parent.id, order: blockOrder },
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
              <div class="vr-row vr-row-draft" style={{ "--depth": line.depth }}>
                <span class="vr-bullet-wrap" aria-hidden="true">
                  <span class="vr-bullet">
                    <span class="vr-bullet-dot" />
                  </span>
                </span>
                <div class="vr-row-main">
                  <div class="vr-content vr-draft-line">{line.text}</div>
                </div>
              </div>
            )}
          </For>
          <div class="vr-row vr-row-draft" style={{ "--depth": draftDepth() }}>
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
                  onInput={(e) => {
                    const el = e.currentTarget;
                    setDraft(el.value);
                    // B-646: the slash menu belongs to the block editor, and this textarea is not
                    // one — `/` typed into a day's first line opened nothing, on the phone (where
                    // an empty day is the first thing you type into) and on the desktop alike. A
                    // `/` that would open the menu in a block starts the day instead, with the
                    // caret where it was; the menu then opens in the block's editor
                    // (`CommandLayer` re-detects on focus).
                    const at = el.selectionStart;
                    if (at === el.selectionEnd && matchSlashTrigger(el.value.slice(0, at))) {
                      void commit();
                    }
                  }}
                  onBlur={() => !disposed && void commit()}
                  onKeyDown={(e) => {
                    if (e.isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onEnter();
                    } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
                      // Never the browser's focus move: the keys after it would go elsewhere.
                      e.preventDefault();
                      onTab(e.shiftKey);
                    } else if (
                      e.key === "Backspace" &&
                      e.currentTarget.selectionStart === 0 &&
                      e.currentTarget.selectionEnd === 0 &&
                      onBackspaceAtStart()
                    ) {
                      e.preventDefault();
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
