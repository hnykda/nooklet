// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { rememberFocus } from "./focus-return.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** An editor-like field, and an overlay with its own input, the shape the palette has. */
function setup(): { field: HTMLInputElement; overlay: HTMLDivElement; input: HTMLInputElement } {
  const field = document.createElement("input");
  const overlay = document.createElement("div");
  const input = document.createElement("input");
  overlay.appendChild(input);
  document.body.append(field, overlay);
  return { field, overlay, input };
}

describe("rememberFocus (B-161)", () => {
  it("gives focus back when the overlay's removal dropped it to <body>", () => {
    const { field, overlay, input } = setup();
    field.focus();
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    overlay.remove();
    expect(document.activeElement).toBe(document.body);
    giveBack();
    expect(document.activeElement).toBe(field);
  });

  it("gives focus back while focus is still inside the overlay (called before its DOM goes)", () => {
    const { field, overlay, input } = setup();
    field.focus();
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    giveBack();
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus alone when something else took it on purpose", () => {
    const { field, overlay, input } = setup();
    const other = document.createElement("input");
    document.body.appendChild(other);
    field.focus();
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    other.focus(); // e.g. a picker a palette command opened
    giveBack();
    expect(document.activeElement).toBe(other);
  });

  it("does not focus an element that left the document (editing ended, page unmounted)", () => {
    const { field, overlay, input } = setup();
    field.focus();
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    field.remove();
    overlay.remove();
    giveBack();
    expect(document.activeElement).toBe(document.body);
  });

  it("does nothing when nothing had focus before", () => {
    const { overlay, input } = setup();
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    overlay.remove();
    giveBack();
    expect(document.activeElement).toBe(document.body);
  });

  it("puts the caret back inside an editable, not at its start (B-296)", () => {
    const { overlay, input } = setup();
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.tabIndex = 0; // jsdom focuses only what it considers focusable
    editable.textContent = "abcdef";
    document.body.prepend(editable);
    const text = editable.firstChild as Text;
    editable.focus();
    document.getSelection()?.setBaseAndExtent(text, 2, text, 4);
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    document.getSelection()?.setBaseAndExtent(overlay, 0, overlay, 0); // the input took it
    overlay.remove();
    giveBack();
    const sel = document.getSelection();
    expect(document.activeElement).toBe(editable);
    expect([sel?.anchorNode, sel?.anchorOffset, sel?.focusNode, sel?.focusOffset]).toEqual([
      text,
      2,
      text,
      4,
    ]);
  });

  it("leaves the caret to the editor when the remembered text node is gone", () => {
    const { overlay, input } = setup();
    const editable = document.createElement("div");
    editable.tabIndex = 0;
    editable.textContent = "abcdef";
    document.body.prepend(editable);
    const text = editable.firstChild as Text;
    editable.focus();
    document.getSelection()?.setBaseAndExtent(text, 3, text, 3);
    const giveBack = rememberFocus(() => overlay);
    input.focus();
    editable.textContent = "re-rendered"; // replaces the text node
    overlay.remove();
    expect(() => giveBack()).not.toThrow();
    expect(document.activeElement).toBe(editable);
    expect(document.getSelection()?.anchorNode).not.toBe(text);
  });
});
