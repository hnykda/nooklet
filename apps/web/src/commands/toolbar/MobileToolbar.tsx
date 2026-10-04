/**
 * `<MobileKeyboardToolbar>` (R60-R61, BUILD item 6): the 12-button row shown while
 * `mobile && editorFocused`. Each tap runs the same command a keyboard shortcut would, through
 * the shared `exec` (so MRU tracking and everything else stay consistent, R71).
 */
import SquareCheck from "lucide-solid/icons/square-check";
import { createMemo, For, Show } from "solid-js";
import { keepEditorFocus } from "../../editor/keep-focus.js";
import { useCommands } from "../provider/CommandProvider.js";
import type { CommandContext, ToolbarButton } from "../types.js";
import { matchesWhen } from "../when/index.js";
import "../styles.css";

/** R60's fixed left-to-right order. */
export const TOOLBAR_BUTTONS: readonly ToolbarButton[] = [
  { icon: "⇤", command: "block.outdent" },
  { icon: "⇥", command: "block.indent" },
  { icon: "↑", command: "block.moveUp" },
  { icon: "↓", command: "block.moveDown" },
  { icon: "[[ ]]", command: "format.insertPageRef" },
  { icon: "#", command: "format.insertTag" },
  { icon: "(( ))", command: "format.insertBlockRef" },
  { icon: "/", command: "block.openSlashMenu" },
  // B-651: `task.cycle` (Mod+Enter), not `task.toggleDone`. A phone has no Mod+Enter, so this was
  // the only way to DOING/NOW, and toggleDone never goes there — it was also disabled on a block
  // that is not yet a task, so no task could be started from the toolbar. Logseq's mobile bar has
  // the same button: `(editor-handler/cycle-todo!)` with the "checkbox" icon
  // (src/main/frontend/mobile/mobile_bar.cljs, 0.10.9).
  { icon: "☑", command: "task.cycle" },
  { icon: "↺", command: "edit.undo" },
  { icon: "↻", command: "edit.redo" },
  { icon: "⌄", command: "app.hideKeyboard" },
];

export interface MobileKeyboardToolbarProps {
  /** A fresh `CommandContext` base, read on every render — same contract as the palette/popups. */
  getContext: () => Omit<CommandContext, "exec" | "args">;
}

export function MobileKeyboardToolbar(props: MobileKeyboardToolbarProps) {
  const { registry, buildContext } = useCommands();

  const visible = createMemo(() => {
    const ctx = props.getContext();
    return ctx.mobile && ctx.editorFocused;
  });

  function isEnabled(commandId: string): boolean {
    const command = registry.get(commandId);
    if (!command) return false;
    return matchesWhen(command.when, props.getContext());
  }

  async function tap(commandId: string) {
    if (!isEnabled(commandId)) return;
    const ctx = buildContext(props.getContext());
    await ctx.exec(commandId);
  }

  return (
    <Show when={visible()}>
      <div class="cmd-toolbar" role="toolbar" aria-label="Editor toolbar">
        <For each={TOOLBAR_BUTTONS}>
          {(button) => (
            <button
              type="button"
              class="cmd-toolbar-button"
              disabled={!isEnabled(button.command)}
              aria-label={button.command}
              // R61: focus never leaves the mounted Surface, not for one frame — losing it drops
              // the iOS keyboard. On `mousedown`, not `pointerdown`, for a touch (B-661).
              onPointerDown={keepEditorFocus.onPointerDown}
              onMouseDown={keepEditorFocus.onMouseDown}
              onClick={() => void tap(button.command)}
            >
              {/* An icon, not the text glyph: `☐`/`☑` read as a missing character on iOS (B-651). */}
              {button.command === "task.cycle" ? (
                <SquareCheck size={18} aria-hidden="true" />
              ) : (
                button.icon
              )}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
