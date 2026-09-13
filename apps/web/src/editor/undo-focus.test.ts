import { describe, expect, it } from "vitest";
import type { FocusChange } from "./types.js";
import { focusAfterStep } from "./undo-focus.js";

const rows = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

const at = (id: string, offset = 3): FocusChange => ({ id, caret: { offset } });

describe("focusAfterStep", () => {
  it("follows a recorded caret into a block that has a row", () => {
    expect(focusAfterStep(at("A"), "B", rows("A", "B"))).toEqual({
      kind: "caret",
      focus: at("A"),
    });
  });

  it("never follows a caret into a block with no row, and keeps the editor where it is (B-194)", () => {
    // "goes" moved to another page; the caret it recorded must not take the editor off "keep".
    expect(focusAfterStep(at("goes"), "keep", rows("keep"))).toEqual({ kind: "keep" });
  });

  it("a step with no caret leaves editing alone while the edited row is on screen (B-162)", () => {
    // Undo of a collapse of the block being edited: the row stays, so must the editor.
    expect(focusAfterStep(null, "parent", rows("parent", "kid"))).toEqual({ kind: "keep" });
  });

  it("nothing edited and nothing to follow: nothing to do", () => {
    expect(focusAfterStep(null, null, rows("A"))).toEqual({ kind: "keep" });
    expect(focusAfterStep(at("gone"), null, rows("A"))).toEqual({ kind: "keep" });
  });

  it("ends editing when the step took the edited row away and there is no caret to follow", () => {
    // Undo of an expand folds the edited block back under its parent; undo of a create removes it.
    expect(focusAfterStep(null, "kid", rows("parent"))).toEqual({ kind: "detach" });
    expect(focusAfterStep(at("gone"), "kid", rows("parent"))).toEqual({ kind: "detach" });
  });
});
