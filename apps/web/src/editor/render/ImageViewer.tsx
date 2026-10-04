/**
 * The full-size view an image in a note opens into (B-736): the picture, and Copy image /
 * Download / Open in new tab. Before this, a click on an image did what a click anywhere in a
 * block does — entered the editor — so the picture was replaced by its `![…](assets/….png)`
 * source and there was nothing left to act on.
 *
 * A plain overlay rather than `<dialog>.showModal()`: jsdom has no `showModal`, and the rest of
 * the app's overlays are divs too. Keys are taken at `window` in the CAPTURE phase, which runs
 * before the command layer's own capture listener on `document` (`../../app/CommandLayer.tsx`):
 * otherwise Escape would also leave the block behind, and Backspace with a block selected
 * underneath would delete it while the viewer is up. Every key stops there; Enter/Space still
 * press the focused button, because only propagation is stopped, not the default action.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { claimPopupKeys } from "../../commands/popup-keys.js";
import { type ActionResult, copyImage, downloadImage, imageHost } from "./image-actions.js";

export function ImageViewer(props: {
  /** The fetchable URL (`assetUrl(src)`), what the picture is drawn from. */
  url: string;
  /** The source as written in the note — the download name is taken from it. */
  src: string;
  alt: string;
  onClose: () => void;
  /** Close and edit the block the image is in. Absent where the block is not editable. */
  onEditBlock?: () => void;
}) {
  const host = imageHost();
  // B-744: results are toasts, and no button is ever disabled. One action at a time used to
  // disable both, and a clipboard write that never settled (seen in the Mac app) left them dead;
  // copying and then downloading the same picture is an ordinary thing to want.
  const [toasts, setToasts] = createSignal<Array<ActionResult & { id: number }>>([]);
  const [pending, setPending] = createSignal<ReadonlySet<"copy" | "download">>(new Set());
  let nextToast = 0;
  let panel: HTMLDivElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  const opener = document.activeElement as HTMLElement | null;

  function toast(result: ActionResult): void {
    const id = nextToast++;
    setToasts((list) => [...list, { ...result, id }]);
    // Errors stay longer: they usually say what to do instead.
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), result.ok ? 5000 : 9000);
  }

  async function run(
    kind: "copy" | "download",
    action: () => Promise<ActionResult>,
  ): Promise<void> {
    if (pending().has(kind)) return; // a second click on the same, still-running action
    setPending((set) => new Set(set).add(kind));
    try {
      toast(await action());
    } finally {
      setPending((set) => {
        const next = new Set(set);
        next.delete(kind);
        return next;
      });
    }
  }

  function buttons(): HTMLElement[] {
    return panel ? [...panel.querySelectorAll<HTMLElement>("button:not([disabled])")] : [];
  }

  onMount(() => {
    closeButton?.focus();
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      } else if (e.key === "Tab") {
        // Keep focus inside: the page behind is inert while this is open.
        const list = buttons();
        if (list.length === 0) return;
        const at = list.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey
          ? at <= 0
            ? list.length - 1
            : at - 1
          : at === -1 || at === list.length - 1
            ? 0
            : at + 1;
        e.preventDefault();
        list[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Also tell the editor's keymap something is open, as the block menu does (B-72).
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      props.onClose();
      return true;
    });
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      release();
      // Back where the person was — the image, when it was opened from the keyboard.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  });

  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the keyboard closes it with Escape or the Close button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
      <div
        class="image-viewer-backdrop"
        // A portal's events still bubble to the component that rendered it (Solid's `_$host`),
        // which is the block row: without stopping them a click here would also enter the editor.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div
          ref={panel}
          class="image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={props.alt ? `Image: ${props.alt}` : "Image"}
        >
          <div class="image-viewer-toolbar">
            <button
              type="button"
              class="image-viewer-btn"
              aria-busy={pending().has("copy")}
              onClick={() => void run("copy", () => copyImage(props.url))}
            >
              {pending().has("copy") ? "Copying…" : "Copy image"}
            </button>
            <button
              type="button"
              class="image-viewer-btn"
              aria-busy={pending().has("download")}
              onClick={() =>
                void run("download", () => downloadImage(props.url, props.src, props.alt, host))
              }
            >
              {host === "phone" ? "Save / Share…" : "Download"}
            </button>
            {/* A phone's webview has no tabs to open it in. */}
            <Show when={host !== "phone"}>
              <button
                type="button"
                class="image-viewer-btn"
                onClick={() => window.open(props.url, "_blank", "noopener")}
              >
                Open in new tab
              </button>
            </Show>
            {/* A block that is only a wide picture has nothing else to click to edit it. */}
            <Show when={props.onEditBlock}>
              {(edit) => (
                <button type="button" class="image-viewer-btn" onClick={() => edit()()}>
                  Edit block
                </button>
              )}
            </Show>
            <span class="image-viewer-spacer" />
            <button
              ref={closeButton}
              type="button"
              class="image-viewer-btn image-viewer-close"
              aria-label="Close"
              onClick={() => props.onClose()}
            >
              ✕
            </button>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the picture is a backdrop too — a click on it closes, like a click beside it. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the Close button cover the keyboard. */}
          <div class="image-viewer-stage" onClick={() => props.onClose()}>
            <img class="image-viewer-img" src={props.url} alt={props.alt} />
          </div>
          <div class="image-viewer-toasts" role="status" aria-live="polite">
            <For each={toasts()}>
              {(t) => (
                <p
                  class="image-viewer-toast"
                  classList={{ "image-viewer-toast-error": !t.ok }}
                  // Clicking a toast must not close the viewer (the stage behind closes on click).
                  onClick={(e) => e.stopPropagation()}
                >
                  {t.message}
                </p>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
