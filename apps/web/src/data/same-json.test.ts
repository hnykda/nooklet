import { describe, expect, it } from "vitest";
import { sameJson } from "./same-json.js";

describe("sameJson", () => {
  it("equal data built twice is the same; any difference is not", () => {
    const read = (text: string) => ({ groups: [{ pageId: "p", hits: [{ id: "a", text }] }] });
    expect(sameJson(read("x"), read("x"))).toBe(true);
    expect(sameJson(read("x"), read("y"))).toBe(false);
    expect(sameJson([["k", "v"]], [["k", "v"]])).toBe(true);
    expect(sameJson([["k", "v"]], [["k", "w"]])).toBe(false);
  });

  it("undefined is only the same as undefined", () => {
    expect(sameJson(undefined, undefined)).toBe(true);
    expect(sameJson(undefined, {})).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
  });
});
