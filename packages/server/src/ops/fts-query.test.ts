import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ftsPhrase, toFtsQuery } from "./fts-query.js";

describe("toFtsQuery", () => {
  it.each([
    ["hello", '"hello"'],
    ["hello world", '"hello" "world"'],
    ['"foo bar"', '"foo bar"'],
    ['"foo bar" baz', '"foo bar" "baz"'],
    ["foo -bar", '"foo" NOT "bar"'],
    ['foo -"bar baz"', '"foo" NOT "bar baz"'],
    ["foo*", '"foo"*'],
    ['"unbalanced', '"unbalanced"'],
    ['say "hi" there', '"say" "hi" "there"'],
    ["c++", '"c++"'],
    ["what's", '"what\'s"'],
    ["e-mail", '"e-mail"'],
    ["a.b", '"a.b"'],
    ["AND", '"AND"'],
    ["(", '"("'],
    ["  padded   ", '"padded"'],
  ])("%s -> %s", (raw, expected) => {
    expect(toFtsQuery(raw)).toBe(expected);
  });

  it("is null when nothing positive remains to match", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("-foo")).toBeNull();
    expect(toFtsQuery('""')).toBeNull();
    expect(toFtsQuery("*")).toBeNull();
    expect(toFtsQuery("-")).toBe('"-"'); // a lone dash is a word, not a negation of nothing
  });

  it("doubles embedded quotes so the literal stays closed", () => {
    expect(ftsPhrase('he said "no"')).toBe('"he said ""no"""');
  });
});

/**
 * The property that actually matters: whatever the user types, the expression we build parses.
 * Run against a real FTS5 table with the same tokenizer `schema.ts` uses, so this is the exact
 * failure mode from the probe, not a model of it.
 */
describe("toFtsQuery against real FTS5", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE VIRTUAL TABLE t USING fts5(content, tokenize="unicode61 remove_diacritics 2 tokenchars '-_'")`,
  );
  db.exec(
    `INSERT INTO t(content) VALUES
       ('hello world c++ what''s up'), ('send an e-mail to bob'), ('foo bar'), ('foo-bar baz'),
       ('člověk a stroj')`,
  );
  const hits = (raw: string): string[] => {
    const q = toFtsQuery(raw);
    if (q === null) return [];
    return db
      .prepare("SELECT content FROM t WHERE t MATCH ? ORDER BY rowid")
      .all(q)
      .map((r) => (r as { content: string }).content);
  };

  it.each([
    "c++",
    '"unbalanced',
    "what's",
    "foo -bar",
    "AND",
    "OR",
    "NOT",
    "a.b",
    "foo*",
    "(",
    ")",
    "e-mail",
    "-foo",
    "--",
    "*",
    '"',
    "foo:bar",
    "^caret",
    "{brace}",
    "[bracket]",
  ])("never throws for %j", (raw) => {
    expect(() => hits(raw)).not.toThrow();
  });

  it("matches the terms it promises", () => {
    expect(hits("c++")).toEqual(["hello world c++ what's up"]);
    expect(hits("e-mail")).toEqual(["send an e-mail to bob"]);
    expect(hits("foo -baz")).toEqual(["foo bar"]);
    expect(hits('"foo bar"')).toEqual(["foo bar"]);
    expect(hits("clovek")).toEqual(["člověk a stroj"]); // remove_diacritics on both sides
    expect(hits("wor*")).toEqual(["hello world c++ what's up"]);
  });
});
