/**
 * One flattened row: bullet/collapse-arrow, task marker pill, priority badge, numbered-list
 * ordinal, and the content area — either the read-only rendered view (`render/tokens.tsx`) or,
 * for exactly the block currently being edited, the CM6 surface's host element. Pure
 * presentation; all editing/selection/navigation LOGIC lives in `BlockTree.tsx` and is passed in
 * as callbacks, per research/04-editor.md §3.2's "BlockRow.tsx — pure presentation, no editor
 * logic" rule.
 */
import { classifyBlockContent } from "@nooklet/core";
import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import { lookupBlockText } from "../data/block-ref-cache.js";
import { Bullet } from "./Bullet.js";
import { resolveClickOffset } from "./caret.js";
import { attachSwipeRow } from "./gestures/swipeAttach.js";
import { BlockContentView, type Navigate } from "./render/tokens.js";
import type { EditableBlock } from "./types.js";

/** The glyph for each task state. Deliberately text rather than SVG: it inherits colour and size
 * from the row, so it stays aligned with the text baseline at any zoom.
 *
 * Exported because the shelf (`../shell/Shelf.tsx`) renders blocks read-only too, and a second
 * copy of this table is how DOING quietly becomes a different symbol in one of the two places. */
export const MARKER_GLYPH: Record<string, string> = {
  TODO: "☐",
  LATER: "☐",
  NOW: "◐",
  DOING: "◐",
  WAITING: "◔",
  DONE: "☑",
  CANCELED: "☒",
};

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
  /** Right-click anywhere on the row. `BlockTree` decides what to focus and opens the menu. */
  onContextMenu?: (e: MouseEvent) => void;
  onNavigate?: Navigate;
  /** Shift+click: put this block — or, from inside the rendered content, a `[[page]]` link's
   * target — on the right-hand shelf (`../app/shelf.ts`). Absent for trees with no shelf wired,
   * in which case Shift falls back to its old meaning (block selection). */
  onShelfOpen?: Navigate;
  /** Swipe-right/left-to-indent/outdent (research/08-mobile.md §3.5). Pure presentation still
   * holds: this component only forwards intent, `BlockTree.tsx` runs the actual op. */
  onSwipeIndent?: () => void;
  onSwipeOutdent?: () => void;
  /** Long-press-the-bullet-to-drag-reorder (research/08-mobile.md §3.6), one call per row
   * crossed — see `Bullet.tsx`. */
  onDragStep?: (direction: "up" | "down") => void;
}) {
  const content = createMemo(() => classifyBlockContent(props.block.content));
  let rowEl: HTMLDivElement | undefined;

  // Skip the swipe gesture while this row is the one being edited: the CM6 surface owns touch
  // there (cursor placement, text selection), and re-attaching whenever `editing` flips keeps the
  // listener installed the rest of the time.
  createEffect(() => {
    if (!rowEl || props.editing || !(props.onSwipeIndent || props.onSwipeOutdent)) return;
    const detach = attachSwipeRow(rowEl, {
      indent: () => props.onSwipeIndent?.(),
      outdent: () => props.onSwipeOutdent?.(),
    });
    onCleanup(detach);
  });

  function handleContentClick(e: MouseEvent): void {
    // Shift+click used to mean "select this block", and now means "put it on the shelf"; block
    // selection keeps Cmd/Ctrl+click. Three reasons for resolving the collision that way round:
    //
    //  - Shift+click IS the shelf gesture in the tool this app is in the spirit of. Rebinding it
    //    to something else would make the feature undiscoverable for exactly the people it is for.
    //  - Selection loses nothing: it keeps a mouse gesture (Cmd/Ctrl+click, which is already the
    //    platform idiom for "add this to a selection" everywhere else) AND it has a complete
    //    keyboard route — Escape to select the block, then Shift+Up/Down to extend
    //    (`block.selectBlock`/`block.extendSelection*`). The shelf has no other way in at all.
    //  - The alternative of moving selection to Alt+click is worse than it looks: Option+click is
    //    a word-select gesture in macOS text, and Alt+drag is grabbed by several Linux window
    //    managers before the page ever sees it.
    //
    // Trees with no shelf wired (`onShelfOpen` absent) keep the old behaviour, so nothing that
    // renders rows outside the app shell silently loses Shift+click.
    if (e.shiftKey && props.onShelfOpen) {
      props.onShelfOpen({ kind: "block", id: props.id });
      return;
    }
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
      ref={rowEl}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <Bullet
        hasChildren={props.hasChildren}
        collapsed={props.collapsed}
        childCount={props.childCount}
        onToggleCollapse={props.onToggleCollapse}
        onZoomIn={props.onZoomIn}
        onDragStep={props.onDragStep}
      />
      <div class="vr-row-main">
        <Show when={props.block.marker !== null}>
          {/* One button per state rather than a checkbox: a checkbox has two states and a task has
              six, so DOING and WAITING had no representation at all and read as "not done". The
              glyph carries the state — empty box to do, half-filled while in progress, a check
              when done — which is what makes a list scannable without reading it. */}
          <button
            type="button"
            class={`vr-marker vr-marker-${props.block.marker}`}
            aria-label={`Task: ${props.block.marker}`}
            title={`${props.block.marker} — click to advance`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={props.onToggleMarker}
          >
            {MARKER_GLYPH[props.block.marker ?? ""] ?? "☐"}
          </button>
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
                onMouseDown={(e) => {
                  // Stop the browser focusing this element on mousedown. It is swapped out for
                  // the editor inside the click handler that follows, and the browser then resets
                  // focus to <body> once the handler returns — leaving a window of a frame or two
                  // in which every keystroke is dropped. That is what made "click a bullet and
                  // type" lose its first characters, and "press Enter then type" lose the start of
                  // the new block.
                  //
                  // Narrow on purpose: only a left click on non-interactive content. Anything
                  // interactive inside the rendered block (a [[page]] link, a task checkbox) keeps
                  // the browser's default so its own click still fires, which is also why entering
                  // edit mode stays on `click` rather than moving to `mousedown`.
                  //
                  // Shift is included even though it no longer enters edit mode: its default is to
                  // extend the DOCUMENT text selection from wherever the caret last was, so every
                  // Shift+click onto the shelf would also leave the intervening blocks smeared with
                  // highlight. Cmd/Ctrl is not, since that gesture may be a real open-in-new-tab on
                  // whatever the pointer is over.
                  const target = e.target as HTMLElement;
                  if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                  if (target.closest("a, button, input, label, summary")) return;
                  e.preventDefault();
                }}
                onClick={handleContentClick}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  props.onEnterEdit(props.block.content.length);
                }}
              >
                <BlockContentView
                  content={content()}
                  ctx={{
                    source: props.block.content,
                    onNavigate: props.onNavigate,
                    onShelfOpen: props.onShelfOpen,
                    // So an `{{embed}}` that would render this very row again stops (render/EmbedView.tsx).
                    embedPath: [props.id],
                    // `((id))` renders the referenced block's own text rather than an opaque id.
                    // Resolved through a cache that fetches on a miss and re-renders when the
                    // text lands (`../data/block-ref-cache.ts`).
                    resolveBlockRef: (id) => {
                      const content = lookupBlockText(id);
                      return content === undefined ? undefined : { content };
                    },
                  }}
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
