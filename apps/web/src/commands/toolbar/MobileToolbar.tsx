/**
 * `<MobileKeyboardToolbar>` (R60-R61, BUILD item 6): the 12-button row shown while
 * `mobile && editorFocused`. Each tap runs the same command a keyboard shortcut would, through
 * the shared `exec` (so MRU tracking and everything else stay consistent, R71).
 */
import { createMemo, For, Show } from "solid-js";
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
  { icon: "☐", command: "task.toggleDone" },
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
              // R61: preventDefault on pointerdown (not just click) so focus never leaves the
              // mounted Surface for even one frame — losing it drops the iOS keyboard.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => void tap(button.command)}
            >
              {button.icon}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
