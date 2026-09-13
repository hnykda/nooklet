// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../commands/hosts/editor-host.js";
import { createFakeAppHost, createFakeNavigationHost } from "../commands/hosts/nav-host.js";
import { createFakeStore } from "../commands/hosts/store.js";
import { buildKeymap } from "../commands/keymap/build.js";
import { createDispatcher } from "../commands/keymap/dispatch.js";
import { chordSteps, parseSingleToken } from "../commands/keymap/notation.js";
import { createPaletteController } from "../commands/palette/palette-controller.js";
import { createFakeDatePickerHost } from "../commands/registrations/date-picker-host.js";
import { createCoreCommands } from "../commands/registrations/index.js";
import { createFakePageFindHost } from "../commands/registrations/page-find.js";
import type { WhenContext } from "../commands/types.js";
import { type ContextBase, withoutOutliner } from "./editor-host.js";
import {
  isFieldOutsideOutliner,
  isOtherTextField,
  isTextEditingKey,
  textFieldOwnsKey,
} from "./text-field-keys.js";

const key = (
  k: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isTextEditingKey (B-347)", () => {
  it("claims the keys that edit or move inside a field, and the field's clipboard/undo", () => {
    for (const k of ["Backspace", "Delete", "ArrowUp", "ArrowLeft", "Home", "End"]) {
      expect(isTextEditingKey(key(k), true)).toBe(true);
    }
    expect(isTextEditingKey(key("ArrowUp", { shiftKey: true }), true)).toBe(true);
    expect(isTextEditingKey(key("ArrowUp", { altKey: true }), true)).toBe(true);
    expect(isTextEditingKey(key("a", { metaKey: true }), true)).toBe(true);
    expect(isTextEditingKey(key("z", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isTextEditingKey(key("c", { ctrlKey: true }), false)).toBe(true);
  });

  it("leaves Escape, Enter, Tab and the global shortcuts to the dispatcher", () => {
    expect(isTextEditingKey(key("Escape"), true)).toBe(false);
    expect(isTextEditingKey(key("Enter"), true)).toBe(false);
    expect(isTextEditingKey(key("Tab"), true)).toBe(false);
    expect(isTextEditingKey(key("k", { metaKey: true }), true)).toBe(false);
    expect(isTextEditingKey(key("j", { ctrlKey: true }), false)).toBe(false);
    // Ctrl+A on a Mac is a text motion, but not one this list claims; Cmd is the Mod there.
    expect(isTextEditingKey(key("a", { ctrlKey: true }), true)).toBe(false);
    // Alt+Left/Right is Back/Forward outside macOS.
    expect(isTextEditingKey(key("ArrowLeft", { altKey: true }), false)).toBe(false);
    expect(isTextEditingKey(key("ArrowLeft", { altKey: true }), true)).toBe(true);
  });
});

describe("isOtherTextField (B-347)", () => {
  it("is a text input, a textarea or a contenteditable — not the block editor, not a checkbox", () => {
    const input = document.createElement("input");
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    const area = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    content.contentEditable = "true";
    editor.append(content);
    const button = document.createElement("button");
    document.body.append(input, checkbox, area, editor, button);

    expect(isOtherTextField(input)).toBe(true);
    expect(isOtherTextField(area)).toBe(true);
    expect(isOtherTextField(checkbox)).toBe(false);
    expect(isOtherTextField(content)).toBe(false);
    expect(isOtherTextField(button)).toBe(false);
    expect(isOtherTextField(null)).toBe(false);

    expect(textFieldOwnsKey({ ...key("Backspace"), target: input }, true)).toBe(true);
    expect(textFieldOwnsKey({ ...key("Backspace"), target: content }, true)).toBe(false);
    expect(textFieldOwnsKey({ ...key("Escape"), target: input }, true)).toBe(false);
  });
});

describe("isFieldOutsideOutliner (B-300)", () => {
  it("is any input, textarea, select or contenteditable that is not inside the outliner", () => {
    const title = document.createElement("textarea");
    const query = document.createElement("input");
    const date = Object.assign(document.createElement("input"), { type: "date" });
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not compute `isContentEditable`.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    const button = document.createElement("button");
    const outliner = document.createElement("div");
    outliner.className = "vr-outliner";
    outliner.tabIndex = -1;
    const surface = document.createElement("div");
    surface.className = "cm-editor";
    const content = document.createElement("div");
    content.contentEditable = "true";
    Object.defineProperty(content, "isContentEditable", { value: true });
    surface.append(content);
    const checkboxInBlock = Object.assign(document.createElement("input"), { type: "checkbox" });
    outliner.append(surface, checkboxInBlock);
    document.body.append(title, query, date, select, editable, button, outliner);

    for (const field of [title, query, date, select, editable]) {
      expect(isFieldOutsideOutliner(field)).toBe(true);
    }
    // The outliner's own keys are commands: its container, the block editor, a control in a row.
    for (const el of [outliner, content, checkboxInBlock]) {
      expect(isFieldOutsideOutliner(el)).toBe(false);
    }
    expect(isFieldOutsideOutliner(button)).toBe(false);
    expect(isFieldOutsideOutliner(document.body)).toBe(false);
    expect(isFieldOutsideOutliner(null)).toBe(false);
  });
});

describe("the default keymap, typed into a field outside the outliner (B-300)", () => {
  const FULL: WhenContext = {
    editorFocused: true,
    blockSelected: true,
    hasSelection: true,
    selectionCount: 1,
    isTask: true,
    isCollapsed: false,
    hasChildren: true,
    atLineStart: true,
    atLineEnd: true,
    onFirstVisualLine: true,
    onLastVisualLine: true,
    caretInLink: true,
    popupOpen: false,
    composing: false,
    zoomed: true,
    pageView: true,
    platform: "mac",
    mobile: false,
  };

  /** Every command a single key of the default mac keymap runs from `target`, over a context in
   * which an edit AND a selection stand (collapsed and not), dispatched as `CommandLayer` does. */
  function reachable(target: HTMLElement): string[] {
    const commands = createCoreCommands({
      editor: createFakeEditorHost(),
      navigation: createFakeNavigationHost(),
      app: createFakeAppHost(),
      palette: createPaletteController(),
      datePicker: createFakeDatePickerHost(),
      pageFind: createFakePageFindHost(),
    });
    const bindings = buildKeymap(commands, [], { platform: "mac" });
    const dispatcher = createDispatcher({ getBindings: () => bindings });
    const ran = new Set<string>();
    const named: Record<string, string> = {
      Up: "ArrowUp",
      Down: "ArrowDown",
      Left: "ArrowLeft",
      Right: "ArrowRight",
      Space: " ",
    };
    for (const row of bindings) {
      if (chordSteps(row.key).length !== 1) continue;
      const { mods, base } = parseSingleToken(row.key);
      const event = {
        key: named[base] ?? (base.length === 1 ? base.toLowerCase() : base),
        metaKey: mods.cmd,
        ctrlKey: mods.ctrl,
        altKey: mods.alt,
        shiftKey: mods.shift,
        target,
        preventDefault: () => {},
      };
      for (const isCollapsed of [false, true]) {
        const full: ContextBase = {
          ...FULL,
          isCollapsed,
          focusedBlockId: "b1",
          selectedBlockIds: ["b1"],
          surface: null,
          store: createFakeStore(),
        };
        // Exactly what `CommandLayer#KeyboardDispatch` does with a keydown.
        if (textFieldOwnsKey(event, true)) continue;
        const ctx = isFieldOutsideOutliner(target) ? withoutOutliner(full) : full;
        dispatcher.resetChord();
        dispatcher.handleKeyDown(event, {
          ...ctx,
          exec: async (id) => {
            ran.add(id);
          },
        });
      }
    }
    return [...ran].sort();
  }

  it("runs only the global shortcuts — nothing that acts on a block", () => {
    const title = document.createElement("textarea");
    document.body.append(title);
    expect(reachable(title)).toEqual([
      "app.openSettings",
      "app.toggleSidebar",
      "nav.back",
      "nav.forward",
      "nav.journals",
      "nav.switchPage",
      "nav.todayJournal",
      "palette.open",
      "search.findInPage",
      "search.open",
    ]);
  });

  it("while the same keys from the outliner still reach its commands", () => {
    const outliner = document.createElement("div");
    outliner.className = "vr-outliner";
    document.body.append(outliner);
    const fromOutliner = reachable(outliner);
    for (const id of [
      "block.deleteSelected",
      "block.cutSelection",
      "block.split",
      "block.duplicate",
      "block.zoomIn",
      "format.insertLink",
      "edit.undo",
      "palette.open",
    ]) {
      expect(fromOutliner).toContain(id);
    }
  });
});
