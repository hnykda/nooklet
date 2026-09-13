// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isOtherTextField, isTextEditingKey, textFieldOwnsKey } from "./text-field-keys.js";

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
