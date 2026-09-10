/**
 * `<SlashMenu>` (R53-R55, BUILD item 4): renders the slash-menu popup. Trigger detection
 * (`slash/trigger.ts`) and dismissal-by-deletion/space are the editor's job — it watches document
 * changes, calls `matchSlashTrigger`/`computeSlashQuery`, and passes the result down as
 * `props.trigger` (`null` = closed). This component only does filtering/ranking/keyboard nav and,
 * on selection, removes the triggering text and runs the chosen command via `EditorHost`.
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import type { EditorHost } from "../hosts/editor-host.js";
import { useCommands } from "../provider/CommandProvider.js";
import { rankItems } from "../ranking/rank.js";
import type { CommandContext } from "../types.js";
import { SLASH_ITEMS } from "./items.js";
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

const RANKABLE_ITEMS = SLASH_ITEMS.map((it) => ({
  id: it.command,
  title: it.label,
  aliases: it.keywords,
}));

export function SlashMenu(props: SlashMenuProps) {
  const { mru, buildContext } = useCommands();
  const [highlight, setHighlight] = createSignal(0);

  const results = createMemo(() => {
    const trig = props.trigger;
    if (!trig) return [];
    return rankItems({ query: trig.query, items: RANKABLE_ITEMS, mru, kind: "command" });
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

  function onKeyDown(e: KeyboardEvent) {
    const list = results();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onDismiss();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      void selectIndex(highlight());
    }
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
