/**
 * Right-click menu for a bullet.
 *
 * Every entry runs a command that already exists in the registry — `block.zoomIn`, `task.cycle`,
 * `format.bold` and so on — through the same `exec` the palette and the keymap use. It is a new
 * *surface* for existing behaviour, never a parallel implementation, so a command fixed or
 * rebound in one place is fixed and rebound here too.
 *
 * Entries whose `when` clause does not hold for the current context are hidden rather than
 * disabled: a menu of greyed-out items on a bullet with no children is noise.
 */

import { createEffect, createMemo, For, type JSX, onCleanup, Show } from "solid-js";
import { useCommands } from "../commands/index.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import type { CommandContext } from "../commands/types.js";
import { matchesWhen } from "../commands/when/index.js";
import "./context-menu.css";
import { blockMenuRequest, closeBlockMenu } from "./context-menu.js";

type ContextBase = Omit<CommandContext, "exec" | "args">;

/** `null` is a separator. */
const ENTRIES: ReadonlyArray<{ id: string; label: string } | null> = [
  { id: "block.zoomIn", label: "Zoom in" },
  { id: "block.openOnShelf", label: "Open on shelf" },
  { id: "block.copyRef", label: "Copy block reference" },
  null,
  { id: "task.cycle", label: "Cycle task state" },
  { id: "task.toggleDone", label: "Toggle done" },
  null,
  { id: "block.indent", label: "Indent" },
  { id: "block.outdent", label: "Outdent" },
  { id: "block.moveUp", label: "Move up" },
  { id: "block.moveDown", label: "Move down" },
  null,
  { id: "format.bold", label: "Bold" },
  { id: "format.italic", label: "Italic" },
  { id: "format.highlight", label: "Highlight" },
  null,
  { id: "block.duplicate", label: "Duplicate" },
  { id: "block.deleteSelected", label: "Delete" },
  null,
  { id: "block.turnIntoPage", label: "Turn into page" },
  { id: "block.moveToPage", label: "Move to page…" },
];

export function BlockContextMenu(props: { getContext: () => ContextBase }): JSX.Element {
  const { registry, buildContext } = useCommands();
  let menuEl: HTMLDivElement | undefined;

  const visible = createMemo(() => {
    if (!blockMenuRequest()) return [];
    const ctx = props.getContext();
    const out: Array<{ id: string; label: string } | null> = [];
    for (const entry of ENTRIES) {
      if (entry === null) {
        // Keep a separator only when it actually separates two shown entries.
        if (out.length > 0 && out[out.length - 1] !== null) out.push(null);
        continue;
      }
      const command = registry.get(entry.id);
      if (!command) continue;
      if (!matchesWhen(command.when, ctx)) continue;
      out.push(entry);
    }
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  });

  // Dismiss on anything that means "I'm done here".
  createEffect(() => {
    if (!blockMenuRequest()) return;
    // Capture phase, so this runs before anything beneath the menu reacts — which means it also
    // runs before the menu's OWN handlers, so a click on an item has to be excluded explicitly.
    // `stopPropagation` on the menu cannot help: by then this listener has already fired.
    const dismiss = (e: Event): void => {
      if (menuEl?.contains(e.target as Node)) return;
      closeBlockMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeBlockMenu();
      }
    };
    // `pointerdown` rather than `click`: dismiss before the click lands on whatever is beneath.
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    // Also claim Escape through the popup registry: otherwise the editor's keymap read the same
    // keydown as "leave editing" and dropped the block into selection mode while the menu closed
    // (B-72). With the claim, both dispatchers know something is open and yield.
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      closeBlockMenu();
      return true;
    });
    const dismissAlways = (): void => closeBlockMenu();
    window.addEventListener("blur", dismissAlways);
    window.addEventListener("resize", dismissAlways);
    onCleanup(() => {
      release();
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", dismissAlways);
      window.removeEventListener("resize", dismissAlways);
    });
  });

  async function run(id: string): Promise<void> {
    const command = registry.get(id);
    closeBlockMenu();
    if (!command) return;
    await command.run(buildContext(props.getContext()));
  }

  return (
    <Show when={blockMenuRequest()}>
      {(req) => (
        <div
          ref={menuEl}
          class="ctx-menu"
          role="menu"
          // Clamped so a right-click near the right or bottom edge does not open off-screen.
          style={{
            left: `${Math.min(req().x, Math.max(0, window.innerWidth - 220))}px`,
            top: `${Math.min(req().y, Math.max(0, window.innerHeight - 320))}px`,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={visible()}>
            {(entry) =>
              entry === null ? (
                <div class="ctx-sep" role="separator" />
              ) : (
                <button
                  type="button"
                  class="ctx-item"
                  role="menuitem"
                  // Focus stays where it was: an item that took focus on mousedown left the
                  // editor with no caret after the click (B-71).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void run(entry.id)}
                >
                  {entry.label}
                </button>
              )
            }
          </For>
          <Show when={visible().length === 0}>
            <div class="ctx-empty">Nothing available here</div>
          </Show>
        </div>
      )}
    </Show>
  );
}
