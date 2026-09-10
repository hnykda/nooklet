import { describe, expect, it } from "vitest";
import { normalizeForMatch } from "./normalize.js";

describe("normalizeForMatch (R70)", () => {
  it("folds Czech diacritics (č matches c)", () => {
    expect(normalizeForMatch("č")).toBe("c");
    expect(normalizeForMatch("Čapek")).toBe("capek");
  });

  it("lowercases", () => {
    expect(normalizeForMatch("HELLO")).toBe("hello");
  });

  it("leaves plain ASCII untouched (besides case)", () => {
    expect(normalizeForMatch("Journal 2026")).toBe("journal 2026");
  });

  it("handles a mix of diacritics across scripts", () => {
    expect(normalizeForMatch("café")).toBe("cafe");
    expect(normalizeForMatch("naïve")).toBe("naive");
  });
});
