/**
 * One flattened row: bullet/collapse-arrow, task marker pill, priority badge, numbered-list
 * ordinal, and the content area — either the read-only rendered view (`render/tokens.tsx`) or,
 * for exactly the block currently being edited, the CM6 surface's host element. Pure
 * presentation; all editing/selection/navigation LOGIC lives in `BlockTree.tsx` and is passed in
 * as callbacks, per research/04-editor.md §3.2's "BlockRow.tsx — pure presentation, no editor
 * logic" rule.
 */
import { classifyBlockContent } from "@nooklet/core";
import { createMemo, Show } from "solid-js";
import { Bullet } from "./Bullet.js";
import { resolveClickOffset } from "./caret.js";
import { BlockContentView, type Navigate } from "./render/tokens.js";
import type { EditableBlock } from "./types.js";

export function BlockRowView(props: {
  id: string;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  childCount: number;
  block: EditableBlock;
  numbering: number | undefined;
  editing: boolean;
  selected: boolean;
  surfaceHost: (el: HTMLDivElement) => void;
  onEnterEdit: (offset: number) => void;
  onToggleCollapse: () => void;
  onZoomIn: () => void;
  onToggleMarker: () => void;
  onSelectClick: (e: MouseEvent) => void;
  onNavigate?: Navigate;
}) {
  const content = createMemo(() => classifyBlockContent(props.block.content));

  function handleContentClick(e: MouseEvent): void {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      props.onSelectClick(e);
      return;
    }
    const target = e.currentTarget as HTMLElement;
    const offset = resolveClickOffset(target, e.clientX, e.clientY);
    props.onEnterEdit(offset ?? props.block.content.length);
  }

  return (
    <div
      class="vr-row"
      classList={{ "vr-row-editing": props.editing, "vr-row-selected": props.selected }}
      style={{ "--depth": props.depth }}
      data-block-id={props.id}
    >
      <Bullet
        hasChildren={props.hasChildren}
        collapsed={props.collapsed}
        childCount={props.childCount}
        onToggleCollapse={props.onToggleCollapse}
        onZoomIn={props.onZoomIn}
      />
      <div class="vr-row-main">
        <Show when={props.block.marker !== null}>
          <Show
            when={props.block.marker !== "CANCELED"}
            fallback={<span class="vr-marker vr-marker-CANCELED">CANCELED</span>}
          >
            <input
              type="checkbox"
              class={`vr-marker vr-marker-${props.block.marker}`}
              checked={props.block.marker === "DONE"}
              onPointerDown={(e) => e.preventDefault()}
              onClick={props.onToggleMarker}
            />
          </Show>
        </Show>
        <Show when={props.block.priority}>
          <span class={`vr-priority vr-priority-${props.block.priority}`}>
            {props.block.priority}
          </span>
        </Show>
        <Show when={props.numbering !== undefined}>
          <span class="vr-list-number">{props.numbering}.</span>
        </Show>
        <div class="vr-content">
          <Show
            when={props.editing}
            fallback={
              // biome-ignore lint/a11y/useSemanticElements: READ-ONLY rendered rich block content (links, checkboxes, images, tables via BlockContentView) — a real <textarea>/<input> cannot host that markup; Enter/click here only hands off to the CM6 `Surface`, the real editable region.
              <div
                class="vr-block-view"
                role="textbox"
                aria-multiline="true"
                tabIndex={0}
                dir="auto"
                onClick={handleContentClick}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  props.onEnterEdit(props.block.content.length);
                }}
              >
                <BlockContentView
                  content={content()}
                  ctx={{ source: props.block.content, onNavigate: props.onNavigate }}
                />
              </div>
            }
          >
            <div class="vr-surface-host" ref={props.surfaceHost} />
          </Show>
        </div>
      </div>
    </div>
  );
}
