/**
 * The page-icon picker (B-647): a search field over a grid of emoji, opened from the icon slot in
 * the page title row. Shaped after Logseq's own icon picker (`src/main/frontend/components/
 * icon.cljs`: a search field, a "frequently used" section, the emoji in sections, arrow keys into
 * the grid, Enter to pick, a delete button) minus what it adds on top — Tabler icons, colours,
 * skin tones — which this app leaves out on purpose.
 *
 * Keys stay in the search field the whole time; the highlighted cell is announced through
 * `aria-activedescendant`, so typing never needs a click back into the field:
 * - typing searches English names and keywords; a typed or pasted emoji is offered as itself;
 * - Down (or Tab) enters the grid, arrows move, Up from the top row returns to the field;
 * - Enter picks the highlighted cell (with a query, the first result is highlighted already);
 * - Escape clears the query, and with nothing typed closes the picker.
 */

import Clock from "lucide-solid/icons/clock";
import Trash2 from "lucide-solid/icons/trash-2";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { loadEmojiIndex } from "../emoji/load.js";
import { readRecents } from "../emoji/recents.js";
import {
  browseSections,
  type EmojiSection,
  moveInGrid,
  rawEmoji,
  searchEmoji,
} from "../emoji/search.js";
import "./emoji-picker.css";

/** Fixed, not measured: arrow movement needs the column count, and 8 cells of a 358px phone
 * popover are still ~42px touch targets. */
const COLS = 8;

let pickerSeq = 0;

export function EmojiPicker(props: {
  /** The page's current icon, if any: offers "Remove". */
  current: string | undefined;
  onPick: (emoji: string) => void;
  onRemove: () => void;
  /** `viaKeyboard` false: closed by a tap or click elsewhere — focus belongs where it went. */
  onClose: (viaKeyboard: boolean) => void;
  /** The trigger: a press on it is not "outside" (it toggles the picker itself). */
  anchor?: HTMLElement | undefined;
  style?: JSX.CSSProperties;
}): JSX.Element {
  const id = `emoji-picker-${++pickerSeq}`;
  const [query, setQuery] = createSignal("");
  /** Flat index of the highlighted cell across all sections; -1 = none (keys are the field's). */
  const [active, setActive] = createSignal(-1);
  const [index] = createResource(loadEmojiIndex);
  const recents = readRecents();
  let root: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let body: HTMLDivElement | undefined;

  const searching = () => query().trim() !== "";

  const sections = createMemo((): EmojiSection[] => {
    const q = query();
    const raw = rawEmoji(q);
    if (raw !== null) return [{ title: "Use what you typed", rows: [[raw, raw, "", -1]] }];
    const idx = index();
    if (!searching()) {
      if (idx) return browseSections(idx.data, recents);
      // Not loaded (yet, or offline): recents need no list.
      return recents.length > 0 ? browseSections({ groups: [], emojis: [] }, recents) : [];
    }
    if (!idx) return [];
    const rows = searchEmoji(idx, q);
    return rows.length > 0 ? [{ title: "Results", rows }] : [];
  });

  const offsets = createMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const s of sections()) {
      out.push(acc);
      acc += s.rows.length;
    }
    return out;
  });
  const flat = createMemo(() => sections().flatMap((s) => s.rows));

  // A new query highlights its first result, so Enter right after typing picks it. Browsing
  // starts with nothing highlighted: Enter there must not pick a recent nobody pointed at.
  createEffect(() => {
    sections();
    setActive(searching() && flat().length > 0 ? 0 : -1);
  });

  createEffect(() => {
    const i = active();
    if (i < 0) return;
    // `block: "nearest"` keeps a section heading in view when the highlight is just below it.
    document.getElementById(`${id}-${i}`)?.scrollIntoView?.({ block: "nearest" });
  });

  onMount(() => {
    input?.focus();
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t || root?.contains(t) || props.anchor?.contains(t)) return;
      props.onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onDown, true));
  });

  function pick(i: number): void {
    const row = flat()[i];
    if (row) props.onPick(row[0]);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const key = e.key;
    if (key === "Escape") {
      e.preventDefault();
      // Stop here: the page and the shell have their own Escape (leave editing, close panels).
      e.stopPropagation();
      if (query() !== "") setQuery("");
      else props.onClose(true);
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      if (e.isComposing) return;
      if (active() >= 0) pick(active());
      return;
    }
    if (key === "Tab" && !e.shiftKey && active() < 0 && flat().length > 0) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
      // Left/Right belong to the caret until the grid has been entered.
      if (active() < 0 && (key === "ArrowLeft" || key === "ArrowRight")) return;
      e.preventDefault();
      setActive(
        moveInGrid(
          sections().map((s) => s.rows.length),
          active(),
          key,
          COLS,
        ),
      );
    }
  }

  function jumpTo(sectionIndex: number): void {
    const el = body?.querySelector<HTMLElement>(`[data-section="${sectionIndex}"]`);
    if (body && el) body.scrollTop = el.offsetTop - body.offsetTop;
  }

  return (
    <div
      ref={root}
      class="emoji-picker"
      role="dialog"
      aria-label="Page icon"
      style={props.style}
      // A native listener, not Solid's delegated `onKeyDown` (which runs at the document): the
      // Escape below has to stop before the shell's own bubbling Escape handlers see it.
      on:keydown={onKeyDown}
    >
      <div class="emoji-picker-head">
        <input
          ref={input}
          class="emoji-picker-search"
          type="search"
          value={query()}
          placeholder="Search emoji"
          aria-label="Search emoji"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-grid`}
          aria-activedescendant={active() >= 0 ? `${id}-${active()}` : undefined}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={props.current}>
          <button
            type="button"
            class="emoji-picker-remove"
            title="Remove icon"
            aria-label="Remove icon"
            onClick={() => props.onRemove()}
          >
            <Trash2 size={15} />
            <span>Remove</span>
          </button>
        </Show>
      </div>

      <div ref={body} class="emoji-picker-body" id={`${id}-grid`} role="listbox">
        <For each={sections()}>
          {(section, s) => (
            <div class="emoji-picker-section" data-section={s()}>
              <div class="emoji-picker-section-title">{section.title}</div>
              <div class="emoji-picker-grid">
                <For each={section.rows}>
                  {(row, i) => {
                    const flatIndex = () => (offsets()[s()] ?? 0) + i();
                    return (
                      <button
                        type="button"
                        tabIndex={-1}
                        id={`${id}-${flatIndex()}`}
                        class="emoji-picker-cell"
                        classList={{ "emoji-picker-cell-active": active() === flatIndex() }}
                        role="option"
                        aria-selected={active() === flatIndex()}
                        aria-label={row[1]}
                        title={row[1]}
                        // Keep the caret in the search field on a mouse click; a tap closes anyway.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(flatIndex())}
                      >
                        {row[0]}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
        <Show when={sections().length === 0}>
          <div class="emoji-picker-empty">
            <Show
              when={!index.error}
              fallback="The emoji list could not load offline. Type or paste an emoji instead."
            >
              {index.loading ? "Loading…" : "No emoji found."}
            </Show>
          </div>
        </Show>
      </div>

      <div class="emoji-picker-foot">
        <Show
          when={!searching() && index()}
          fallback={
            <span class="emoji-picker-name">
              {active() >= 0 ? (flat()[active()]?.[1] ?? "") : ""}
            </span>
          }
        >
          <nav class="emoji-picker-groups" aria-label="Emoji categories">
            <For each={sections()}>
              {(section, s) => (
                <button
                  type="button"
                  tabIndex={-1}
                  class="emoji-picker-group"
                  title={section.title}
                  aria-label={section.title}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpTo(s())}
                >
                  <Show when={section.title !== "Recently used"} fallback={<Clock size={15} />}>
                    {section.rows[0]?.[0]}
                  </Show>
                </button>
              )}
            </For>
          </nav>
        </Show>
      </div>
    </div>
  );
}
