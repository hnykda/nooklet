/**
 * An image in a note (B-703, B-736, B-789): the picture, sized and aligned as the block says, with
 * Logseq's two controls on a pointer that can hover — a handle on its edge to resize it and a ⋯
 * menu (Copy image, Download, Show in Finder, alignment, original size).
 *
 * **Size and alignment live in the block's text**, in Logseq's own map after the image,
 * `![a](assets/x.png){:width 320, :align "center"}` (ADR 034, `@nooklet/core`'s `image-meta.ts`).
 * A drag writes ONE `block.text` when it ends, through the tree's normal commit (`ctx.onRewrite`),
 * so it is one undo step and syncs like typing; while it is under way only this view's own signal
 * changes.
 *
 * **The box carries the width, not the `<img>`.** The handle and the ⋯ need a positioned box
 * around the picture, and a percentage width on an image inside a shrink-to-fit box resolves
 * against that box — 0 wide before the bytes arrive, which undid B-703's reserved space. So the
 * box gets the width (`min(100%, Npx)`: never wider than the column, which on a phone is never
 * wider than the screen, B-682/B-683) and the picture fills it at its own aspect ratio. With no
 * size chosen and none known, the box shrinks to the picture as before.
 *
 * **Click opens, ⋯ acts, the edge resizes** — Logseq's split (`asset-container` in its
 * `components/block.cljs`: a click on the `<img>` opens the lightbox, the action bar appears on
 * hover). A click is what a person tries first and the viewer is where the big picture is; the
 * menu is for acting on the picture without opening it. Both share `./image-actions.ts`.
 *
 * **Touch: neither control.** A phone has no hover to reveal them, a drag on a block row is
 * already the swipe-to-indent gesture (`../gestures/`), and the picture is already as wide as the
 * screen allows, so a handle could mostly only shrink it. Logseq hides its handles on mobile too
 * (`resizable?` is `(not (mobile-util/native-platform?))`). The tap still opens the viewer, which
 * has Save / Share and Copy (B-736). Recorded in ADR 034.
 */
import {
  type ImageAlign,
  type ImageMetaChange,
  type InlineToken,
  setImageMeta,
} from "@nooklet/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  Maximize2,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { detectPlatformFromEnvironment } from "../../commands/keymap/platform.js";
import { claimPopupKeys } from "../../commands/popup-keys.js";
import { lookupAssetSize } from "../../data/asset-sizes.js";
import { assetIdOf, assetUrl } from "./asset-url.js";
import { ImageViewer } from "./ImageViewer.js";
import {
  type ActionResult,
  copyImage,
  downloadImage,
  imageHost,
  revealImage,
  revealLabel,
  revealTarget,
} from "./image-actions.js";
import type { RenderCtx } from "./tokens.js";

type ImageTok = Extract<InlineToken, { kind: "image" }>;

/** The narrowest a drag can make a picture: still something to see and to grab again. */
export const MIN_IMAGE_WIDTH = 48;

/** Below this the ⋯ would cover the middle of the picture — where a click opens it — so it sits
 * just outside, against the picture's right edge. */
const NARROW_IMAGE = 120;

/** The width the content column offers `box` (its parent's content box). */
function columnWidth(box: HTMLElement): number {
  const parent = box.parentElement;
  if (!parent) return Number.POSITIVE_INFINITY;
  const cs = getComputedStyle(parent);
  const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  return Math.max(MIN_IMAGE_WIDTH, parent.clientWidth - pad);
}

export function ImageView(props: { tok: ImageTok; ctx: RenderCtx }) {
  const size = createMemo(() => {
    const id = assetIdOf(props.tok.src);
    return id === undefined ? undefined : lookupAssetSize(id);
  });
  const url = () => assetUrl(props.tok.src);
  const align = (): ImageAlign => props.tok.meta?.align ?? "left";
  // The width on screen while a drag is under way; the block's own width otherwise.
  const [dragWidth, setDragWidth] = createSignal<number | null>(null);
  const width = () => dragWidth() ?? props.tok.meta?.width;
  // The drag's write has landed (or the block changed under it): show what the text says.
  createEffect(
    on(
      () => props.tok.meta?.width,
      () => setDragWidth(null),
      { defer: true },
    ),
  );

  const boxStyle = () => {
    const w = width();
    if (w !== undefined) return `width: min(100%, ${w}px)`;
    const s = size();
    // B-703's box: the picture's own width, scaled down (never up) to the column and to 70vh.
    if (s) return `width: min(100%, ${s.width}px, calc(70vh * ${s.width} / ${s.height}))`;
    return undefined;
  };
  const imgStyle = () => {
    const s = size();
    return s ? `aspect-ratio: ${s.width} / ${s.height}` : undefined;
  };

  // A pointer that can hover gets the controls; a phone gets the tap (see the header).
  const touch = detectPlatformFromEnvironment().mobile;
  let box: HTMLSpanElement | undefined;
  // Inside a link the picture IS the link: no controls that would fight it.
  const [inLink, setInLink] = createSignal(false);
  const editable = () => props.ctx.onRewrite !== undefined && !inLink();
  const showControls = () => !touch && !inLink();

  function rewrite(change: ImageMetaChange): void {
    const write = props.ctx.onRewrite;
    if (!write) return;
    const next = setImageMeta(props.ctx.source, props.tok.metaAt, change);
    if (next !== props.ctx.source) write(next);
  }

  // ---- the viewer (B-736) -----------------------------------------------------------------
  const [open, setOpen] = createSignal(false);
  // Modified clicks are left to the block row, which owns Shift (shelf) and Cmd/Ctrl (select); a
  // picture inside a link stays the link.
  const opensViewer = (e: MouseEvent | KeyboardEvent, el: HTMLElement): boolean =>
    !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) && el.closest("a") === null;

  // ---- the resize handle ------------------------------------------------------------------
  function onHandleDown(e: PointerEvent): void {
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = box.getBoundingClientRect().width;
    const max = columnWidth(box);
    // A right-aligned picture grows leftwards (its handle is on the left); a centred one grows
    // on both sides, so the edge under the pointer moves half as far as the width changes.
    const sign = align() === "right" ? -1 : 1;
    const factor = align() === "center" ? 2 : 1;
    let current = startWidth;
    handle.setPointerCapture?.(e.pointerId);
    document.documentElement.classList.add("vr-image-resizing");
    const move = (ev: PointerEvent): void => {
      const next = startWidth + sign * factor * (ev.clientX - startX);
      current = Math.round(Math.min(max, Math.max(MIN_IMAGE_WIDTH, next)));
      setDragWidth(current);
    };
    const end = (ev: PointerEvent): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("vr-image-resizing");
      if (ev.type === "pointercancel" || Math.abs(current - startWidth) < 1) {
        setDragWidth(null);
        return;
      }
      // ONE write, now (B-789): the whole drag is one edit and one undo step.
      rewrite({ width: current });
      // If nothing changed the text (a locked page refuses, a width it already had), the
      // effect above never fires: let go of the preview anyway.
      setTimeout(() => setDragWidth(null), 1500);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ---- the ⋯ menu -------------------------------------------------------------------------
  const [menuAt, setMenuAt] = createSignal<{ top: number; right: number } | null>(null);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const host = imageHost();
  const reveal = createMemo(() => revealTarget(props.tok.src));

  function openMenu(): void {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    setMenuAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }
  function closeMenu(refocus: boolean): void {
    setMenuAt(null);
    if (refocus) trigger?.focus({ preventScroll: true });
  }
  createEffect(() => {
    if (!menuAt()) return;
    const away = (e: Event): void => {
      const t = e.target as Node;
      if (menu?.contains(t) || trigger?.contains(t)) return;
      closeMenu(false);
    };
    const onScroll = (e: Event): void => {
      if (menu?.contains(e.target as Node)) return;
      closeMenu(false);
    };
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      closeMenu(true);
      return true;
    });
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onCleanup(() => {
      release();
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    });
  });

  function menuKeys(e: KeyboardEvent): void {
    // The row reads Enter as "edit this block" and Escape as "leave": neither, here.
    e.stopPropagation();
    const items = menu ? [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")] : [];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      closeMenu(false);
    }
  }

  // ---- results ----------------------------------------------------------------------------
  const [toasts, setToasts] = createSignal<Array<ActionResult & { id: number }>>([]);
  let nextToast = 0;
  function toast(result: ActionResult): void {
    const id = nextToast++;
    setToasts((list) => [...list, { ...result, id }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), result.ok ? 5000 : 9000);
  }
  // Not `async` up to the action: Copy must reach the clipboard in the click's own tick (WebKit's
  // user-gesture rule, `./image-actions.ts#copyImage`).
  function act(action: () => Promise<ActionResult>): void {
    closeMenu(true);
    void action().then(toast);
  }

  const handleSide = () => (align() === "right" ? "left" : "right");

  return (
    <>
      <span
        ref={(el) => {
          box = el;
          queueMicrotask(() => setInLink(el.closest("a") !== null));
        }}
        class="vr-image-box"
        classList={{
          "vr-image-sized": width() !== undefined || size() !== undefined,
          "vr-image-chosen": width() !== undefined,
          "vr-image-center": align() === "center",
          "vr-image-right": align() === "right",
          "vr-image-dragging": dragWidth() !== null,
          "vr-image-narrow": (width() ?? size()?.width ?? Number.POSITIVE_INFINITY) < NARROW_IMAGE,
        }}
        style={boxStyle()}
        data-from={props.tok.start}
        data-to={props.tok.end}
      >
        {/* The picture IS the control that opens it. Wrapped in a <button> instead, its percentage
            width would resolve against a shrink-to-fit box and break B-682/B-703's sizing. */}
        {/* biome-ignore lint/a11y/useSemanticElements: see above. */}
        <img
          class="vr-image"
          alt={props.tok.alt}
          src={url()}
          loading="lazy"
          width={size()?.width}
          height={size()?.height}
          style={imgStyle()}
          data-from={props.tok.start}
          data-to={props.tok.end}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see the comment above <img>.
          role="button"
          tabIndex={0}
          aria-label={props.tok.alt ? `Open image: ${props.tok.alt}` : "Open image"}
          aria-haspopup="dialog"
          onClick={(e) => {
            if (!opensViewer(e, e.currentTarget)) return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if ((e.key !== "Enter" && e.key !== " ") || !opensViewer(e, e.currentTarget)) return;
            // The row's own Enter means "edit this block".
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        />
        <Show when={showControls()}>
          <button
            ref={trigger}
            type="button"
            class="vr-image-more"
            classList={{ "vr-image-more-open": menuAt() !== null }}
            aria-label="Image actions"
            title="Image actions"
            aria-haspopup="menu"
            aria-expanded={menuAt() !== null}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                e.stopPropagation();
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  openMenu();
                }
              }
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (menuAt()) closeMenu(false);
              else openMenu();
            }}
          >
            <Ellipsis size={16} />
          </button>
          <Show when={editable()}>
            {/* A pointer-only affordance: the ⋯ menu's "Original size" and the text itself are the
                keyboard's way to the same width. */}
            <span
              class={`vr-image-handle vr-image-handle-${handleSide()}`}
              title="Drag to resize"
              aria-hidden="true"
              onPointerDown={onHandleDown}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            />
          </Show>
        </Show>
      </span>
      <Show when={menuAt()}>
        {(at) => (
          <Portal>
            <div
              ref={menu}
              class="vr-image-menu"
              role="menu"
              aria-label="Image actions"
              style={{ top: `${at().top}px`, right: `${at().right}px` }}
              // A portal's events still bubble to the component that rendered it (Solid's
              // `_$host`), which is the block row: a click here would also enter the editor.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={menuKeys}
            >
              <button
                type="button"
                role="menuitem"
                class="vr-image-menu-item"
                ref={(el) => queueMicrotask(() => el.focus())}
                onClick={() => act(() => copyImage(url()))}
              >
                <Copy size={15} /> Copy image
              </button>
              <button
                type="button"
                role="menuitem"
                class="vr-image-menu-item"
                onClick={() => act(() => downloadImage(url(), props.tok.src, props.tok.alt, host))}
              >
                <Download size={15} /> {host === "phone" ? "Save / Share…" : "Download"}
              </button>
              <Show when={reveal()}>
                {(r) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="vr-image-menu-item"
                    onClick={() => act(() => revealImage(props.tok.src))}
                  >
                    <FolderOpen size={15} /> {revealLabel(r().shell)}
                  </button>
                )}
              </Show>
              <Show when={host !== "phone"}>
                <button
                  type="button"
                  role="menuitem"
                  class="vr-image-menu-item"
                  onClick={() => {
                    closeMenu(true);
                    window.open(url(), "_blank", "noopener");
                  }}
                >
                  <ExternalLink size={15} /> Open in new tab
                </button>
              </Show>
              <Show when={editable()}>
                <hr class="vr-image-menu-sep" />
                <For
                  each={
                    [
                      ["left", "Align left", AlignLeft],
                      ["center", "Align centre", AlignCenter],
                      ["right", "Align right", AlignRight],
                    ] as const
                  }
                >
                  {([value, label, Icon]) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={align() === value}
                      class="vr-image-menu-item"
                      onClick={() => {
                        closeMenu(true);
                        rewrite({ align: value });
                      }}
                    >
                      <Icon size={15} /> {label}
                      <Show when={align() === value}>
                        <Check size={14} class="vr-image-menu-check" />
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={props.tok.meta?.width !== undefined}>
                  <button
                    type="button"
                    role="menuitem"
                    class="vr-image-menu-item"
                    onClick={() => {
                      closeMenu(true);
                      rewrite({ width: null });
                    }}
                  >
                    <Maximize2 size={15} /> Original size
                  </button>
                </Show>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={toasts().length > 0}>
        <Portal>
          <div class="vr-image-toasts" role="status" aria-live="polite">
            <For each={toasts()}>
              {(t) => (
                <p class="image-viewer-toast" classList={{ "image-viewer-toast-error": !t.ok }}>
                  {t.message}
                </p>
              )}
            </For>
          </div>
        </Portal>
      </Show>
      <Show when={open()}>
        <ImageViewer
          url={url()}
          src={props.tok.src}
          alt={props.tok.alt}
          onClose={() => setOpen(false)}
          onEditBlock={
            props.ctx.onEditBlock
              ? () => {
                  setOpen(false);
                  props.ctx.onEditBlock?.(props.tok.end);
                }
              : undefined
          }
        />
      </Show>
    </>
  );
}
