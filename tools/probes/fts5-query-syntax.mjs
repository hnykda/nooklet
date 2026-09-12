import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(
  `CREATE VIRTUAL TABLE t USING fts5(content, tokenize="unicode61 remove_diacritics 2 tokenchars '-_'")`,
);
db.exec(
  `INSERT INTO t(content) VALUES ('hello world c++ what''s up'), ('foo bar'), ('foo-bar baz')`,
);
for (const q of [
  "hello",
  "c++",
  '"unbalanced',
  "what's",
  "foo -bar",
  "foo NOT bar",
  "AND",
  "a.b",
  "foo*",
  "(",
  "člověk",
  "foo-bar",
  '"foo bar"',
  "foo OR bar",
  "-foo",
]) {
  try {
    const rows = db.prepare("SELECT content FROM t WHERE t MATCH ?").all(q);
    console.log(JSON.stringify(q), "->", rows.length, "rows");
  } catch (e) {
    console.log(JSON.stringify(q), "-> ERROR", e.message);
  }
}
