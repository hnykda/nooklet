/** E.5 Insert / slash-menu-only commands (category `Insert`, id area `block`) — R48-R50. */
import { formatJournalTitle, todayJournalDay } from "@nooklet/core";
import { journalTitleFormat } from "../../data/page-title.js";
import type { EditorHost } from "../hosts/editor-host.js";
import type { Command } from "../types.js";
import {
  embedBlock,
  embedPage,
  insertCodeFence,
  insertProperty,
  insertQueryFence,
  insertTable,
  insertToday,
  setHeading,
} from "./insert-logic.js";

function headingCommand(id: string, title: string, level: 1 | 2 | 3) {
  return (editor: EditorHost): Command => ({
    id,
    title,
    category: "Insert",
    defaultKeys: {},
    when: "editorFocused",
    run() {
      const sel = editor.getSelection();
      if (sel) editor.replaceRange(setHeading(sel.content, level));
    },
  });
}

export function createInsertCommands(deps: { editor: EditorHost; now?: () => number }): Command[] {
  const { editor } = deps;
  const now = deps.now ?? (() => Date.now());

  return [
    headingCommand("block.setHeading1", "Heading 1", 1)(editor),
    headingCommand("block.setHeading2", "Heading 2", 2)(editor),
    headingCommand("block.setHeading3", "Heading 3", 3)(editor),
    {
      id: "block.insertCodeFence",
      title: "Code block",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run() {
        const sel = editor.getSelection();
        if (sel) editor.replaceRange(insertCodeFence(sel.content));
      },
    },
    {
      id: "block.insertQueryFence",
      title: "Query",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run() {
        const sel = editor.getSelection();
        if (sel) editor.replaceRange(insertQueryFence(sel.content));
      },
    },
    {
      id: "block.insertTable",
      title: "Table",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run() {
        editor.replaceRange(insertTable());
      },
    },
    {
      // R48: needs `platform.files.pick` + asset upload (outside this package's scope, see the
      // summary) — registered here (so the palette/slash menu/keymap see the full command set)
      // but delegated to the editor exactly like the `Block`-category structural commands.
      id: "block.insertImage",
      title: "Image",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run(ctx) {
        return editor.runStructuralCommand("block.insertImage", ctx);
      },
    },
    {
      id: "block.embedPage",
      title: "Embed page",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run(ctx) {
        const sel = editor.getSelection();
        if (!sel) return;
        const query = typeof ctx.args === "string" ? ctx.args : "";
        editor.replaceRange(embedPage(sel.start, sel.end, query));
      },
    },
    {
      id: "block.embedBlock",
      title: "Embed block",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run(ctx) {
        const sel = editor.getSelection();
        if (!sel) return;
        const query = typeof ctx.args === "string" ? ctx.args : "";
        editor.replaceRange(embedBlock(sel.start, sel.end, query));
      },
    },
    {
      id: "block.insertToday",
      title: "Today's date",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      run() {
        const sel = editor.getSelection();
        if (!sel) return;
        const title = formatJournalTitle(todayJournalDay(new Date(now())), journalTitleFormat());
        editor.replaceRange(insertToday(sel.start, sel.end, title));
      },
    },
    {
      id: "block.insertProperty",
      title: "Property",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused",
      // A real implementation opens a fuzzy key picker ("existing property-definition pages, plus
      // 'Create <key>'") before inserting; `ctx.args` lets a caller that already resolved a key
      // (e.g. the picker UI) skip straight to insertion. Defaults to an empty key placeholder.
      run(ctx) {
        const sel = editor.getSelection();
        if (!sel) return;
        const key = typeof ctx.args === "string" && ctx.args ? ctx.args : "key";
        editor.replaceRange(insertProperty(sel.content, key));
      },
    },
    {
      id: "block.openSlashMenu",
      title: "Open slash menu",
      category: "Insert",
      defaultKeys: {},
      when: "editorFocused && atLineStart",
      run() {
        const sel = editor.getSelection();
        if (!sel) return;
        editor.replaceRange({ from: sel.start, to: sel.end, text: "/", caretOffset: 1 });
      },
    },
  ];
}
