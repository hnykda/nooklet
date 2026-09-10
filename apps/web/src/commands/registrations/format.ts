/** E.4 Formatting (category `Formatting`) — R45-R47. */
import type { EditorHost } from "../hosts/editor-host.js";
import type { Command } from "../types.js";
import { buildLinkInsertion, toggleWrap } from "./format-logic.js";

function wrapCommand(
  id: string,
  title: string,
  key: { mac?: string; other?: string },
  open: string,
  close = open,
) {
  return (editor: EditorHost): Command => ({
    id,
    title,
    category: "Formatting",
    defaultKeys: key,
    when: "editorFocused",
    run() {
      const sel = editor.getSelection();
      if (!sel) return;
      editor.replaceRange(toggleWrap(sel.content, sel.start, sel.end, open, close));
    },
  });
}

/** R47: insert the literal trigger characters at the caret (replacing the selection, if any) and
 * let the normal autocomplete pipeline pick them up — "triggering the popup programmatically."
 * `commands/` only needs to insert the text; the autocomplete popup opening in response is the
 * same trigger-detection path typing it would hit (§ autocomplete/trigger.ts), owned by whoever
 * wires the editor's document-change listener to it. */
function insertTriggerCommand(id: string, title: string, trigger: string) {
  return (editor: EditorHost): Command => ({
    id,
    title,
    category: "Formatting",
    defaultKeys: {},
    when: "editorFocused",
    run() {
      const sel = editor.getSelection();
      if (!sel) return;
      editor.replaceRange({
        from: sel.start,
        to: sel.end,
        text: trigger,
        caretOffset: trigger.length,
      });
    },
  });
}

export function createFormatCommands(deps: { editor: EditorHost }): Command[] {
  const { editor } = deps;
  return [
    wrapCommand("format.bold", "Bold", { mac: "Cmd+B", other: "Ctrl+B" }, "**")(editor),
    wrapCommand("format.italic", "Italic", { mac: "Cmd+I", other: "Ctrl+I" }, "*")(editor),
    wrapCommand(
      "format.strikethrough",
      "Strikethrough",
      { mac: "Cmd+Shift+X", other: "Ctrl+Shift+X" },
      "~~",
    )(editor),
    wrapCommand(
      "format.highlight",
      "Highlight",
      { mac: "Cmd+Shift+H", other: "Ctrl+Shift+H" },
      "==",
    )(editor),
    wrapCommand("format.inlineCode", "Inline code", { mac: "Cmd+E", other: "Ctrl+E" }, "`")(editor),
    {
      id: "format.insertLink",
      title: "Insert link",
      category: "Formatting",
      defaultKeys: { mac: "Cmd+Shift+K", other: "Ctrl+Shift+K" },
      when: "editorFocused",
      run() {
        const sel = editor.getSelection();
        if (!sel) return;
        editor.replaceRange(buildLinkInsertion(sel.content, sel.start, sel.end));
      },
    },
    insertTriggerCommand("format.insertPageRef", "Insert page reference", "[[")(editor),
    insertTriggerCommand("format.insertTag", "Insert tag", "#")(editor),
    insertTriggerCommand("format.insertBlockRef", "Insert block reference", "((")(editor),
  ];
}
