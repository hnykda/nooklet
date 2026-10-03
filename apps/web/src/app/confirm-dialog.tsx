/**
 * An in-page "are you sure?" dialog, resolving `true` for the confirm button and `false` for
 * everything else (Cancel, Escape, a click on the backdrop).
 *
 * Why not `window.confirm`: in the desktop app it never asks. wry's WKWebView UI delegate
 * implements none of WebKit's JavaScript panel methods, and WebKit then answers `confirm()` with
 * Cancel on the spot — `tools/probes/wkwebview-confirm.swift` prints `confirm returned false after
 * 0 ms` (B-491). A delete behind `window.confirm` would silently never happen there, while every
 * Chromium e2e test passed.
 *
 * Rendered on demand into its own root under `document.body`, like the page picker
 * (`./refactor-host.tsx#pickPage`), because a command's `run()` is imperative and the dialog has
 * no place in the routed tree. The palette awaits a command before it closes, so a caller running
 * from the palette closes it first.
 */

import { For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { rememberFocus } from "../commands/focus-return.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import "./confirm-dialog.css";

export interface ConfirmOptions {
  title: string;
  /** One string per paragraph. */
  message: string[];
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /** No Cancel button: the dialog only reports something (`noticeDialog`), standing in for
   * `window.alert`, which the desktop app's webview swallows as well (B-491). */
  acknowledgeOnly?: boolean;
}

function ConfirmDialog(props: ConfirmOptions & { onDone: (ok: boolean) => void }): JSX.Element {
  let confirmEl: HTMLButtonElement | undefined;
  let cancelEl: HTMLButtonElement | undefined;

  onMount(() => {
    // Escape must reach the dialog, not the editor's keymap behind it (which would turn the block
    // being edited into a selection, B-72) — the claim the palette and the picker make too.
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      props.onDone(false);
      return true;
    });
    onCleanup(release);
    // The action has focus: Enter confirms, as in a native sheet. Nothing here is irreversible —
    // Delete page moves a page to the Trash, History's undos are themselves undoable — and a person who opened the dialog from the
    // palette with Enter has already let go of the key by the time it renders.
    queueMicrotask(() => confirmEl?.focus());
  });

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onDone(false);
    } else if (e.key === "Tab") {
      // Two buttons (or just the one); keep Tab between them rather than walking into the page behind the scrim.
      e.preventDefault();
      (document.activeElement === confirmEl ? cancelEl : confirmEl)?.focus();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss, as the palette does; the keyboard dismisses with Escape.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
    <div class="cmd-overlay confirm-dialog-overlay" onClick={() => props.onDone(false)}>
      <div
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-dialog-title" class="confirm-dialog-title">
          {props.title}
        </h2>
        <div id="confirm-dialog-message" class="confirm-dialog-message">
          <For each={props.message}>{(line) => <p>{line}</p>}</For>
        </div>
        <div class="confirm-dialog-buttons">
          <Show when={props.acknowledgeOnly !== true}>
            <button
              ref={cancelEl}
              type="button"
              class="confirm-dialog-button"
              onClick={() => props.onDone(false)}
            >
              {props.cancelLabel ?? "Cancel"}
            </button>
          </Show>
          <button
            ref={confirmEl}
            type="button"
            class="confirm-dialog-button confirm-dialog-confirm"
            classList={{ "confirm-dialog-destructive": props.destructive === true }}
            onClick={() => props.onDone(true)}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The open dialog's answer, if one is open: a second dialog cancels the first rather than
 * stacking on it or leaving its promise unsettled. */
let answerOpen: ((ok: boolean) => void) | null = null;

/** Ask; resolves once, with `true` only for the confirm button. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  answerOpen?.(false);
  return new Promise((resolve) => {
    const root = document.createElement("div");
    // Before the dialog takes focus, so Cancel hands it back to the block being edited.
    const giveFocusBack = rememberFocus(() => root);
    document.body.appendChild(root);
    let settled = false;
    let dispose = (): void => {};
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (answerOpen === done) answerOpen = null;
      dispose();
      root.remove();
      giveFocusBack();
      resolve(ok);
    };
    answerOpen = done;
    dispose = render(() => <ConfirmDialog {...opts} onDone={done} />, root);
  });
}

/**
 * Tell the person something went wrong, in the page: the in-app `window.alert`. Resolves once it is
 * dismissed (OK, Escape or the backdrop). Not `alert()`: in the desktop app that shows nothing, and
 * a failed action would fail without a word (B-491).
 */
export async function noticeDialog(title: string, message: string[]): Promise<void> {
  await confirmDialog({ title, message, confirmLabel: "OK", acknowledgeOnly: true });
}
