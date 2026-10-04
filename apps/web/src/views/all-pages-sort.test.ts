import { describe, expect, it } from "vitest";
import { nextSort } from "./all-pages-sort.js";

describe("All pages column sort (B-645)", () => {
  it("a new column starts at its natural direction; the active one flips", () => {
    expect(nextSort({ key: "updated", desc: true }, "name")).toEqual({ key: "name", desc: false });
    expect(nextSort({ key: "name", desc: false }, "words")).toEqual({ key: "words", desc: true });
    expect(nextSort({ key: "words", desc: true }, "words")).toEqual({ key: "words", desc: false });
    expect(nextSort({ key: "words", desc: false }, "words")).toEqual({ key: "words", desc: true });
  });
});
