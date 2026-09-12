/**
 * The second step of `/template`: which one? (ADR 019.)
 *
 * `SlashMenu` is a flat list of commands and runs the chosen one with no argument, so a single
 * "Template" row cannot know which template was meant. This popup opens where the caret is, lists
 * the templates, narrows as you type, and hands the pick back to `block.insertTemplate`.
 *
 * It follows the slash menu's rules rather than the palette's: the editor KEEPS focus (nothing
 * here is focusable), the popup claims Escape/Enter/Up/Down/Tab through `claimPopupKeys` so the
 * editor's keymap yields them, and the characters you type to filter are taken at the document's
 * capture phase before CodeMirror can see them — so filtering does not also type into the block.
 * Clicking a row is a `mousedown` that does not take focus, for the reason `SlashMenu` gives
 * (B-71). `BlockTree` already exempts `.cmd-popup` from its click-away-ends-editing rule.
 *
 * Mounted imperatively into `document.body` by `openTemplatePicker`: this popup is opened by a
 * COMMAND, not by a text trigger, so it has no place among `CommandLayer`'s trigger-driven
 * overlays, and a command has no JSX tree to render into. One root per open, disposed on close.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import type { TemplateSummary } from "../../data/templates.js";
import { claimPopupKeys, POPUP_OWNED_KEYS } from "../popup-keys.js";
import "../styles.css";
import "./template-picker.css";

export interface TemplatePickerOptions {
  templates: readonly TemplateSummary[];
  /** Viewport coordinates, as `CommandLayer` positions the slash menu. */
  position: { top: number; left: number };
  onPick: (template: TemplateSummary) => void;
  onCancel: () => void;
}

/** Where a popup opened by a command should appear: under the caret, like the slash menu, or at
 * a sane fixed spot when there is no selection rectangle to read (nothing focused, or a test
 * environment without layout). */
export function caretPopupPosition(): { top: number; left: number } {
  if (typeof window === "undefined") return { top: 0, left: 0 };
  const sel = window.getSelection();
  const rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : undefined;
  if (rect && (rect.top || rect.left)) return { top: rect.bottom, left: rect.left };
  return { top: 80, left: 80 };
}

function TemplatePicker(props: TemplatePickerOptions & { close: () => void }) {
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let el: HTMLDivElement | undefined;

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (q === "") return props.templates;
    return props.templates.filter((t) => t.name.toLowerCase().includes(q));
  });

  function cancel(): void {
    props.close();
    props.onCancel();
  }

  function pick(index: number): void {
    const row = rows()[index];
    if (!row) return;
    props.close();
    props.onPick(row);
  }

  function handleKey(key: string): boolean {
    const list = rows();
    if (key === "Escape") {
      cancel();
      return true;
    }
    if (key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      return true;
    }
    if (key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      return true;
    }
    if (key === "Enter" || key === "Tab") {
      pick(highlight());
      return true;
    }
    return false;
  }

  // The keymap contexts read `popupOpen` from this claim; the keys themselves arrive through the
  // capture listener below, which runs first and stops them there.
  createEffect(() => {
    const release = claimPopupKeys(handleKey);
    onCleanup(release);
  });

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (POPUP_OWNED_KEYS.has(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        handleKey(e.key);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        setQuery((q) => q.slice(0, -1));
        setHighlight(0);
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        setQuery((q) => q + e.key);
        setHighlight(0);
      }
    };
    // A click anywhere but on this popup means "never mind". Capture phase, so it is decided
    // before whatever was clicked reacts.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (target && el?.contains(target)) return;
      cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    });
  });

  return (
    <div
      ref={el}
      class="cmd-popup tpl-picker"
      style={{ top: `${props.position.top}px`, left: `${props.position.left}px` }}
      role="listbox"
      aria-label="Insert template"
    >
      <div class="tpl-picker-query" aria-live="polite">
        <span class="tpl-picker-label">Template</span>
        <Show when={query() !== ""} fallback={<span class="tpl-picker-hint">type to filter</span>}>
          <span class="tpl-picker-text">{query()}</span>
        </Show>
      </div>
      <For each={rows()}>
        {(t, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the document-level listener above, not per-row.
          <div
            role="option"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            aria-selected={i() === highlight()}
            classList={{ "cmd-row": true, "cmd-row--active": i() === highlight() }}
            onMouseEnter={() => setHighlight(i())}
            onClick={() => pick(i())}
          >
            <span>{t.name}</span>
            <Show when={t.journal}>
              <span class="cmd-row-subtitle">journal</span>
            </Show>
          </div>
        )}
      </For>
      <Show when={rows().length === 0}>
        <div class="cmd-empty">
          {props.templates.length === 0
            ? "No templates yet — give a block a template:: name property"
            : "No match"}
        </div>
      </Show>
    </div>
  );
}

/** Open the picker. Returns a function that closes it without picking (also called internally on
 * pick/cancel; safe to call twice). */
export function openTemplatePicker(opts: TemplatePickerOptions): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let disposed = false;
  let dispose: (() => void) | undefined;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    dispose?.();
    host.remove();
  };
  dispose = render(() => <TemplatePicker {...opts} close={close} />, host);
  if (disposed) dispose();
  return close;
}
