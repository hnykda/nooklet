/**
 * A page's icon: one emoji (or short glyph) stored as the `icon` page property — the same
 * property Logseq uses, so an imported graph's icons show up and ours round-trip back.
 *
 * Two pieces. `PageIconBadge` is the read-only mark for lists (sidebar, all pages). `PageIconEditor`
 * sits in the page title row: click it to type or paste an emoji, Enter to keep it, empty to
 * clear. No picker library on purpose — an emoji is one keystroke away on every OS
 * (Ctrl/Cmd+Space, Win+.), and a popover of 1,800 glyphs is the kind of thing this app is not.
 */

import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { setPageIcon } from "../data/store.js";

/** Asks the title row's icon editor for `pageId` to open, from somewhere other than its own
 * button — the page "…" menu (`PageActions.tsx`), which is how a touch screen reaches it: the empty
 * icon slot only shows on hover, so on a phone it is not in the row at all (B-225). A fresh object
 * per request, so asking twice for the same page opens it twice. */
const [iconEditRequest, setIconEditRequest] = createSignal<{ pageId: string } | null>(null);
export function requestPageIconEdit(pageId: string): void {
  setIconEditRequest({ pageId });
}

/** Trim to something that reads as one icon: the first grapheme, so a flag or a skin-toned emoji
 * survives intact but "🔥🔥🔥 wow" becomes "🔥". */
function firstGrapheme(s: string): string {
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = seg.segment(trimmed)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment;
}

export function PageIconBadge(props: { icon: string | undefined }): JSX.Element {
  return (
    <Show when={props.icon}>
      {(icon) => (
        <span class="page-icon" aria-hidden="true">
          {icon()}
        </span>
      )}
    </Show>
  );
}

export function PageIconEditor(props: { pageId: string; icon: string | undefined }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;

  createEffect(() => {
    if (editing()) {
      input?.focus();
      input?.select();
    }
  });

  function open(): void {
    // Seed the draft here, on the way in — not in an effect keyed on `editing()`. An effect that
    // reset the draft whenever editing turned off ran synchronously inside `commit()`'s
    // `setEditing(false)`, before the draft had been read, so every edit committed the OLD value.
    setDraft(props.icon ?? "");
    setEditing(true);
  }

  // `defer`: a request made before this editor mounted (another page's, or an old one) is not a
  // request to open this one now.
  createEffect(
    on(
      iconEditRequest,
      (req) => {
        if (req?.pageId === props.pageId) open();
      },
      { defer: true },
    ),
  );

  async function commit(): Promise<void> {
    const next = firstGrapheme(draft());
    setEditing(false);
    if (next === (props.icon ?? "")) return;
    await setPageIcon(props.pageId, next === "" ? null : next);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          class="page-icon-button"
          classList={{ "page-icon-button-empty": !props.icon }}
          title={props.icon ? "Change icon" : "Add an icon"}
          aria-label={props.icon ? `Page icon ${props.icon}, click to change` : "Add a page icon"}
          onClick={open}
        >
          {props.icon ?? "＋"}
        </button>
      }
    >
      <input
        ref={input}
        class="page-icon-input"
        value={draft()}
        maxLength={16}
        placeholder="🙂"
        aria-label="Page icon"
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(props.icon ?? "");
            setEditing(false);
          }
        }}
      />
    </Show>
  );
}
