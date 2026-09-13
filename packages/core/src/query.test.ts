/**
 * The ```` ```query ```` language (ADR 011 amendment): every construct parses, every malformed
 * form is an error in words, matching agrees with the written semantics, and the SQL prefilter is
 * never narrower than the JavaScript predicate (checked against an in-memory SQLite replica).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  compareForQuery,
  matchQuery,
  parseQuery,
  type Query,
  type QueryBlock,
  type QueryExpr,
  queryNeedsProperties,
  queryPrefilter,
  resolveQueryDate,
} from "./query.js";
import { createNodeSqliteDriver } from "./sync/node-sqlite-driver.js";
import { CORE_SCHEMA_STATEMENTS } from "./sync/schema.js";

const TODAY = 20260912; // a Saturday

function parse(text: string): Query {
  const r = parseQuery(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.error.message}`);
  return r.query;
}

function fail(text: string): string {
  const r = parseQuery(text);
  if (r.ok) throw new Error(`expected "${text}" to fail`);
  return r.error.message;
}

function term(text: string): unknown {
  const q = parse(text);
  expect(q.where.kind).toBe("term");
  return (q.where as Extract<QueryExpr, { kind: "term" }>).term;
}

const utcDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const env = { today: TODAY, epochToDay: utcDay };

let seq = 0;
function block(over: Partial<QueryBlock> = {}): QueryBlock {
  seq++;
  return {
    id: `blk${String(seq).padStart(11, "0")}`,
    content: "",
    marker: null,
    priority: null,
    scheduledDay: null,
    deadlineDay: null,
    dueDay: over.scheduledDay ?? over.deadlineDay ?? null,
    doneAt: null,
    createdAt: Date.UTC(2026, 8, 1),
    updatedAt: Date.UTC(2026, 8, 1),
    pageName: "Some Page",
    pageJournalDay: null,
    properties: {},
    ...over,
  };
}

function matches(text: string, b: QueryBlock): boolean {
  return matchQuery(parse(text).where, b, env);
}

describe("parseQuery — terms", () => {
  it("bare uppercase marker words are marker terms; lowercase words are text", () => {
    expect(term("TODO")).toEqual({ kind: "marker", values: ["TODO"], mode: "list" });
    expect(term("WAIT")).toEqual({ kind: "marker", values: ["WAITING"], mode: "list" });
    expect(term("done")).toEqual({ kind: "text", value: "done" });
    expect(term("Todo")).toEqual({ kind: "text", value: "Todo" });
  });

  it("marker: lists, open/closed, any/none, aliases, case", () => {
    expect(term("marker:TODO,doing")).toEqual({
      kind: "marker",
      values: ["TODO", "DOING"],
      mode: "list",
    });
    expect(term("marker:open")).toEqual({
      kind: "marker",
      values: ["TODO", "DOING", "LATER", "NOW", "WAITING"],
      mode: "list",
    });
    expect(term("task:closed")).toEqual({
      kind: "marker",
      values: ["DONE", "CANCELED"],
      mode: "list",
    });
    expect(term("marker:cancelled")).toEqual({
      kind: "marker",
      values: ["CANCELED"],
      mode: "list",
    });
    expect(term("marker:any")).toEqual({ kind: "marker", values: [], mode: "any" });
    expect(term("marker:none")).toEqual({ kind: "marker", values: [], mode: "none" });
    expect(fail("marker:")).toMatch(/expected a task state/);
    expect(fail("marker:URGENT")).toMatch(/not a task state/);
  });

  it("priority:", () => {
    expect(term("priority:a,B")).toEqual({ kind: "priority", values: ["A", "B"], mode: "list" });
    expect(term("prio:none")).toEqual({ kind: "priority", values: [], mode: "none" });
    expect(fail("priority:D")).toMatch(/not a priority/);
    expect(fail("priority:")).toMatch(/expected A, B or C/);
  });

  it("references: tag:, ref:, bare #tag, #[[multi word]], [[Page]], with syntax stripped", () => {
    expect(term("tag:work")).toEqual({ kind: "ref", name: "work" });
    expect(term("tag:#work")).toEqual({ kind: "ref", name: "work" });
    expect(term("ref:[[Project X]]")).toEqual({ kind: "ref", name: "Project X" });
    expect(term('tag:"two words"')).toEqual({ kind: "ref", name: "two words" });
    expect(term("#work")).toEqual({ kind: "ref", name: "work" });
    expect(term("#[[two words]]")).toEqual({ kind: "ref", name: "two words" });
    expect(term("[[Project X]]")).toEqual({ kind: "ref", name: "Project X" });
    expect(term("#práce")).toEqual({ kind: "ref", name: "práce" });
    expect(fail("tag:")).toMatch(/expected a tag or page name/);
    expect(fail("#")).toMatch(/empty reference/);
    expect(fail("[[unterminated")).toMatch(/unterminated \[\[/);
  });

  it("page:, namespace:, journal:", () => {
    expect(term("page:[[My Page]]")).toEqual({ kind: "page", name: "My Page" });
    expect(term('page:"My Page"')).toEqual({ kind: "page", name: "My Page" });
    expect(term("namespace:Projects")).toEqual({ kind: "namespace", name: "Projects" });
    expect(term("ns:Projects")).toEqual({ kind: "namespace", name: "Projects" });
    expect(term("journal:true")).toEqual({ kind: "journal", value: true });
    expect(term("journal:no")).toEqual({ kind: "journal", value: false });
    expect(term("journal:>=-7d")).toEqual({
      kind: "date",
      field: "journal",
      cmp: { op: "ge", value: { kind: "rel", n: -7, unit: "d" } },
    });
    expect(fail("page:")).toMatch(/expected a page name/);
  });

  it("date fields: operators, ranges, relative and absolute values, any/none", () => {
    expect(term("scheduled:today")).toEqual({
      kind: "date",
      field: "scheduled",
      cmp: { op: "eq", value: { kind: "rel", n: 0, unit: "d" } },
    });
    expect(term("deadline:<=tomorrow")).toEqual({
      kind: "date",
      field: "deadline",
      cmp: { op: "le", value: { kind: "rel", n: 1, unit: "d" } },
    });
    expect(term("due:<yesterday")).toEqual({
      kind: "date",
      field: "due",
      cmp: { op: "lt", value: { kind: "rel", n: -1, unit: "d" } },
    });
    expect(term("done:>=-1w")).toEqual({
      kind: "date",
      field: "done",
      cmp: { op: "ge", value: { kind: "rel", n: -1, unit: "w" } },
    });
    expect(term("created:>2026-09-01")).toEqual({
      kind: "date",
      field: "created",
      cmp: { op: "gt", value: { kind: "abs", day: 20260901 } },
    });
    expect(term("updated:=today")).toMatchObject({ cmp: { op: "eq" } });
    expect(term("scheduled:today..+7d")).toEqual({
      kind: "date",
      field: "scheduled",
      cmp: {
        op: "between",
        from: { kind: "rel", n: 0, unit: "d" },
        to: { kind: "rel", n: 7, unit: "d" },
      },
    });
    expect(term("scheduled:+1m")).toMatchObject({ cmp: { value: { unit: "m", n: 1 } } });
    expect(term("scheduled:-2y")).toMatchObject({ cmp: { value: { unit: "y", n: -2 } } });
    expect(term("scheduled:none")).toEqual({
      kind: "date",
      field: "scheduled",
      cmp: { op: "none" },
    });
    expect(term("deadline:any")).toEqual({ kind: "date", field: "deadline", cmp: { op: "any" } });
    expect(fail("scheduled:")).toMatch(/expected a date/);
    expect(fail("scheduled:soon")).toMatch(/not a date/);
    expect(fail("scheduled:2026-02-30")).toMatch(/not a real date/);
    expect(fail("scheduled:today..+1d..+2d")).toMatch(/more than one/);
    expect(fail("scheduled:>=")).toMatch(/not a date/);
  });

  it("text: bare words, quoted phrases, text:", () => {
    expect(term("meeting")).toEqual({ kind: "text", value: "meeting" });
    expect(term('"weekly meeting"')).toEqual({ kind: "text", value: "weekly meeting" });
    expect(term('text:"a b"')).toEqual({ kind: "text", value: "a b" });
    expect(term("content:x")).toEqual({ kind: "text", value: "x" });
    expect(term('"and"')).toEqual({ kind: "text", value: "and" });
    expect(term('"say \\"hi\\""')).toEqual({ kind: "text", value: 'say "hi"' });
    expect(fail('"unterminated')).toMatch(/unterminated "/);
    expect(fail('""')).toMatch(/empty quoted text/);
    expect(fail("text:")).toMatch(/expected text/);
  });

  it("prop: key, key=value, quoted values, key normalisation", () => {
    expect(term("prop:type")).toEqual({ kind: "prop", key: "type" });
    expect(term("prop:type=book")).toEqual({ kind: "prop", key: "type", value: "book" });
    expect(term('prop:type="science fiction"')).toEqual({
      kind: "prop",
      key: "type",
      value: "science fiction",
    });
    expect(term("property:Read_Status=done")).toEqual({
      kind: "prop",
      key: "read-status",
      value: "done",
    });
    expect(fail("prop:")).toMatch(/expected a property key/);
    expect(fail("prop:=x")).toMatch(/expected a property key before =/);
  });

  it("sort: and limit: are modifiers, not filters", () => {
    expect(parse("TODO sort:deadline")).toMatchObject({ sort: { field: "deadline", dir: "asc" } });
    expect(parse("TODO sort:-due")).toMatchObject({ sort: { field: "due", dir: "desc" } });
    expect(parse("TODO sort:updated:desc")).toMatchObject({
      sort: { field: "updated", dir: "desc" },
    });
    expect(parse("sort:page TODO limit:5")).toMatchObject({
      sort: { field: "page", dir: "asc" },
      limit: 5,
      where: { kind: "term" },
    });
    expect(parse("TODO").sort).toEqual({ field: "due", dir: "asc" });
    expect(parse("TODO").limit).toBeNull();
    expect(fail("TODO sort:colour")).toMatch(/cannot sort by "colour"/);
    expect(fail("TODO limit:0")).toMatch(/positive whole number/);
    expect(fail("TODO limit:many")).toMatch(/positive whole number/);
    expect(fail("sort:due")).toMatch(/empty query/);
  });

  it("unknown keys and empty input are errors with a position", () => {
    expect(fail("colour:red")).toMatch(/unknown filter "colour:"/);
    expect(fail("")).toMatch(/empty query/);
    expect(fail("   \n  ")).toMatch(/empty query/);
    const r = parseQuery("TODO colour:red");
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.error.start, r.error.end]).toEqual([5, 15]);
  });
});

describe("parseQuery — boolean structure", () => {
  it("juxtaposition is and; or binds loosest; not binds tightest; parens group", () => {
    expect(parse("TODO tag:a").where).toMatchObject({ kind: "and" });
    expect(parse("TODO and tag:a").where).toMatchObject({ kind: "and" });
    expect(parse("TODO tag:a or DOING").where).toMatchObject({
      kind: "or",
      items: [{ kind: "and" }, { kind: "term" }],
    });
    expect(parse("not TODO tag:a").where).toMatchObject({
      kind: "and",
      items: [{ kind: "not", item: { kind: "term" } }, { kind: "term" }],
    });
    expect(parse("-tag:a").where).toMatchObject({ kind: "not" });
    expect(parse("-(TODO or DOING)").where).toMatchObject({ kind: "not", item: { kind: "or" } });
    expect(parse("(TODO or DOING) tag:a").where).toMatchObject({
      kind: "and",
      items: [{ kind: "or" }, { kind: "term" }],
    });
    expect(parse("NOT TODO OR DOING AND LATER").where).toMatchObject({
      kind: "or",
      items: [{ kind: "not" }, { kind: "and" }],
    });
  });

  it("modifiers may sit between filters without breaking juxtaposition", () => {
    expect(parse("TODO sort:due tag:a").where).toMatchObject({ kind: "and", items: [{}, {}] });
  });

  it("malformed structure is reported in words", () => {
    expect(fail("(TODO")).toMatch(/missing closing \)/);
    expect(fail("TODO)")).toMatch(/unexpected \)/);
    expect(fail("()")).toMatch(/empty parentheses/);
    expect(fail("or TODO")).toMatch(/"or" needs a filter before it/);
    expect(fail("TODO or")).toMatch(/"or" needs a filter after it/);
    expect(fail("TODO or or DOING")).toMatch(/needs a filter/);
    expect(fail("and TODO")).toMatch(/"and" needs a filter before it/);
    expect(fail("TODO and")).toMatch(/"and" needs a filter after it/);
    expect(fail("not")).toMatch(/"not" needs a filter after it/);
    expect(fail("TODO -")).toMatch(/needs a filter|not a date|unknown/);
  });

  it("never throws on arbitrary input", () => {
    const junk = [
      '"',
      "((",
      "))",
      ":::",
      "a:b:c",
      "-",
      "--",
      "#[[",
      "[[]]",
      "not not",
      "sort:",
      " ",
    ];
    for (const j of junk) expect(() => parseQuery(j)).not.toThrow();
  });

  it("refuses a query nested too deeply or with too many filters, in words, without throwing (B-129)", () => {
    // Query fences are block content: any writer, an MCP agent included, can sync one of these to
    // every device. 20k parentheses or 30k `not`s used to overflow the parser's stack.
    expect(fail(`${"(".repeat(20_000)}TODO${")".repeat(20_000)}`)).toMatch(/nested too deeply/);
    expect(fail(`${"not ".repeat(30_000)}TODO`)).toMatch(/nested too deeply/);
    expect(fail(`${"-".repeat(33)}TODO`)).toMatch(/nested too deeply/);
    expect(fail(Array.from({ length: 40_000 }, (_, i) => `w${i}`).join(" "))).toMatch(
      /too many filters/,
    );
    expect(fail(Array.from({ length: 101 }, () => "TODO").join(" or "))).toMatch(
      /too many filters/,
    );
    // At the limits it still parses.
    expect(parseQuery(`${"not ".repeat(32)}TODO`).ok).toBe(true);
    expect(parseQuery(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")).ok).toBe(true);
  });
});

describe("resolveQueryDate", () => {
  it("resolves relative units against today", () => {
    expect(resolveQueryDate({ kind: "rel", n: 0, unit: "d" }, TODAY)).toBe(20260912);
    expect(resolveQueryDate({ kind: "rel", n: 1, unit: "d" }, TODAY)).toBe(20260913);
    expect(resolveQueryDate({ kind: "rel", n: -12, unit: "d" }, TODAY)).toBe(20260831);
    expect(resolveQueryDate({ kind: "rel", n: 1, unit: "w" }, TODAY)).toBe(20260919);
    expect(resolveQueryDate({ kind: "rel", n: -1, unit: "m" }, TODAY)).toBe(20260812);
    expect(resolveQueryDate({ kind: "rel", n: 1, unit: "y" }, TODAY)).toBe(20270912);
    expect(resolveQueryDate({ kind: "abs", day: 20240229 }, TODAY)).toBe(20240229);
  });
});

describe("matchQuery", () => {
  it("marker and priority", () => {
    expect(matches("TODO", block({ marker: "TODO" }))).toBe(true);
    expect(matches("TODO", block({ marker: "DONE" }))).toBe(false);
    expect(matches("marker:open", block({ marker: "WAITING" }))).toBe(true);
    expect(matches("marker:any", block({ marker: null }))).toBe(false);
    expect(matches("marker:none", block({ marker: null }))).toBe(true);
    expect(matches("priority:A,B", block({ priority: "B" }))).toBe(true);
    expect(matches("priority:A", block({ priority: null }))).toBe(false);
    expect(matches("priority:none", block({ priority: null }))).toBe(true);
  });

  it("references: #tag, #[[tag]], [[link]], [label]([[link]]), tags:: — case-insensitively", () => {
    expect(matches("tag:work", block({ content: "call bob #work" }))).toBe(true);
    expect(matches("tag:Work", block({ content: "call bob #work" }))).toBe(true);
    expect(matches("#work", block({ content: "see [[Work]] later" }))).toBe(true);
    expect(matches("[[two words]]", block({ content: "x #[[Two Words]]" }))).toBe(true);
    expect(matches("tag:work", block({ content: "[label]([[work]])" }))).toBe(true);
    expect(matches("tag:work", block({ content: "x", properties: { tags: "home, work" } }))).toBe(
      true,
    );
    expect(
      matches("tag:work", block({ content: "x", properties: { tags: "[[work]], home" } })),
    ).toBe(true);
    expect(matches("tag:work", block({ content: "workshop #working" }))).toBe(false);
    expect(matches("tag:work", block({ content: "`#work` in code" }))).toBe(false);
    expect(matches("tag:práce", block({ content: "úkol #Práce" }))).toBe(true);
  });

  // B-263: the server's `ref` table gives every marked block a derived `Task` tag
  // (`refs.ts#TASK_TAG`), so `[[Task]]` lists them all — and the query language must agree.
  it("a task marker is a reference to Task, with no #Task in the text", () => {
    expect(matches("tag:task", block({ content: "camp ČS", marker: "DONE" }))).toBe(true);
    expect(matches("#Task", block({ content: "x", marker: "LATER" }))).toBe(true);
    expect(matches("[[task]]", block({ content: "x", marker: "WAITING" }))).toBe(true);
    expect(matches("tag:task", block({ content: "no marker" }))).toBe(false);
    expect(matches("#task and (NOW or WAITING)", block({ content: "x", marker: "NOW" }))).toBe(
      true,
    );
    expect(matches("marker:open not #task", block({ content: "x", marker: "NOW" }))).toBe(false);
    // Only `Task` is derived: a marker is not a reference to any other page.
    expect(matches("tag:todo", block({ content: "x", marker: "TODO" }))).toBe(false);
  });

  it("page, namespace, journal", () => {
    const b = block({ pageName: "Projects/Aurora", pageJournalDay: null });
    expect(matches("page:[[projects/aurora]]", b)).toBe(true);
    expect(matches("page:Projects", b)).toBe(false);
    expect(matches("namespace:projects", b)).toBe(true);
    expect(matches("namespace:proj", b)).toBe(false);
    expect(matches("journal:false", b)).toBe(true);
    const j = block({ pageName: "2026-09-10", pageJournalDay: 20260910 });
    expect(matches("journal:true", j)).toBe(true);
    expect(matches("journal:>=-7d", j)).toBe(true);
    expect(matches("journal:<-7d", j)).toBe(false);
    expect(matches("journal:>=-7d", b)).toBe(false);
  });

  it("date windows on scheduled/deadline/due", () => {
    const t = block({ marker: "TODO", scheduledDay: 20260912 });
    expect(matches("scheduled:today", t)).toBe(true);
    expect(matches("scheduled:<=today", t)).toBe(true);
    expect(matches("scheduled:<today", t)).toBe(false);
    expect(matches("scheduled:>yesterday", t)).toBe(true);
    expect(matches("scheduled:today..+7d", t)).toBe(true);
    expect(matches("scheduled:+7d..today", t)).toBe(true);
    expect(matches("scheduled:+1d..+7d", t)).toBe(false);
    expect(matches("scheduled:any", t)).toBe(true);
    expect(matches("scheduled:none", t)).toBe(false);
    expect(matches("deadline:none", t)).toBe(true);
    expect(matches("deadline:<=today", t)).toBe(false);
    expect(matches("due:<=today", t)).toBe(true);
    const d = block({ marker: "TODO", deadlineDay: 20260901 });
    expect(matches("due:<today", d)).toBe(true);
  });

  it("done/created/updated map epoch ms through the env's day function", () => {
    const b = block({ marker: "DONE", doneAt: Date.UTC(2026, 8, 11, 23, 30) });
    expect(matches("done:>=-7d", b)).toBe(true);
    expect(matches("done:today", b)).toBe(false);
    expect(matches("done:yesterday", b)).toBe(true);
    expect(matches("done:none", block({ marker: "TODO" }))).toBe(true);
    expect(matches("created:2026-09-01", block())).toBe(true);
    expect(matches("updated:>2026-09-01", block())).toBe(false);
  });

  it("text is a case-insensitive substring; prop matches key and value", () => {
    expect(matches("meeting", block({ content: "Weekly MEETING notes" }))).toBe(true);
    expect(matches('"weekly meeting"', block({ content: "Weekly MEETING notes" }))).toBe(true);
    expect(matches("meetings", block({ content: "Weekly MEETING notes" }))).toBe(false);
    expect(matches("řeka", block({ content: "Řeka Vltava" }))).toBe(true);
    expect(matches("prop:type", block({ properties: { type: "book" } }))).toBe(true);
    expect(matches("prop:type=Book", block({ properties: { type: "book" } }))).toBe(true);
    expect(matches("prop:type=film", block({ properties: { type: "book" } }))).toBe(false);
    expect(matches("prop:type", block())).toBe(false);
  });

  it("boolean combinations", () => {
    const b = block({ marker: "TODO", content: "x #work" });
    expect(matches("TODO tag:work", b)).toBe(true);
    expect(matches("TODO tag:home", b)).toBe(false);
    expect(matches("TODO tag:home or tag:work", b)).toBe(true);
    expect(matches("(TODO or DONE) not tag:home", b)).toBe(true);
    expect(matches("-tag:work", b)).toBe(false);
    expect(matches("not (TODO tag:work)", b)).toBe(false);
  });
});

describe("compareForQuery", () => {
  const a = block({ pageName: "Alpha", scheduledDay: 20260920, priority: "B" });
  const b = block({ pageName: "Beta", scheduledDay: 20260915, priority: "A" });
  const j = block({ pageName: "2026-09-01", pageJournalDay: 20260901 });
  const j2 = block({ pageName: "2026-09-05", pageJournalDay: 20260905, scheduledDay: 20260915 });

  it("sorts by the field with nulls last, then journals newest-first, then pages A→Z", () => {
    const ids = (xs: QueryBlock[], q: string) =>
      [...xs].sort(compareForQuery(parse(q).sort, env)).map((x) => x.pageName);
    expect(ids([a, b, j, j2], "x")).toEqual(["2026-09-05", "Beta", "Alpha", "2026-09-01"]);
    expect(ids([a, b, j, j2], "x sort:-due")).toEqual([
      "Alpha",
      "2026-09-05",
      "Beta",
      "2026-09-01",
    ]);
    expect(ids([a, b, j, j2], "x sort:page")).toEqual([
      "2026-09-05",
      "2026-09-01",
      "Alpha",
      "Beta",
    ]);
    expect(ids([a, b, j], "x sort:priority")).toEqual(["Beta", "Alpha", "2026-09-01"]);
  });

  it("uses the caller's tiebreak within one page", () => {
    const x = block({ pageName: "P" });
    const y = block({ pageName: "P" });
    const cmp = compareForQuery(parse("x").sort, env, (p, q) => (p.id > q.id ? -1 : 1));
    expect([x, y].sort(cmp).map((z) => z.id)).toEqual([y.id, x.id]);
  });
});

describe("queryNeedsProperties", () => {
  it("is true only when a ref or prop term is reachable", () => {
    expect(queryNeedsProperties(parse("TODO scheduled:today").where)).toBe(false);
    expect(queryNeedsProperties(parse("TODO tag:x").where)).toBe(true);
    expect(queryNeedsProperties(parse("not (TODO or prop:a)").where)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The SQL prefilter must accept a superset of what `matchQuery` accepts — checked against a real
// in-memory SQLite with the client's own DDL, for every query in the list, over a fixture that
// exercises every column and a few traps (a `#` inside code, a tags:: line, a Czech tag).
// ---------------------------------------------------------------------------------------------

interface Row {
  page: { id: string; name: string; journal: number | null };
  b: Partial<QueryBlock> & { content: string; props?: Record<string, string> };
}

describe("queryPrefilter is a sound over-approximation of matchQuery", () => {
  const db = new DatabaseSync(":memory:");
  for (const stmt of CORE_SCHEMA_STATEMENTS) db.exec(stmt);
  const driver = createNodeSqliteDriver(db);

  const pages = [
    { id: "p1", name: "Projects/Aurora", journal: null },
    { id: "p2", name: "2026-09-10", journal: 20260910 },
    { id: "p3", name: "Reading", journal: null },
  ];
  for (const p of pages) {
    driver.run(
      "INSERT INTO page (id, name, key, journal_day, created_at, updated_at, name_hlc) VALUES (?,?,?,?,?,?,?)",
      [p.id, p.name, p.name.toLowerCase(), p.journal, 1, 1, "h"],
    );
  }
  const rows: Row[] = [
    {
      page: pages[0] as Row["page"],
      b: { content: "TODO one #work", marker: "TODO", scheduledDay: 20260912 },
    },
    {
      page: pages[0] as Row["page"],
      b: { content: "two [[Work]]", marker: "DOING", deadlineDay: 20260901 },
    },
    { page: pages[1] as Row["page"], b: { content: "`#work` in code only", marker: "TODO" } },
    {
      page: pages[1] as Row["page"],
      b: { content: "done thing", marker: "DONE", doneAt: Date.UTC(2026, 8, 11) },
    },
    {
      page: pages[2] as Row["page"],
      b: { content: "plain", props: { tags: "work", type: "Book" } },
    },
    { page: pages[2] as Row["page"], b: { content: "Řeka #práce", priority: "A" } },
    {
      page: pages[2] as Row["page"],
      b: { content: "meeting notes", marker: "LATER", priority: "C" },
    },
  ];
  const all: QueryBlock[] = [];
  rows.forEach((r, i) => {
    const id = `b${String(i).padStart(13, "0")}`;
    const b = r.b;
    driver.run(
      `INSERT INTO block (id, page_id, parent_id, order_key, content, marker, priority, scheduled_day,
         deadline_day, done_at, created_at, updated_at, place_hlc, content_hlc)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,'h','h')`,
      [
        id,
        r.page.id,
        `a${i}`,
        b.content,
        b.marker ?? null,
        b.priority ?? null,
        b.scheduledDay ?? null,
        b.deadlineDay ?? null,
        b.doneAt ?? null,
        Date.UTC(2026, 8, 1),
        Date.UTC(2026, 8, 1),
      ],
    );
    for (const [k, v] of Object.entries(b.props ?? {})) {
      driver.run("INSERT INTO block_prop (block_id, key, value, hlc) VALUES (?,?,?,?)", [
        id,
        k,
        v,
        "h",
      ]);
    }
    all.push(
      block({
        id,
        content: b.content,
        marker: b.marker ?? null,
        priority: b.priority ?? null,
        scheduledDay: b.scheduledDay ?? null,
        deadlineDay: b.deadlineDay ?? null,
        dueDay: b.scheduledDay ?? b.deadlineDay ?? null,
        doneAt: b.doneAt ?? null,
        pageName: r.page.name,
        pageJournalDay: r.page.journal,
        properties: b.props ?? {},
      }),
    );
  });

  const QUERIES = [
    "TODO",
    "marker:open",
    "marker:none",
    "priority:A,C",
    "priority:none",
    "tag:work",
    "#práce",
    "not tag:work",
    "page:[[Projects/Aurora]]",
    "namespace:projects",
    "not namespace:projects",
    "journal:true",
    "journal:>=-7d",
    "scheduled:today",
    "scheduled:none",
    "deadline:<today",
    "due:today..+7d",
    "done:>=-7d",
    "done:none",
    "created:2026-09-01",
    "meeting",
    "řeka",
    "prop:type",
    "prop:type=book",
    "prop:type=film",
    "TODO tag:work or DONE",
    "(TODO or LATER) not tag:work",
    "tag:task",
    "#task and (NOW or WAITING)",
    "marker:open not #task",
    "not [[Task]]",
    "-(tag:work or prop:type)",
    "not (TODO and scheduled:today)",
  ];

  for (const q of QUERIES) {
    it(`"${q}"`, () => {
      const query = parse(q);
      const pre = queryPrefilter(query.where, env);
      const sqlRows = driver.all<{ id: string }>(
        `SELECT b.id FROM block b JOIN page p ON p.id = b.page_id WHERE ${pre.sql}`,
        pre.params,
      );
      const sqlIds = new Set(sqlRows.map((r) => r.id));
      const jsIds = new Set(all.filter((b) => matchQuery(query.where, b, env)).map((b) => b.id));
      for (const id of jsIds)
        expect(sqlIds, `SQL prefilter dropped ${id} for "${q}"`).toContain(id);
      if (pre.exact) expect([...sqlIds].sort()).toEqual([...jsIds].sort());
    });
  }

  it("the largest query the parser accepts compiles to SQL that SQLite accepts (B-129)", () => {
    // 1,001 `not`s or ~1,000 words used to reach SQLite's "Expression tree is too large (maximum
    // depth 1000)". The parser's limits keep every accepted query well inside it.
    const widest = Array.from({ length: 50 }, (_, i) => `(scheduled:today or w${i})`).join(" ");
    const deepest = `${"not (".repeat(8)}${"not ".repeat(16)}TODO${")".repeat(8)}`;
    const nested = `${"(".repeat(31)}${Array.from({ length: 99 }, (_, i) => `prop:k${i}`).join(" ")} TODO${")".repeat(31)}`;
    for (const text of [widest, deepest, nested]) {
      const r = parseQuery(text);
      expect(r.ok, text.slice(0, 40)).toBe(true);
      if (!r.ok) continue;
      const pre = queryPrefilter(r.query.where, env);
      expect(() =>
        driver.all(
          `SELECT b.id FROM block b JOIN page p ON p.id = b.page_id WHERE ${pre.sql}`,
          pre.params,
        ),
      ).not.toThrow();
    }
  });

  it("marks pure column queries exact and text/ref/prop-value queries inexact", () => {
    expect(queryPrefilter(parse("TODO scheduled:today page:x").where, env).exact).toBe(true);
    expect(queryPrefilter(parse("TODO tag:x").where, env).exact).toBe(false);
    expect(queryPrefilter(parse("prop:type").where, env).exact).toBe(true);
    expect(queryPrefilter(parse("prop:type=book").where, env).exact).toBe(false);
    expect(queryPrefilter(parse("not tag:x").where, env)).toMatchObject({ sql: "1", exact: false });
  });
});
