import { describe, expect, it } from "vitest";
import type { KeptEdit } from "../data/history.js";
import { keptEditsSentence } from "./keptEdits.js";

const block = (id: string, page: string): KeptEdit => ({
  entityType: "block",
  id,
  page,
  fields: ["content"],
});

describe("keptEditsSentence", () => {
  it("is empty when nothing was kept", () => {
    expect(keptEditsSentence([])).toBe("");
  });

  it("names the page of a single kept block", () => {
    expect(keptEditsSentence([block("a", "Megapage")])).toBe(
      "1 block changed again later was left as it is, on Megapage.",
    );
  });

  it("counts an entity reported by several steps of a walk once", () => {
    expect(keptEditsSentence([block("a", "A"), block("a", "A"), block("b", "B")])).toBe(
      "2 blocks changed again later were left as they are, on A, B.",
    );
  });

  it("names three pages and counts the rest, and mentions pages as well as blocks", () => {
    const kept: KeptEdit[] = [
      block("1", "P1"),
      block("2", "P2"),
      block("3", "P3"),
      block("4", "P4"),
      block("5", "P5"),
      { entityType: "page", id: "p", page: "P1", fields: ["name"] },
    ];
    expect(keptEditsSentence(kept)).toBe(
      "5 blocks and 1 page changed again later were left as they are, on P1, P2, P3 and 2 more pages.",
    );
  });
});
