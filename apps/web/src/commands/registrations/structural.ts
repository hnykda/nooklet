/**
 * E.1 Block editing (category `Block`) — every command in this table is structural (splits,
 * merges, moves, selection-mode transitions, zoom, collapse/expand) and, per the task brief,
 * owned by the editor, not reimplemented here. This module only registers them (so the registry/
 * keymap/palette have the complete command set R1 requires, and Enter/Tab/Backspace/etc. all
 * resolve to *something* in the compiled keymap) with a one-line delegate to
 * `EditorHost.runStructuralCommand`. `edit.paste` rides along in the same table (R33: its
 * `Cmd/Ctrl+V` row is informational only — never matched by `handleKeyDown`, since paste is a
 * native DOM event — but it still needs a `Command` object for the palette/settings UI, R"33").
 */
import type { EditorHost } from "../hosts/editor-host.js";
import type { Command } from "../types.js";

interface StructuralSpec {
  id: string;
  title: string;
  mac?: string;
  other?: string;
  when?: string;
}

const STRUCTURAL_COMMANDS: readonly StructuralSpec[] = [
  { id: "block.split", title: "Split block", mac: "Enter", other: "Enter", when: "editorFocused" },
  {
    id: "block.newline",
    title: "Insert newline in block",
    mac: "Shift+Enter",
    other: "Shift+Enter",
    when: "editorFocused",
  },
  { id: "block.indent", title: "Indent block", mac: "Tab", other: "Tab", when: "editorFocused" },
  {
    id: "block.outdent",
    title: "Outdent block",
    mac: "Shift+Tab",
    other: "Shift+Tab",
    when: "editorFocused",
  },
  {
    id: "block.mergeWithPrevious",
    title: "Merge with previous block",
    mac: "Backspace",
    other: "Backspace",
    when: "editorFocused && atLineStart && !hasSelection",
  },
  {
    id: "block.deleteForwardMerge",
    title: "Merge next block into this one",
    mac: "Delete",
    other: "Delete",
    when: "editorFocused && atLineEnd && !hasSelection",
  },
  {
    id: "block.moveUp",
    title: "Move block up",
    mac: "Alt+Up",
    other: "Alt+Up",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.moveDown",
    title: "Move block down",
    mac: "Alt+Down",
    other: "Alt+Down",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.focusPreviousLine",
    title: "Move to previous block (same column)",
    mac: "Up",
    other: "Up",
    when: "editorFocused && onFirstVisualLine",
  },
  {
    id: "block.focusNextLine",
    title: "Move to next block (same column)",
    mac: "Down",
    other: "Down",
    when: "editorFocused && onLastVisualLine",
  },
  {
    id: "block.focusPreviousChar",
    title: "Move to end of previous block",
    mac: "Left",
    other: "Left",
    when: "editorFocused && atLineStart",
  },
  {
    id: "block.focusNextChar",
    title: "Move to start of next block",
    mac: "Right",
    other: "Right",
    when: "editorFocused && atLineEnd",
  },
  {
    id: "block.collapse",
    title: "Collapse block",
    mac: "Cmd+Up",
    other: "Ctrl+Up",
    when: "(editorFocused || blockSelected) && hasChildren && !isCollapsed",
  },
  {
    id: "block.expand",
    title: "Expand block",
    mac: "Cmd+Down",
    other: "Ctrl+Down",
    when: "(editorFocused || blockSelected) && hasChildren && isCollapsed",
  },
  { id: "block.collapseAll", title: "Collapse all", when: "true" },
  { id: "block.expandAll", title: "Expand all", when: "true" },
  {
    id: "block.zoomIn",
    title: "Zoom into block",
    mac: "Cmd+.",
    other: "Ctrl+.",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.zoomOut",
    title: "Zoom out",
    mac: "Cmd+Shift+.",
    other: "Ctrl+Shift+.",
    when: "zoomed",
  },
  {
    id: "block.selectBlock",
    title: "Select block",
    mac: "Escape",
    other: "Escape",
    when: "editorFocused && !popupOpen",
  },
  {
    id: "block.editSelected",
    title: "Edit selected block",
    mac: "Enter",
    other: "Enter",
    when: "blockSelected",
  },
  {
    id: "block.clearSelection",
    title: "Clear selection",
    mac: "Escape",
    other: "Escape",
    when: "blockSelected",
  },
  {
    id: "block.extendSelectionUp",
    title: "Extend selection up",
    mac: "Shift+Up",
    other: "Shift+Up",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.extendSelectionDown",
    title: "Extend selection down",
    mac: "Shift+Down",
    other: "Shift+Down",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.selectAll",
    title: "Select all blocks",
    mac: "Cmd+A",
    other: "Ctrl+A",
    when: "blockSelected",
  },
  {
    id: "block.deleteSelected",
    title: "Delete selected blocks",
    mac: "Backspace",
    other: "Backspace",
    when: "blockSelected",
  },
  {
    id: "block.indentSelected",
    title: "Indent selected blocks",
    mac: "Tab",
    other: "Tab",
    when: "blockSelected",
  },
  {
    id: "block.outdentSelected",
    title: "Outdent selected blocks",
    mac: "Shift+Tab",
    other: "Shift+Tab",
    when: "blockSelected",
  },
  {
    id: "block.copySelection",
    title: "Copy selected blocks as markdown",
    mac: "Cmd+C",
    other: "Ctrl+C",
    when: "blockSelected",
  },
  {
    id: "block.cutSelection",
    title: "Cut selected blocks as markdown",
    mac: "Cmd+X",
    other: "Ctrl+X",
    when: "blockSelected",
  },
  {
    id: "block.duplicate",
    title: "Duplicate block",
    mac: "Cmd+Shift+D",
    other: "Ctrl+Shift+D",
    when: "editorFocused || blockSelected",
  },
  {
    id: "block.copyRef",
    title: "Copy block reference",
    mac: "Cmd+Shift+C",
    other: "Ctrl+Shift+C",
    when: "editorFocused || blockSelected",
  },
  { id: "edit.paste", title: "Paste", mac: "Cmd+V", other: "Ctrl+V", when: "editorFocused" },
];

export function createStructuralCommands(deps: { editor: EditorHost }): Command[] {
  const { editor } = deps;
  return STRUCTURAL_COMMANDS.map(
    (spec): Command => ({
      id: spec.id,
      title: spec.title,
      category: "Block",
      defaultKeys: { mac: spec.mac, other: spec.other },
      when: spec.when,
      run(ctx) {
        return editor.runStructuralCommand(spec.id, ctx);
      },
    }),
  );
}
