/**
 * The bullet + collapse/expand arrow + child count (BUILD item 1). Drag-to-reorder (research
 * 04-editor.md §3.8) is explicitly a "nice-to-have" there and is not implemented in this
 * milestone — move-by-keyboard (`Alt+Up/Down`) and the toolbar/gesture equivalents (§Mobile,
 * owned by whichever agent builds the mobile keyboard toolbar) cover reordering instead.
 */
import { Show } from "solid-js";

export function Bullet(props: {
  hasChildren: boolean;
  collapsed: boolean;
  childCount: number;
  onToggleCollapse: () => void;
  onZoomIn: () => void;
}) {
  return (
    <span class="vr-bullet-wrap">
      <Show when={props.hasChildren}>
        <button
          type="button"
          class="vr-collapse-arrow"
          classList={{ "vr-collapsed": props.collapsed }}
          aria-label={props.collapsed ? "Expand block" : "Collapse block"}
          onPointerDown={(e) => e.preventDefault()}
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
        onPointerDown={(e) => e.preventDefault()}
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
