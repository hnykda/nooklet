import { describe, expect, it } from "vitest";
import { isValidGraphId } from "./paths.js";

describe("isValidGraphId", () => {
  it.each(["default", "work", "a", "my-graph", "graph2", "a".repeat(64)])("accepts %s", (id) => {
    expect(isValidGraphId(id)).toBe(true);
  });

  it.each([
    "", // empty
    "-leading-hyphen",
    "trailing-hyphen-",
    "Has-Capitals",
    "has spaces",
    "has/slash",
    "has.dot",
    "graphs", // reserved
    "a".repeat(65), // too long
  ])("rejects %s", (id) => {
    expect(isValidGraphId(id)).toBe(false);
  });
});
