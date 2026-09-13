import { beforeEach, describe, expect, it } from "vitest";
import { matchQuery, parseQuery, queryPrefilter } from "./query.js";
import type { SqlDriver } from "./sync/driver.js";
import { createNodeSqliteDriver, openNodeSqlite } from "./sync/node-sqlite-driver.js";
import { initSchema } from "./sync/schema.js";

let d: SqlDriver;
beforeEach(() => {
  d = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(d);
  d.run(
    "INSERT INTO page(id, name, key, journal_day, created_at, updated_at, name_hlc) VALUES ('p', 'P', 'p', NULL, 1, 1, 'h')",
  );
});

function block(id: string, content: string, props: Record<string, string> = {}): void {
  d.run(
    `INSERT INTO block(id, page_id, parent_id, order_key, content, created_at, updated_at, place_hlc, content_hlc)
     VALUES (?, 'p', NULL, ?, ?, 1, 1, 'h', 'h')`,
    [id, `a${id}`, content],
  );
  for (const [key, value] of Object.entries(props)) {
    d.run("INSERT INTO block_prop(block_id, key, value, hlc) VALUES (?, ?, ?, 'h')", [
      id,
      key,
      value,
    ]);
  }
}

function prefiltered(q: string): string[] {
  const parsed = parseQuery(q);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const pre = queryPrefilter(parsed.query.where, { today: 20260913 });
  return d
    .all<{ id: string }>(
      `SELECT b.id FROM block b JOIN page p ON p.id = b.page_id WHERE ${pre.sql} ORDER BY b.id`,
      pre.params,
    )
    .map((r) => r.id);
}

function matching(q: string): string[] {
  const parsed = parseQuery(q);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const rows = d.all<{ id: string; content: string }>("SELECT id, content FROM block ORDER BY id");
  return rows
    .filter((r) => {
      const properties = Object.fromEntries(
        d
          .all<{ key: string; value: string }>(
            "SELECT key, value FROM block_prop WHERE block_id = ?",
            [r.id],
          )
          .map((p) => [p.key, p.value]),
      );
      return matchQuery(
        parsed.query.where,
        {
          id: r.id,
          content: r.content,
          marker: null,
          priority: null,
          scheduledDay: null,
          deadlineDay: null,
          dueDay: null,
          doneAt: null,
          createdAt: 1,
          updatedAt: 1,
          pageName: "P",
          pageJournalDay: null,
          properties,
        },
        { today: 20260913 },
      );
    })
    .map((r) => r.id);
}

describe("the ref prefilter passes every block extractRefs finds a reference in (B-124)", () => {
  it("keeps blocks whose only reference is an alias:: item or a link in another property", () => {
    block("1", "meeting notes", { related: "[[Foo]]" });
    block("2", "person", { alias: "Foo" });
    block("3", "see [[Foo]]");
    block("4", "saved", { "date-saved": "#Foo" });
    block("5", "unrelated", { note: "plain words" });

    expect(matching("ref:Foo")).toEqual(["1", "2", "3", "4"]);
    // A superset of the JavaScript matches, as the prefilter promises — the property-only ones
    // were dropped before.
    const pre = prefiltered("ref:Foo");
    for (const id of matching("ref:Foo")) expect(pre).toContain(id);
    // And still a filter: a block with no reference syntax anywhere is not a candidate.
    expect(pre).not.toContain("5");
  });
});
