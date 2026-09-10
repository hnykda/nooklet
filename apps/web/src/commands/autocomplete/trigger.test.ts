import { describe, expect, it } from "vitest";
import {
  computeBlockRefQuery,
  computePageRefQuery,
  computeTagQuery,
  matchBlockRefTrigger,
  matchPageRefTrigger,
  matchTagTrigger,
} from "./trigger.js";

describe("matchPageRefTrigger — [[ (R56)", () => {
  it("triggers immediately after [[", () => {
    expect(matchPageRefTrigger("hello [[")).toEqual({ from: 6, query: "" });
    expect(matchPageRefTrigger("[[Some Page")).toEqual({ from: 0, query: "Some Page" });
  });

  it("does not trigger with only a single [", () => {
    expect(matchPageRefTrigger("hello [wor")).toBeNull();
  });

  it("stops matching once a ] or newline appears in the query", () => {
    expect(matchPageRefTrigger("[[Page]] more")).toBeNull();
  });

  it("can appear mid-word (no start-of-run restriction, unlike # and /)", () => {
    expect(matchPageRefTrigger("word[[query")).toEqual({ from: 4, query: "query" });
  });
});

describe("computePageRefQuery — dismissal (R56)", () => {
  it("grows the query as more is typed", () => {
    expect(computePageRefQuery("[[", 0)).toBe("");
    expect(computePageRefQuery("[[Sp", 0)).toBe("Sp");
  });

  it("closes when a ] enters the query", () => {
    expect(computePageRefQuery("[[Sp]", 0)).toBeNull();
  });

  it("closes when the caret moves back through either [", () => {
    expect(computePageRefQuery("[", 0)).toBeNull();
    expect(computePageRefQuery("", 0)).toBeNull();
  });
});

describe("matchTagTrigger — # (R57, start-of-run like the slash trigger)", () => {
  it("triggers at the start of the block or after whitespace", () => {
    expect(matchTagTrigger("#")).toEqual({ from: 0, query: "" });
    expect(matchTagTrigger("hello #wor")).toEqual({ from: 6, query: "wor" });
  });

  it("does NOT trigger mid-word", () => {
    expect(matchTagTrigger("word#tag")).toBeNull();
  });

  it("stops the query at whitespace or another #", () => {
    expect(matchTagTrigger("#tag extra")).toBeNull();
    expect(matchTagTrigger("#tag#")).toBeNull();
  });
});

describe("computeTagQuery — dismissal (R57)", () => {
  it("grows the query as more is typed", () => {
    expect(computeTagQuery("#", 0)).toBe("");
    expect(computeTagQuery("#wo", 0)).toBe("wo");
  });

  it("closes on a space or a second #", () => {
    expect(computeTagQuery("#wo ", 0)).toBeNull();
    expect(computeTagQuery("#wo#", 0)).toBeNull();
  });

  it("closes when the triggering # is deleted", () => {
    expect(computeTagQuery("", 0)).toBeNull();
  });
});

describe("matchBlockRefTrigger — (( (R58)", () => {
  it("triggers immediately after ((", () => {
    expect(matchBlockRefTrigger("see ((")).toEqual({ from: 4, query: "" });
    expect(matchBlockRefTrigger("((some text")).toEqual({ from: 0, query: "some text" });
  });

  it("does not trigger with only a single (", () => {
    expect(matchBlockRefTrigger("(wor")).toBeNull();
  });

  it("stops matching once a ) or newline appears in the query", () => {
    expect(matchBlockRefTrigger("((abc)) more")).toBeNull();
  });
});

describe("computeBlockRefQuery — dismissal (R58)", () => {
  it("grows the query as more is typed", () => {
    expect(computeBlockRefQuery("((", 0)).toBe("");
    expect(computeBlockRefQuery("((snip", 0)).toBe("snip");
  });

  it("closes when a ) enters the query", () => {
    expect(computeBlockRefQuery("((snip)", 0)).toBeNull();
  });

  it("closes when the caret moves back through either (", () => {
    expect(computeBlockRefQuery("(", 0)).toBeNull();
  });
});
