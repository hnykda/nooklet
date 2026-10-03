import { describe, expect, it } from "vitest";
import {
  computeBlockRefQuery,
  computePageRefQuery,
  computeTagQuery,
  existingRefTailLength,
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

describe("matchTagTrigger — caret inside an existing tag (B-380)", () => {
  it("does not open when the text after the caret continues the tag", () => {
    // B-380's steps: `alpha #WalkTagTarget omega`, caret after `#WalkT`.
    expect(matchTagTrigger("alpha #WalkT", "agTarget omega")).toBeNull();
    expect(matchTagTrigger("#", "tag")).toBeNull();
    expect(matchTagTrigger("#ta", "g.x")).toBeNull();
    // Owner-accepted cost of option (c): `#` typed straight before a word gets no popup.
    expect(matchTagTrigger("alpha #Wa", "omega")).toBeNull();
  });

  it("still opens at the end of a tag: end of text, whitespace, a stop char or trailing punctuation", () => {
    expect(matchTagTrigger("hello #ta")).toEqual({ from: 6, query: "ta" });
    expect(matchTagTrigger("hello #ta", "")).toEqual({ from: 6, query: "ta" });
    expect(matchTagTrigger("hello #ta", " more")).toEqual({ from: 6, query: "ta" });
    expect(matchTagTrigger("#ta", "\nnext line")).toEqual({ from: 0, query: "ta" });
    expect(matchTagTrigger("#ta", ") x")).toEqual({ from: 0, query: "ta" });
    expect(matchTagTrigger("#ta", ", x")).toEqual({ from: 0, query: "ta" });
    expect(matchTagTrigger("#ta", ".")).toEqual({ from: 0, query: "ta" });
    expect(matchTagTrigger("#ta", "?! x")).toEqual({ from: 0, query: "ta" });
  });

  it("leaves the #[[multi word]] form alone (an auto-paired ]] after the caret is a stop)", () => {
    expect(matchTagTrigger("#[[", "]]")).toEqual({ from: 0, query: "[[" });
    expect(matchPageRefTrigger("#[[multi")).toEqual({ from: 1, query: "multi" });
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

describe("existingRefTailLength — the rest of a link the caret was walked into (B-294)", () => {
  it("runs to the closing ]] of the link the caret is inside, closer included", () => {
    expect(existingRefTailLength("arget]] omega", "]]")).toBe("arget]]".length);
    expect(existingRefTailLength("]] omega", "]]")).toBe(2);
    expect(existingRefTailLength("snip)) after", "))")).toBe("snip))".length);
  });

  it("is 0 when the text after the caret closes no link", () => {
    expect(existingRefTailLength(" plain text", "]]")).toBe(0);
    expect(existingRefTailLength("", "]]")).toBe(0);
    // A newline ends the line the link would have to close on.
    expect(existingRefTailLength("arget\nmore]]", "]]")).toBe(0);
  });

  it("does not swallow another link that follows a freshly typed [[", () => {
    expect(existingRefTailLength("[[Other]] tail", "]]")).toBe(0);
    expect(existingRefTailLength("x [[Other]]", "]]")).toBe(0);
    expect(existingRefTailLength("((abc))", "))")).toBe(0);
  });
});
