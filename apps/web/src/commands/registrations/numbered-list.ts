/**
 * "Numbered list" (B-100 follow-through): make the focused block a numbered list item, or stop it
 * being one. Without it the only way to number a block in the UI was to know the `list:: number`
 * spelling (markdown-grammar OUT-17) and type it.
 *
 * It edits the block's editing text — the buffer that, since B-101, carries property lines and is
 * written back as real properties — so it needs no op-building of its own, undoes like typing, and
 * shows the person exactly what it did.
 */
import { closesCodeFence, openingCodeFence } from "@nooklet/core";
import type { EditorHost, ReplaceRangeSpec } from "../hosts/editor-host.js";
import type { Command } from "../types.js";
import { insertProperty } from "./insert-logic.js";

const LIST_LINE_RE = /^list:: ?(.*)$/;

/**
 * The edit that toggles `list:: number` in `content` (a block's editing text), keeping the caret
 * (`caret`, an offset into `content`) on the same character. A `list::` line with another value is
 * replaced rather than removed: asking for a numbered list should end with one.
 */
export function toggleNumberedList(content: string, caret: number): ReplaceRangeSpec {
  const lines = content.split("\n");
  let start = 0;
  let fence: string | null = null;
  for (const line of lines) {
    // Never touch a `list::` line inside a code fence — it is code, not a property. The parser's
    // own fence rules, so this agrees with what the flush will read as a property.
    if (fence !== null) {
      if (closesCodeFence(line, fence)) fence = null;
      start += line.length + 1;
      continue;
    }
    const m = LIST_LINE_RE.exec(line);
    if (!m) fence = openingCodeFence(line);
    if (m) {
      if ((m[1] ?? "").trim() === "number") {
        // Remove the line with the newline that joins it to its neighbour.
        const from = start > 0 ? start - 1 : start;
        const to = start > 0 ? start + line.length : Math.min(content.length, line.length + 1);
        const after = caret <= from ? caret : caret >= to ? caret - (to - from) : from;
        return { from, to, text: "", caretOffset: after - from };
      }
      const text = "list:: number";
      const after =
        caret <= start
          ? caret
          : caret >= start + line.length
            ? caret + text.length - line.length
            : start + text.length;
      return { from: start, to: start + line.length, text, caretOffset: after - start };
    }
    start += line.length + 1;
  }
  const insert = insertProperty(content, "list");
  const text = `${insert.text}number`;
  const after = caret <= insert.from ? caret : caret + text.length;
  return { from: insert.from, to: insert.to, text, caretOffset: after - insert.from };
}

export function createNumberedListCommands(deps: { editor: EditorHost }): Command[] {
  return [
    {
      id: "block.toggleNumberedList",
      title: "Numbered list",
      description: "Number this block in its list, or stop numbering it (list:: number)",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run() {
        const sel = deps.editor.getSelection();
        if (sel) deps.editor.replaceRange(toggleNumberedList(sel.content, sel.end));
      },
    },
  ];
}
