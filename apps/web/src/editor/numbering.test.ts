import { describe, expect, it } from "vitest";
import { deriveNumbering } from "./numbering.js";

describe("deriveNumbering (markdown-grammar OUT-17)", () => {
  it("numbers a contiguous run of list:: number siblings starting at 1", () => {
    const nums = deriveNumbering(["a", "b", "c"], () => true);
    expect(nums.get("a")).toBe(1);
    expect(nums.get("b")).toBe(2);
    expect(nums.get("c")).toBe(3);
  });

  it("resets the run when a non-numbered sibling interrupts it", () => {
    const numbered = new Set(["a", "b", "d", "e"]);
    const nums = deriveNumbering(["a", "b", "c", "d", "e"], (id) => numbered.has(id));
    expect(nums.get("a")).toBe(1);
    expect(nums.get("b")).toBe(2);
    expect(nums.has("c")).toBe(false);
    expect(nums.get("d")).toBe(1); // run restarts after the interruption
    expect(nums.get("e")).toBe(2);
  });

  it("returns no ordinals when nothing is numbered", () => {
    const nums = deriveNumbering(["a", "b"], () => false);
    expect(nums.size).toBe(0);
  });

  it("is empty for an empty sibling list", () => {
    expect(deriveNumbering([], () => true).size).toBe(0);
  });
});
