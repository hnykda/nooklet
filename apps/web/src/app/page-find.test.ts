import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePageFindHost,
  createPageFindCommands,
} from "../commands/registrations/page-find.js";
import { DEFAULT_WHEN_CONTEXT } from "../commands/types.js";
import { matchesWhen } from "../commands/when/index.js";
import {
  blockFocusCaret,
  blockFocusRequest,
  clearBlockFocusRequest,
  editingEndRequest,
} from "../editor/focus-request.js";
import {
  closePageFind,
  openPageFind,
  pageFindAvailable,
  pageFindFocusRequest,
  pageFindOpen,
  registerPageFindHost,
} from "./page-find.js";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  closePageFind({ restoreFocus: false });
  clearBlockFocusRequest();
});

describe("page find state", () => {
  it("does nothing without a page view to host the bar", () => {
    expect(pageFindAvailable()).toBe(false);
    openPageFind(null);
    expect(pageFindOpen()).toBe(false);
  });

  it("opens, asks every tree to stop editing, and refocuses on a repeated open", () => {
    release = registerPageFindHost();
    const endBefore = editingEndRequest();
    const focusBefore = pageFindFocusRequest();
    openPageFind(null);
    expect(pageFindOpen()).toBe(true);
    expect(editingEndRequest()).toBe(endBefore + 1);
    openPageFind(null);
    expect(pageFindFocusRequest()).toBe(focusBefore + 2);
  });

  it("Escape-style close puts the caret back where editing was when the bar opened", () => {
    release = registerPageFindHost();
    openPageFind({ blockId: "b1", content: "hello", start: 3, end: 3 });
    // A second Cmd+F from inside the bar (nothing being edited) keeps the original place.
    openPageFind(null);
    closePageFind({ restoreFocus: true });
    expect(pageFindOpen()).toBe(false);
    expect(blockFocusRequest()).toBe("b1");
    expect(blockFocusCaret()).toEqual({ offset: 3 });
  });

  it("puts back a content offset when the editing buffer shows property lines (B-361)", () => {
    release = registerPageFindHost();
    // The editor's selection is into its buffer, which lists `list:: number` after line 1
    // (B-101). The caret after "second" is 31 there and 17 in the content — and the tree that
    // takes the focus request maps a content offset into its buffer itself.
    const buffer = "first line\nlist:: number\nsecond line";
    const head = buffer.indexOf("second") + "second".length;
    openPageFind({ blockId: "b1", content: buffer, start: head, end: head });
    closePageFind({ restoreFocus: true });
    expect(blockFocusCaret()).toEqual({ offset: "first line\nsecond".length });
  });

  it("a close that does not restore focus leaves no focus request behind", () => {
    release = registerPageFindHost();
    openPageFind({ blockId: "b1", content: "hello", start: 3, end: 3 });
    closePageFind({ restoreFocus: false });
    expect(blockFocusRequest()).toBeUndefined();
  });

  it("closes when the last page view goes away", () => {
    release = registerPageFindHost();
    openPageFind(null);
    release();
    release = undefined;
    expect(pageFindAvailable()).toBe(false);
    expect(pageFindOpen()).toBe(false);
  });
});

describe("search.findInPage", () => {
  it("binds Cmd/Ctrl+F only where a page view is showing", () => {
    const host = createFakePageFindHost();
    const [command] = createPageFindCommands({ pageFind: host });
    expect(command?.defaultKeys).toEqual({ mac: "Cmd+F", other: "Ctrl+F" });
    expect(matchesWhen(command?.when, { ...DEFAULT_WHEN_CONTEXT, pageView: true })).toBe(true);
    // Everywhere else the key must stay the browser's.
    expect(matchesWhen(command?.when, { ...DEFAULT_WHEN_CONTEXT, editorFocused: true })).toBe(
      false,
    );
  });
});
