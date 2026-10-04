/**
 * A page's icon: one emoji (or short glyph) stored as the `icon` page property — the same
 * property Logseq uses, so an imported graph's icons show up and ours round-trip back.
 *
 * Two pieces. `PageIconBadge` is the read-only mark for lists (sidebar, all pages). `PageIconEditor`
 * sits in the page title row: click it to open the emoji picker (`EmojiPicker.tsx`), which
 * searches by name, offers recents and categories, takes a typed or pasted emoji as is, and can
 * remove the icon. This used to be a bare one-character field, on the theory that the OS emoji
 * keyboard is one keystroke away; on a phone it was not discoverable and typing a word put the
 * word's first letter in as the icon (B-647).
 */

import { createEffect, createSignal, type JSX, Show, untrack } from "solid-js";
import { setPageIcon } from "../data/store.js";
import { rememberRecent } from "../emoji/recents.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { consumePageIconEdit, pendingPageIconEdit } from "./page-icon-request.js";

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
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let button: HTMLButtonElement | undefined;

  // The page actions menu's "Add icon" (B-225: on a phone the empty slot is not shown at all).
  createEffect(() => {
    if (pendingPageIconEdit() !== props.pageId) return;
    consumePageIconEdit();
    untrack(show);
  });

  function show(): void {
    // Under the button, inside the title row (`.page-title-row` is the offset parent). A hidden
    // button (the empty slot on a touch screen, opened from the "…" menu instead) has no box:
    // then just under the title's first line.
    const visible = button !== undefined && button.offsetParent !== null;
    const top = visible ? button.offsetTop + button.offsetHeight : 40;
    setPosition({ top: `${top + 6}px`, left: `${visible ? button.offsetLeft : 0}px` });
    setOpen(true);
  }

  function close(viaKeyboard: boolean): void {
    setOpen(false);
    // Back to the slot after a key, so Escape or Enter leaves the keyboard where it started; a
    // tap elsewhere keeps focus where the tap put it.
    if (viaKeyboard && button?.offsetParent) button.focus();
  }

  async function choose(icon: string | null): Promise<void> {
    close(true);
    if (icon !== null) rememberRecent(icon);
    if (icon === (props.icon ?? null)) return;
    await setPageIcon(props.pageId, icon);
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        class="page-icon-button"
        classList={{ "page-icon-button-empty": !props.icon }}
        title={props.icon ? "Change icon" : "Add an icon"}
        aria-label={props.icon ? `Page icon ${props.icon}, click to change` : "Add a page icon"}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => (open() ? close(false) : show())}
      >
        {props.icon ?? "＋"}
      </button>
      <Show when={open()}>
        <EmojiPicker
          current={props.icon}
          anchor={button}
          style={position()}
          onPick={(emoji) => void choose(emoji)}
          onRemove={() => void choose(null)}
          onClose={close}
        />
      </Show>
    </>
  );
}
