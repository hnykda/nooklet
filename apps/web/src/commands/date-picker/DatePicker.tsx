/**
 * The date picker behind `/scheduled`, `/deadline`, "Set scheduled/deadline date" and a click on
 * a row's date chip (R38; B-96, B-102).
 *
 * Keyboard first. You type — `tomorrow`, `+3d`, `fri 14:00`, `2026-09-20`, `20.9.`, `every week`,
 * `none` (`./parse.ts` is the whole vocabulary) — and the calendar follows what you typed; the
 * arrows move the highlighted day (±1 / ±7), PageUp/PageDown a month (with Shift a year), Enter
 * sets it, Escape leaves everything as it was. The mouse works too, but nothing needs it.
 *
 * Built on the slash menu's rules, not the palette's, because it is part of editing a block:
 * - The editor KEEPS focus. Nothing in here is focusable (every control swallows `mousedown`), so
 *   when the picker closes — set or cancelled — the caret is exactly where it was, and "focus
 *   returns to the editor" is true by never having left. Opened from block selection or a chip,
 *   whatever held focus keeps it for the same reason.
 * - It claims Escape/Enter/Tab/Up/Down through `claimPopupKeys`, so both keymap contexts see
 *   `popupOpen` and yield them.
 * - The keys themselves are taken in the WINDOW's capture phase, which runs before the
 *   document-level capture listeners `CommandLayer` (global keymap) and `TemplatePicker` use, and
 *   before CodeMirror. Taking them at the document would lose to the global dispatcher for keys
 *   it binds in block selection — Backspace there deletes the selected blocks — since listeners
 *   on one target run in registration order and the dispatcher registered first.
 * - A shortcut with Cmd/Ctrl (other than paste) closes the picker and then does its usual job, so
 *   the picker never swallows Cmd+K or Cmd+Z and never sends Cmd+B into the block behind it.
 * - `.cmd-popup` on the root, so `BlockTree`'s click-away rule and `CommandLayer`'s trigger
 *   re-detection treat a click in here as part of the editing session.
 *
 * Mounted imperatively into `document.body` by `openDatePicker`, like `TemplatePicker`: a command
 * opens it, and a command has no JSX tree to render into.
 */
import { formatJournalTitle, type JournalDay, journalDayToDate } from "@nooklet/core";
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { render } from "solid-js/web";
import { claimPopupKeys } from "../popup-keys.js";
import type { DatePickRequest, DatePickResult } from "./host.js";
import { addDays, addMonths, parseDateInput, weekdayIndex } from "./parse.js";
import "../styles.css";
import "./date-picker.css";

export interface DatePickerOptions extends DatePickRequest {
  onPick: (result: DatePickResult) => void;
  onCancel: () => void;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const FIELD_LABEL = { scheduled: "Scheduled", deadline: "Deadline" } as const;

/** Every day shown for the month containing `day`: whole Monday-first weeks, so the leading and
 * trailing days of the neighbouring months are real, clickable days rather than blanks (the
 * arrows walk across a month boundary without the highlight vanishing). */
export function monthCells(day: JournalDay): JournalDay[] {
  const first = Math.floor(day / 100) * 100 + 1;
  const last = addDays(addMonths(first, 1), -1);
  const start = addDays(first, -weekdayIndex(first));
  const end = addDays(last, 6 - weekdayIndex(last));
  const cells: JournalDay[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) cells.push(d);
  return cells;
}

/** "every 2 weeks", "every month from done" — the stored `repeat` in words. */
export function describeRepeat(repeat: string): string {
  const m = /^(\d+)([dwmy])( from done)?$/.exec(repeat);
  if (!m) return repeat;
  const n = Number(m[1]);
  const unit = { d: "day", w: "week", m: "month", y: "year" }[m[2] as "d" | "w" | "m" | "y"];
  return `every ${n === 1 ? unit : `${n} ${unit}s`}${m[3] ? " from done" : ""}`;
}

/** Where to open when the command gave no anchor: under the caret when a block is being edited,
 * else under the block's row (block selection), else somewhere sane. */
export function anchorForBlock(blockId: string): { top: number; left: number } {
  const sel = window.getSelection();
  const focusNode = sel && sel.rangeCount > 0 ? sel.focusNode : null;
  const inEditor = focusNode
    ? (focusNode instanceof Element ? focusNode : focusNode.parentElement)?.closest(".cm-content")
    : null;
  if (inEditor && sel) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.top || rect.left) return { top: rect.bottom + 4, left: rect.left };
  }
  const row = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"] .vr-row-main`);
  if (row) {
    const rect = row.getBoundingClientRect();
    return { top: rect.bottom + 2, left: rect.left };
  }
  return { top: 80, left: 80 };
}

function DatePicker(props: DatePickerOptions & { close: () => void }) {
  // What the arrows, the month buttons and clicks have chosen. The typed query is layered on top
  // (`day()`/`time()`/`repeat()` below) rather than written into these on every keystroke, so
  // backspacing "fri 14:00" to "fri" gives back the time the block already had.
  const [baseDay, setBaseDay] = createSignal(props.current?.day ?? props.today);
  const [baseTime, setBaseTime] = createSignal<string | null>(props.current?.time ?? null);
  /** `undefined` = the block's own repeat, untouched. */
  const [baseRepeat, setBaseRepeat] = createSignal<string | null | undefined>(undefined);
  const [query, setQuery] = createSignal("");
  const [insist, setInsist] = createSignal(false);
  const [pos, setPos] = createSignal(props.anchor ?? anchorForBlock(props.blockId));
  let el: HTMLDivElement | undefined;

  const parsed = createMemo(() => parseDateInput(query(), props.today));
  const parts = () => {
    const p = parsed();
    return p.kind === "value" ? p.parts : {};
  };
  const day = () => parts().day ?? baseDay();
  const time = () => {
    const t = parts().time;
    return t !== undefined ? t : baseTime();
  };
  const repeatChange = () => {
    const p = parts();
    return "repeat" in p ? p.repeat : baseRepeat();
  };
  const repeatShown = () => {
    const r = repeatChange();
    return r === undefined ? props.repeat : r;
  };
  const invalidMessage = () => {
    const p = parsed();
    return p.kind === "invalid" ? p.message : undefined;
  };
  const cells = createMemo(() => monthCells(day()));
  const month = () => Math.floor(day() / 100);

  /** Fold the typed query into the base selection, then clear it — before anything that moves
   * the selection by hand, so ArrowRight after "fri" means Saturday. */
  function absorb(): void {
    const p = parts();
    if (p.day !== undefined) setBaseDay(p.day);
    if (p.time !== undefined) setBaseTime(p.time);
    if ("repeat" in p) setBaseRepeat(p.repeat);
    setQuery("");
    setInsist(false);
  }

  function move(fn: (d: JournalDay) => JournalDay): void {
    absorb();
    setBaseDay((d) => fn(d));
  }

  function cancel(): void {
    props.close();
    props.onCancel();
  }

  function finish(result: DatePickResult): void {
    props.close();
    props.onPick(result);
  }

  function commit(): void {
    const p = parsed();
    if (p.kind === "invalid") {
      setInsist(true);
      return;
    }
    if (p.kind === "clear") {
      finish({ kind: "clear" });
      return;
    }
    const repeat = repeatChange();
    finish({
      kind: "set",
      day: day(),
      time: time(),
      ...(repeat !== undefined ? { repeat } : {}),
    });
  }

  function pickDay(d: JournalDay): void {
    absorb();
    setBaseDay(d);
    commit();
  }

  function edit(next: string): void {
    setQuery(next);
    setInsist(false);
  }

  /** Every key while open. Returns true when the key was this picker's to consume. */
  function handleKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey">): boolean {
    switch (e.key) {
      case "Escape":
        cancel();
        return true;
      case "Enter":
        commit();
        return true;
      case "ArrowLeft":
        move((d) => addDays(d, -1));
        return true;
      case "ArrowRight":
        move((d) => addDays(d, 1));
        return true;
      case "ArrowUp":
        move((d) => addDays(d, -7));
        return true;
      case "ArrowDown":
        move((d) => addDays(d, 7));
        return true;
      case "PageUp":
        move((d) => addMonths(d, e.shiftKey ? -12 : -1));
        return true;
      case "PageDown":
        move((d) => addMonths(d, e.shiftKey ? 12 : 1));
        return true;
      case "Backspace":
        edit(e.altKey ? "" : query().slice(0, -1));
        return true;
      case "Tab":
        // Owned, not used: Tab must not indent the block behind the picker, and accepting on Tab
        // (as the slash menu does) would set a date nobody confirmed.
        return true;
      default:
        if (e.key.length === 1) {
          edit(query() + e.key);
          return true;
        }
        return false;
    }
  }

  // The keymap contexts read `popupOpen` from this claim. The dispatch below never reaches the
  // editor's `dispatchPopupKey` (the window listener stops the event first), but the claim is
  // what keeps the popup keys out of the global dispatcher and `when` clauses honest.
  const release = claimPopupKeys((key) => handleKey({ key, shiftKey: false, altKey: false }));
  onCleanup(release);

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        edit("");
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) return; // arrives as a `paste` event below
      if (mod) {
        // Close, and let the shortcut do what it always does.
        cancel();
        return;
      }
      if (["Shift", "Alt", "Meta", "Control", "CapsLock"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      handleKey(e);
    };
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      edit(query() + text.replace(/\s+/g, " "));
    };
    // A click anywhere but here means "never mind" — and still does whatever it was aimed at.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (target && el?.contains(target)) return;
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    });

    // Keep the whole popup on screen: flip above the anchor when there is no room below.
    if (el) {
      const rect = el.getBoundingClientRect();
      const margin = 8;
      const anchor = pos();
      let top = anchor.top;
      if (top + rect.height > window.innerHeight - margin) {
        top = Math.max(margin, anchor.top - rect.height - 28);
      }
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - rect.width - margin));
      setPos({ top, left });
    }
  });

  const preview = () => {
    const parts = [formatJournalTitle(day(), "EEE, MMM d, yyyy")];
    const t = time();
    if (t) parts.push(t);
    const r = repeatShown();
    if (r) parts.push(`↻ ${describeRepeat(r)}`);
    return parts.join(" · ");
  };

  const relative = () => {
    const diff = Math.round(
      (journalDayToDate(day()).getTime() - journalDayToDate(props.today).getTime()) / 86_400_000,
    );
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff === -1) return "yesterday";
    return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
  };

  return (
    // `onMouseDown` only keeps DOM focus where it was (the editor); keys arrive via the window.
    <div
      ref={el}
      class="cmd-popup date-picker"
      style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
      role="dialog"
      aria-label={`Set ${FIELD_LABEL[props.field].toLowerCase()} date`}
      data-field={props.field}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div class="dp-query">
        <span class="dp-label">{FIELD_LABEL[props.field]}</span>
        <Show
          when={query() !== ""}
          fallback={<span class="dp-hint">type tomorrow, fri, +3d, 20.9. 14:00…</span>}
        >
          <span class="dp-text">{query()}</span>
        </Show>
      </div>
      <div
        class="dp-preview"
        classList={{ "dp-preview--error": insist() && invalidMessage() !== undefined }}
        aria-live="polite"
      >
        <Switch
          fallback={
            <>
              <span class="dp-preview-date">{preview()}</span>
              <span class="dp-preview-rel">{relative()}</span>
            </>
          }
        >
          <Match when={invalidMessage()}>{(message) => message()}</Match>
          <Match when={parsed().kind === "clear"}>
            {props.current ? "Enter removes the date" : "No date to remove"}
          </Match>
        </Switch>
      </div>
      <div class="dp-month">
        <button
          type="button"
          class="dp-nav"
          aria-label="Previous month"
          tabIndex={-1}
          onClick={() => move((d) => addMonths(d, -1))}
        >
          ‹
        </button>
        <span class="dp-month-label">{formatJournalTitle(day(), "MMMM yyyy")}</span>
        <button
          type="button"
          class="dp-nav"
          aria-label="Next month"
          tabIndex={-1}
          onClick={() => move((d) => addMonths(d, 1))}
        >
          ›
        </button>
      </div>
      <div class="dp-grid">
        <For each={WEEKDAY_LABELS}>{(label) => <span class="dp-weekday">{label}</span>}</For>
        <For each={cells()}>
          {(d) => (
            <button
              type="button"
              tabIndex={-1}
              data-day={d}
              aria-pressed={d === day()}
              aria-current={d === props.today ? "date" : undefined}
              aria-label={formatJournalTitle(d, "EEEE, MMMM d, yyyy")}
              classList={{
                "dp-day": true,
                "dp-day--active": d === day(),
                "dp-day--other": Math.floor(d / 100) !== month(),
                "dp-day--today": d === props.today,
                "dp-day--current": d === props.current?.day,
              }}
              onClick={() => pickDay(d)}
            >
              {d % 100}
            </button>
          )}
        </For>
      </div>
      <div class="dp-quick">
        <button
          type="button"
          tabIndex={-1}
          class="dp-quick-btn"
          onClick={() => pickDay(props.today)}
        >
          Today
        </button>
        <button
          type="button"
          tabIndex={-1}
          class="dp-quick-btn"
          onClick={() => pickDay(addDays(props.today, 1))}
        >
          Tomorrow
        </button>
        <button
          type="button"
          tabIndex={-1}
          class="dp-quick-btn"
          onClick={() => pickDay(addDays(props.today, 7 - weekdayIndex(props.today)))}
        >
          Next week
        </button>
        <Show when={props.current}>
          <button
            type="button"
            tabIndex={-1}
            class="dp-quick-btn dp-remove"
            onClick={() => finish({ kind: "clear" })}
          >
            Remove
          </button>
        </Show>
      </div>
      <div class="dp-keys" aria-hidden="true">
        <kbd>↵</kbd> set <kbd>esc</kbd> cancel <kbd>←↑↓→</kbd> day <kbd>PgUp/Dn</kbd> month
      </div>
    </div>
  );
}

let closeOpen: (() => void) | undefined;

/** Open the picker. Returns a function that closes it without picking (also called internally on
 * pick/cancel; safe to call twice). One picker at a time: opening a second closes the first as
 * cancelled. */
export function openDatePicker(opts: DatePickerOptions): () => void {
  closeOpen?.();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let disposed = false;
  let dispose: (() => void) | undefined;
  let settled = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    if (closeOpen === closeAsCancel) closeOpen = undefined;
    dispose?.();
    host.remove();
  };
  const wrapped: DatePickerOptions = {
    ...opts,
    onPick: (r) => {
      settled = true;
      opts.onPick(r);
    },
    onCancel: () => {
      settled = true;
      opts.onCancel();
    },
  };
  const closeAsCancel = (): void => {
    close();
    if (!settled) {
      settled = true;
      opts.onCancel();
    }
  };
  closeOpen = closeAsCancel;
  dispose = render(() => <DatePicker {...wrapped} close={close} />, host);
  if (disposed) dispose();
  return closeAsCancel;
}
