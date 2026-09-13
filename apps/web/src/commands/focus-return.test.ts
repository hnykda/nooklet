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
});
