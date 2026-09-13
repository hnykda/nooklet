/**
 * `runQuery` against a real in-memory SQLite carrying the client's own DDL — the shape of the
 * candidate/property/children queries, page grouping, nested-hit folding, `limit:`, and the
 * candidate cap. The worker boundary is replaced by an injected `sql` runner; `store.ts`'s
 * change bus is mocked away (it is the reactive wrapper's concern, covered end-to-end by
 * `e2e/tests/query.spec.ts`'s "results update when the graph changes").
 */
import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA_STATEMENTS, parseQuery, type Query } from "@nooklet/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ queryAs: vi.fn() }));
vi.mock("./store.js", () => ({
  stampedFor: <T>(value: T) => ({ value, version: 0 }),
}));

import { QUERY_CANDIDATE_CAP, QUERY_CHILD_CAP, runQuery, type SqlRunner } from "./queries.js";

const TODAY = 20260912;

function q(text: string): Query {
  const r = parseQuery(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.query;
}

describe("runQuery", () => {
  const db = new DatabaseSync(":memory:");
  const calls: string[] = [];
  const sql: SqlRunner = async <T>(s: string, params: unknown[] = []) => {
    calls.push(s);
    return db.prepare(s).all(...(params as never[])) as T[];
  };
  let seq = 0;
  const id = (): string => `b${String(++seq).padStart(13, "0")}`;
  const ids: Record<string, string> = {};

  function block(
    key: string,
    page: string,
    parent: string | null,
    content: string,
    opts: { marker?: string; scheduled?: number; props?: Record<string, string> } = {},
  ): void {
    const bid = id();
    ids[key] = bid;
    db.prepare(
      `INSERT INTO block (id, page_id, parent_id, order_key, content, marker, scheduled_day,
         created_at, updated_at, place_hlc, content_hlc)
       VALUES (?,?,?,?,?,?,?,?,?,'h','h')`,
    ).run(bid, page, parent, `a${seq}`, content, opts.marker ?? null, opts.scheduled ?? null, 1, 1);
    for (const [k, v] of Object.entries(opts.props ?? {})) {
      db.prepare("INSERT INTO block_prop (block_id, key, value, hlc) VALUES (?,?,?,'h')").run(
        bid,
        k,
        v,
      );
    }
  }

  beforeAll(() => {
    for (const s of CORE_SCHEMA_STATEMENTS) db.exec(s);
    const page = db.prepare(
      "INSERT INTO page (id, name, key, journal_day, created_at, updated_at, name_hlc) VALUES (?,?,?,?,1,1,'h')",
    );
    page.run("P", "Projects/Aurora", "projects/aurora", null);
    page.run("J", "2026-09-10", "2026-09-10", 20260910);
    page.run("D", "Deleted Page", "deleted page", null);
    db.prepare("UPDATE page SET deleted_at = 1 WHERE id = 'D'").run();

    block("root", "P", null, "Ship it #work", { marker: "TODO" });
    block("sub", "P", ids.root as string, "sub task", { marker: "TODO" });
    block("note", "P", ids.root as string, "a note under the task");
    block("deep", "P", ids.note as string, "deeper note");
    block("done", "P", null, "old thing #work", { marker: "DONE" });
    block("tagged", "P", null, "plain with property", { props: { tags: "work", type: "Book" } });
    block("call", "J", null, "call bob #work", { marker: "TODO", scheduled: TODAY });
    block("gone", "J", null, "deleted #work", { marker: "TODO" });
    db.prepare("UPDATE block SET deleted_at = 1 WHERE id = ?").run(ids.gone as string);
    block("onDeleted", "D", null, "TODO on a deleted page #work", { marker: "TODO" });
  });

  it("matches, groups by page (due first, then journals newest-first), and attaches children", async () => {
    const r = await runQuery(q("TODO tag:work"), { today: TODAY, sql });
    expect(r.matched).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.groups.map((g) => g.pageName)).toEqual(["2026-09-10", "Projects/Aurora"]);
    const aurora = r.groups[1];
    expect(aurora?.hits.map((h) => h.id)).toEqual([ids.root]);
    const root = aurora?.hits[0];
    expect(root?.children.map((c) => c.content)).toEqual(["sub task", "a note under the task"]);
    expect(root?.children[1]?.children.map((c) => c.content)).toEqual(["deeper note"]);
    expect(root?.marker).toBe("TODO");
  });

  it("folds a hit under an ancestor hit instead of listing it twice", async () => {
    const r = await runQuery(q("TODO"), { today: TODAY, sql });
    expect(r.matched).toBe(3); // root, sub, call — never the deleted block or the deleted page
    expect(r.nested).toBe(1);
    const aurora = r.groups.find((g) => g.pageName === "Projects/Aurora");
    expect(aurora?.hits.map((h) => h.id)).toEqual([ids.root]);
    expect(aurora?.hits[0]?.children.map((c) => c.id)).toContain(ids.sub);
  });

  it("finds a tags:: property line, and only fetches properties when the query needs them", async () => {
    calls.length = 0;
    const r = await runQuery(q("tag:work marker:none"), { today: TODAY, sql });
    expect(r.groups.flatMap((g) => g.hits.map((h) => h.id))).toEqual([ids.tagged]);
    expect(calls.filter((s) => s.includes("SELECT bp.block_id, bp.key, bp.value")).length).toBe(1);

    calls.length = 0;
    await runQuery(q("TODO scheduled:today"), { today: TODAY, sql });
    expect(calls.filter((s) => s.includes("SELECT bp.block_id, bp.key, bp.value")).length).toBe(0);
  });

  it("prop:key=value is case-insensitive on the value", async () => {
    const r = await runQuery(q("prop:type=book"), { today: TODAY, sql });
    expect(r.groups.flatMap((g) => g.hits.map((h) => h.id))).toEqual([ids.tagged]);
  });

  it("limit: caps what is shown and says so through the counts", async () => {
    const r = await runQuery(q("tag:work limit:1"), { today: TODAY, sql });
    expect(r.matched).toBe(4); // root, done, tagged, call
    expect(r.shown).toBe(1);
    expect(r.groups.flatMap((g) => g.hits).length).toBe(1);
  });

  it("an empty result is empty, not an error", async () => {
    const r = await runQuery(q("tag:nothing-has-this"), { today: TODAY, sql });
    expect(r).toMatchObject({ matched: 0, shown: 0, groups: [], truncated: false });
  });

  it("reports truncation when the candidate cap is hit", async () => {
    const insert = db.prepare(
      `INSERT INTO block (id, page_id, parent_id, order_key, content, created_at, updated_at, place_hlc, content_hlc)
       VALUES (?,'P',NULL,?,?,1,1,'h','h')`,
    );
    db.exec("BEGIN");
    for (let i = 0; i <= QUERY_CANDIDATE_CAP; i++)
      insert.run(`z${String(i).padStart(13, "0")}`, `z${i}`, "haystack");
    db.exec("COMMIT");
    const r = await runQuery(q("haystack"), { today: TODAY, sql });
    expect(r.truncated).toBe(true);
    expect(r.matched).toBe(QUERY_CANDIDATE_CAP);
  });
});

/**
 * A hit nested under another hit is folded into that hit's rendered subtree — but the subtree is
 * capped at `QUERY_CHILD_CAP` descendants, so a nested hit past the cap used to be counted in the
 * header and rendered nowhere (B-133). A project TODO with many notes and a late TODO subtask is
 * the owner's graph's shape.
 */
describe("runQuery: nested hits past the descendant cap (B-133)", () => {
  interface Row {
    id: string;
    parent: string | null;
    order: string;
    content: string;
    marker?: string;
  }

  /** Page "Proj" with a TODO project block, more plain child notes than the cap, then `extra`. */
  async function projectWith(extra: Row[]): Promise<Awaited<ReturnType<typeof runQuery>>> {
    const db = new DatabaseSync(":memory:");
    for (const s of CORE_SCHEMA_STATEMENTS) db.exec(s);
    db.prepare(
      "INSERT INTO page (id, name, key, journal_day, created_at, updated_at, name_hlc) VALUES ('P','Proj','proj',NULL,1,1,'h')",
    ).run();
    const stmt = db.prepare(
      `INSERT INTO block (id, page_id, parent_id, order_key, content, marker, created_at, updated_at, place_hlc, content_hlc)
       VALUES (?,'P',?,?,?,?,1,1,'h','h')`,
    );
    const rows: Row[] = [
      { id: "root", parent: null, order: "a000", content: "Project", marker: "TODO" },
    ];
    for (let i = 0; i < QUERY_CHILD_CAP + 10; i++) {
      rows.push({
        id: `n${i}`,
        parent: "root",
        order: `b${String(i).padStart(3, "0")}`,
        content: `note ${i}`,
      });
    }
    for (const r of [...rows, ...extra])
      stmt.run(r.id, r.parent, r.order, r.content, r.marker ?? null);
    const sql: SqlRunner = async <T>(s: string, params: unknown[] = []) =>
      db.prepare(s).all(...(params as never[])) as T[];
    return runQuery(q("TODO"), { today: TODAY, sql });
  }

  function renderedIds(r: Awaited<ReturnType<typeof runQuery>>): string[] {
    const out: string[] = [];
    const walk = (b: { id: string; children: Array<{ id: string; children: never[] }> }): void => {
      out.push(b.id);
      for (const c of b.children) walk(c);
    };
    for (const g of r.groups) for (const h of g.hits) walk(h as never);
    return out;
  }

  it("lists a nested hit on its own when its ancestor's rendered subtree was cut before it", async () => {
    const r = await projectWith([
      { id: "late", parent: "root", order: "c000", content: "late subtask", marker: "TODO" },
    ]);
    expect(r.matched).toBe(2);
    const ids = renderedIds(r);
    expect(ids.filter((id) => id === "late")).toHaveLength(1);
    expect(r.groups[0]?.hits.map((h) => h.id)).toEqual(["root", "late"]);
    expect(r.nested).toBe(0);
  });

  it("a cut-off hit brings its own nested hits back with it, each listed once", async () => {
    const r = await projectWith([
      { id: "late", parent: "root", order: "c000", content: "late subtask", marker: "TODO" },
      { id: "under", parent: "late", order: "a000", content: "its subtask", marker: "TODO" },
    ]);
    expect(r.matched).toBe(3);
    const ids = renderedIds(r);
    for (const id of ["root", "late", "under"]) expect(ids.filter((x) => x === id)).toHaveLength(1);
    // "under" fits inside "late"'s rendered subtree, so it stays folded there.
    expect(r.groups[0]?.hits.map((h) => h.id)).toEqual(["root", "late"]);
    expect(r.nested).toBe(1);
  });
});
