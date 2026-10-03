/**
 * The device's own keyword search (server-search) against a real replica: `WorkerDb` on Node's
 * SQLite, the same substitution `worker-core.test.ts` makes, so the FTS tables and triggers from
 * `../db/schema-client.ts` are the ones the app creates. Only `queryAs`'s worker hop is replaced.
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op, type OpPayload } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDb } from "../db/worker-core.js";
import type { SyncTransport } from "../sync/types.js";

const holder = vi.hoisted(() => ({ db: undefined as WorkerDb | undefined }));
vi.mock("../db/client.js", () => ({
  queryAs: async (sql: string, params: unknown[] = []) => holder.db?.query(sql, params) ?? [],
}));

import { presenceOnDevice, searchLocal } from "./local-search.js";

const transport: SyncTransport = {
  push: async () => ({ accepted: [], rejected: [], corrections: [], server_seq: 0 }),
  pull: async () => ({ ops: [], cursor: 0, has_more: false }),
  snapshot: async () => ({ cursor: 0, pages: [], blocks: [], block_props: [], page_props: [] }),
  connectLive: () => () => {},
};

let db: WorkerDb;
function op(entity: string, payload: OpPayload): Op {
  return makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload);
}
function page(name: string, journalDay: number | null = null): string {
  const id = newId();
  db.applyLocalOps([op(id, { kind: "page.create", name, journalDay, createdAt: Date.now() })]);
  return id;
}
let order = 0;
function block(pageId: string, content: string, parentId: string | null = null): string {
  const id = newId();
  order++;
  db.applyLocalOps([
    op(id, {
      kind: "block.create",
      place: { pageId, parentId, order: `a${String(order).padStart(4, "0")}` },
      content,
      createdAt: Date.now(),
    }),
  ]);
  return id;
}

let aurora: string;
let pricing: string;
let todo: string;

beforeEach(() => {
  db = new WorkerDb({
    driver: createNodeSqliteDriver(new DatabaseSync(":memory:")),
    transport,
  });
  holder.db = db;
  aurora = page("Projects/Aurora");
  const risks = block(aurora, "Open risks");
  pricing = block(aurora, "Vendor pricing not confirmed", risks);
  const notes = page("Poznámky");
  block(notes, "Český jazyk má háčky");
  todo = block(notes, "call the vendor #urgent");
  db.applyLocalOps([op(todo, { kind: "block.prop", key: "marker", value: "TODO" })]);
  const journal = page("2026-10-03", 20261003);
  block(journal, "pricing call in the journal");
});

const found = async (query: string, extra: Record<string, unknown> = {}) =>
  (await searchLocal({ query, ...extra })).hits.map((h) => `${h.kind}:${h.page}`);

describe("searchLocal", () => {
  it("finds a block by a word in it, with its page, breadcrumb and a highlighted snippet", async () => {
    const r = await searchLocal({ query: "pricing", scope: "blocks" });
    expect(r.modeUsed).toBe("keyword");
    const hit = r.hits.find((h) => h.id === pricing);
    expect(hit).toMatchObject({
      kind: "block",
      page: "Projects/Aurora",
      breadcrumb: ["Open risks"],
    });
    expect(hit?.snippet).toContain("**pricing**");
  });

  it("folds diacritics the way the server does: 'cesky' finds 'Český', 'poznamky' the page", async () => {
    expect(await found("cesky")).toEqual(["block:Poznámky"]);
    expect(await found("poznamky", { scope: "pages" })).toEqual(["page:Poznámky"]);
  });

  it("names a journal day by its ISO date, as the server's hits do", async () => {
    const r = await searchLocal({ query: "journal" });
    expect(r.hits[0]).toMatchObject({ page: "2026-10-03", journalDate: "2026-10-03" });
  });

  it("applies the view's filters: namespace, journals only, marker, tag", async () => {
    expect(await found("pricing", { namespace: "Projects" })).toEqual(["block:Projects/Aurora"]);
    expect(await found("pricing", { journalsOnly: true })).toEqual(["block:2026-10-03"]);
    expect(await found("vendor", { properties: { marker: "TODO" } })).toEqual(["block:Poznámky"]);
    expect(await found("vendor", { tags: ["urgent"], scope: "blocks" })).toEqual([
      "block:Poznámky",
    ]);
    // A marker makes a block a task: `Task` is one of its tags, as in the server's `ref` table.
    expect(await found("vendor", { tags: ["task"], scope: "blocks" })).toEqual(["block:Poznámky"]);
  });

  it("takes what people type without a query-language error: punctuation, exclusions, quotes", async () => {
    await expect(searchLocal({ query: 'c++ "unterminated' })).resolves.toBeDefined();
    expect(await found("-pricing")).toEqual([]);
    expect(await found("pricing -journal", { scope: "blocks" })).toEqual(["block:Projects/Aurora"]);
  });

  it("follows edits and deletes: the index is kept by triggers, not rebuilt", async () => {
    db.applyLocalOps([op(pricing, { kind: "block.text", content: "Vendor quote pending" })]);
    expect(await found("quote")).toEqual(["block:Projects/Aurora"]);
    expect(await found("pricing", { namespace: "Projects" })).toEqual([]);
    db.applyLocalOps([op(pricing, { kind: "block.delete", deletedAt: Date.now() })]);
    expect(await found("quote")).toEqual([]);
  });
});

describe("presenceOnDevice", () => {
  it("says which server hits this replica can open, has deleted, or does not have", async () => {
    db.applyLocalOps([op(todo, { kind: "block.delete", deletedAt: Date.now() })]);
    const p = await presenceOnDevice([
      { kind: "block", id: pricing },
      { kind: "block", id: todo },
      { kind: "block", id: "not-synced-yet" },
      { kind: "page", id: aurora },
    ]);
    expect(p.get(`block:${pricing}`)).toBe("live");
    expect(p.get(`block:${todo}`)).toBe("deleted");
    expect(p.has("block:not-synced-yet")).toBe(false);
    expect(p.get(`page:${aurora}`)).toBe("live");
  });
});

describe("the replica's FTS index (schema-client.ts)", () => {
  it("is built from the rows already there when a replica from an older build first opens", async () => {
    const driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
    db = new WorkerDb({ driver, transport });
    holder.db = db;
    const p = page("Older Replica");
    block(p, "written before the index existed");
    // An OPFS file from before server-search: tables all there, no FTS.
    for (const t of ["block_fts", "page_fts"]) driver.exec(`DROP TABLE ${t}`);
    for (const t of ["block_fts_ai", "block_fts_ad", "block_fts_au"])
      driver.exec(`DROP TRIGGER IF EXISTS ${t}`);
    for (const t of ["page_fts_ai", "page_fts_ad", "page_fts_au"])
      driver.exec(`DROP TRIGGER IF EXISTS ${t}`);

    db = new WorkerDb({ driver, transport });
    holder.db = db;
    expect(await found("existed")).toEqual(["block:Older Replica"]);
    expect(await found("older", { scope: "pages" })).toEqual(["page:Older Replica"]);
  });
});
