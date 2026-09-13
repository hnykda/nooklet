/**
 * `<SlashMenu>` (R53-R55, BUILD item 4): renders the slash-menu popup. Trigger detection
 * (`slash/trigger.ts`) and dismissal-by-deletion/space are the editor's job — it watches document
 * changes, calls `matchSlashTrigger`/`computeSlashQuery`, and passes the result down as
 * `props.trigger` (`null` = closed). This component only does filtering/ranking/keyboard nav and,
 * on selection, removes the triggering text and runs the chosen command via `EditorHost`.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { EditorHost } from "../hosts/editor-host.js";
import { claimPopupKeys } from "../popup-keys.js";
import { useCommands } from "../provider/CommandProvider.js";
import { rankItems } from "../ranking/rank.js";
import type { CommandContext } from "../types.js";
import { slashItems } from "./contributed.js";
import type { SlashMatch } from "./trigger.js";
import "../styles.css";

export interface SlashMenuProps {
  editor: EditorHost;
  /** `null` means closed. */
  trigger: SlashMatch | null;
  position: { top: number; left: number };
  getContext: () => Omit<CommandContext, "exec" | "args">;
  onDismiss: () => void;
}

export function SlashMenu(props: SlashMenuProps) {
  const { mru, buildContext } = useCommands();
  const [highlight, setHighlight] = createSignal(0);

  // Core rows plus plugin-contributed ones (`./contributed.ts`) — tracked, so a row registered
  // after this module loaded still shows up (B-103).
  const rankable = createMemo(() =>
    slashItems().map((it) => ({ id: it.command, title: it.label, aliases: it.keywords })),
  );

  const results = createMemo(() => {
    const trig = props.trigger;
    if (!trig) return [];
    return rankItems({ query: trig.query, items: rankable(), mru, kind: "command" });
  });

  async function selectIndex(index: number) {
    const trig = props.trigger;
    const row = results()[index];
    if (!trig || !row) return;
    // R53: remove the triggering "/" and any typed query text from the block first.
    props.editor.replaceRange({ from: trig.from, to: trig.from + 1 + trig.query.length, text: "" });
    const ctx = buildContext(props.getContext());
    await ctx.exec(row.item.id);
    props.onDismiss();
  }

  /** The menu's keymap (R53/R12 step 2). Reached from the editor's key dispatch via
   * `claimPopupKeys` while the menu is open — the editor keeps focus — and from this element's
   * own `onKeyDown` if a row has been clicked and holds focus itself. */
  function handleKey(key: string): boolean {
    const list = results();
    if (key === "Escape") {
      props.onDismiss();
      return true;
    }
    if (key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      return true;
    }
    if (key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      return true;
    }
    if (key === "Enter" || key === "Tab") {
      void selectIndex(highlight());
      return true;
    }
    return false;
  }

  // Own the popup keys for exactly as long as there is a trigger (B-65); released on close and
  // on unmount alike.
  createEffect(() => {
    if (props.trigger === null) return;
    const release = claimPopupKeys(handleKey);
    onCleanup(release);
  });

  function onKeyDown(e: KeyboardEvent) {
    if (handleKey(e.key)) e.preventDefault();
  }

  return (
    <Show when={props.trigger !== null}>
      <div
        class="cmd-popup"
        style={{ top: `${props.position.top}px`, left: `${props.position.left}px` }}
        role="listbox"
        onKeyDown={onKeyDown}
      >
        <For each={results()}>
          {(row, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the listbox's own onKeyDown above, not per-row.
            <div
              role="option"
              tabIndex={-1}
              // Focus stays in the editor: a row that took focus on mousedown left the caret
              // nowhere after the click (B-71).
              onMouseDown={(e) => e.preventDefault()}
              aria-selected={i() === highlight()}
              classList={{ "cmd-row": true, "cmd-row--active": i() === highlight() }}
              onMouseEnter={() => setHighlight(i())}
              onClick={() => void selectIndex(i())}
            >
              {row.item.title}
            </div>
          )}
        </For>
        <Show when={results().length === 0}>
          <div class="cmd-empty">No results</div>
        </Show>
      </div>
    </Show>
  );
}
