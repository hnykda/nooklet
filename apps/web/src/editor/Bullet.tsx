/**
 * The bullet + collapse/expand arrow + child count (BUILD item 1), plus long-press-to-drag
 * reorder (research/08-mobile.md §3.6, M5 BUILD item 2): holding the bullet for 300ms starts a
 * drag whose vertical movement is converted, one sibling row at a time, into `onDragStep` calls —
 * `BlockTree.tsx` runs those through the exact same `moveBlock`/`block.moveUp`/`block.moveDown`
 * path `Alt+Up/Down` already uses, per `../../editor/gestures/longPressDrag.ts`'s doc comment.
 */
import { onCleanup, onMount, Show } from "solid-js";
import { attachLongPressDrag } from "./gestures/longPressDragAttach.js";
import { keepEditorFocus } from "./keep-focus.js";

export function Bullet(props: {
  hasChildren: boolean;
  collapsed: boolean;
  childCount: number;
  onToggleCollapse: () => void;
  onZoomIn: () => void;
  onDragStep?: (direction: "up" | "down") => void;
}) {
  let wrapEl: HTMLSpanElement | undefined;

  onMount(() => {
    if (!wrapEl || !props.onDragStep) return;
    const detach = attachLongPressDrag(
      wrapEl,
      { moveStep: (direction) => props.onDragStep?.(direction) },
      () => wrapEl?.closest<HTMLElement>(".vr-row")?.getBoundingClientRect().height ?? 32,
    );
    onCleanup(detach);
  });

  return (
    <span class="vr-bullet-wrap" ref={wrapEl}>
      <Show when={props.hasChildren}>
        <button
          type="button"
          class="vr-collapse-arrow"
          classList={{ "vr-collapsed": props.collapsed }}
          aria-label={props.collapsed ? "Expand block" : "Collapse block"}
          onPointerDown={keepEditorFocus.onPointerDown}
          onMouseDown={keepEditorFocus.onMouseDown}
          onClick={props.onToggleCollapse}
        >
          <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 1 L8 5 L2 9 Z" fill="currentColor" />
          </svg>
        </button>
      </Show>
      <button
        type="button"
        class="vr-bullet"
        classList={{ "vr-bullet-parent": props.hasChildren }}
        aria-label="Zoom into block"
        onPointerDown={keepEditorFocus.onPointerDown}
        onMouseDown={keepEditorFocus.onMouseDown}
        onClick={props.onZoomIn}
      >
        <span class="vr-bullet-dot" />
      </button>
      <Show when={props.hasChildren && props.collapsed}>
        <span class="vr-child-count">{props.childCount}</span>
      </Show>
    </span>
  );
}
