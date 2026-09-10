import { describe, expect, it } from "vitest";
import { computeSlashQuery, matchSlashTrigger } from "./trigger.js";

describe("matchSlashTrigger — fires at a text-run start (R53)", () => {
  it("fires when / is the very first character of the block", () => {
    expect(matchSlashTrigger("/")).toEqual({ from: 0, query: "" });
    expect(matchSlashTrigger("/tod")).toEqual({ from: 0, query: "tod" });
  });

  it("fires when / is immediately preceded by whitespace", () => {
    expect(matchSlashTrigger("hello /")).toEqual({ from: 6, query: "" });
    expect(matchSlashTrigger("hello /tab")).toEqual({ from: 6, query: "tab" });
    expect(matchSlashTrigger("a\n/x")).toEqual({ from: 2, query: "x" });
  });

  it("allows word characters and hyphens in the query", () => {
    expect(matchSlashTrigger("/code-block")).toEqual({ from: 0, query: "code-block" });
    expect(matchSlashTrigger("/h1_2")).toEqual({ from: 0, query: "h1_2" });
  });
});

describe("matchSlashTrigger — does NOT fire mid-word (R53)", () => {
  it("never triggers when / is preceded by a non-whitespace character", () => {
    expect(matchSlashTrigger("a/b")).toBeNull();
    expect(matchSlashTrigger("path/to/file")).toBeNull();
    expect(matchSlashTrigger("TODO/DONE")).toBeNull();
  });

  it("returns null when there's no slash-run before the caret at all", () => {
    expect(matchSlashTrigger("hello world")).toBeNull();
    expect(matchSlashTrigger("")).toBeNull();
  });

  it("returns null once the query is broken by a space (matchBefore only sees the trailing run)", () => {
    expect(matchSlashTrigger("/tod o")).toBeNull();
  });
});

describe("computeSlashQuery — live updates while the popup is open (R53)", () => {
  it("returns the growing query as more characters are typed", () => {
    expect(computeSlashQuery("/", 0)).toBe("");
    expect(computeSlashQuery("/t", 0)).toBe("t");
    expect(computeSlashQuery("/tod", 0)).toBe("tod");
  });

  it("closes when a space is typed into the query", () => {
    expect(computeSlashQuery("/tod ", 0)).toBeNull();
  });

  it("closes when the triggering / is deleted", () => {
    expect(computeSlashQuery("", 0)).toBeNull();
    expect(computeSlashQuery("x", 0)).toBeNull(); // '/' replaced by something else
  });

  it("closes when the caret moves back to/before the triggering /", () => {
    expect(computeSlashQuery("/", 5)).toBeNull(); // text shorter than the tracked offset
  });

  it("a second / typed immediately after the first stays open with a literal '/' query (documented R53 case)", () => {
    expect(computeSlashQuery("//", 0)).toBe("/");
  });

  it("works from a non-zero offset (slash mid-block, preceded by whitespace)", () => {
    expect(computeSlashQuery("hello /tab", 6)).toBe("tab");
    expect(computeSlashQuery("hello /tab ", 6)).toBeNull();
  });
});
