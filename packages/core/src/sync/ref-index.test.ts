/**
 * The reference index in core (B-641): `rebuildRefIndex` (the in-memory pass a client replica
 * migrates with) must produce exactly the rows the per-write `reindexRefs` path does, and the
 * `samePlace` shortcut must never change the outcome — only skip work.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "../hlc.js";
import { newId } from "../ids.js";
import { makeOp, type Op, type OpPayload } from "../ops.js";
import { applyOps } from "./apply-ops.js";
import { backlinkRows, resolveBacklinksTarget } from "./backlinks.js";
import type { SqlDriver } from "./driver.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";
import { REF_INDEX_STATEMENTS, rebuildRefIndex, reindexRefs } from "./ref-index.js";
import { initSchema } from "./schema.js";

const DEV = "aaaaaaaa";
const BASE = Date.UTC(2026, 9, 1, 12, 0, 0);
let tick = 0;
let driver: SqlDriver;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  driver = createNodeSqliteDriver(db);
  initSchema(driver);
  for (const stmt of REF_INDEX_STATEMENTS) driver.exec(stmt);
  // Unlinked mentions read the FTS index; the same external-content table the hosts create.
  driver.exec(
    "CREATE VIRTUAL TABLE block_fts USING fts5(content, content='block', content_rowid='rowid')",
  );
});

/** Apply one batch and re-derive the index for what it touched, the way `serverApplyOps` does. */
function write(...payloads: Array<[string, OpPayload]>): void {
  const ops: Op[] = payloads.map(([entity, payload]) =>
    makeOp(formatHlc({ wall: BASE + tick, counter: tick++, device: DEV }), DEV, entity, payload),
  );
  applyOps(driver, ops);
  const blocks = ops.filter((o) => o.payload.kind.startsWith("block.")).map((o) => o.entity);
  const pages = ops.filter((o) => o.payload.kind.startsWith("page.")).map((o) => o.entity);
  reindexRefs(driver, blocks, pages);
}

function page(name: string, journalDay: number | null = null): string {
  const id = newId();
  write([id, { kind: "page.create", name, journalDay, createdAt: BASE }]);
  return id;
}

function block(
  pageId: string,
  content: string,
  parentId: string | null = null,
  id: string = newId(),
): string {
  write([
    id,
    {
      kind: "block.create",
      place: { pageId, parentId, order: `a${tick}` },
      content,
      createdAt: BASE + tick,
    },
  ]);
  return id;
}

function snapshot(): Record<string, string[]> {
  const q = (sql: string) =>
    driver
      .all<Record<string, unknown>>(sql)
      .map((r) => JSON.stringify(Object.values(r)))
      .sort();
  return {
    ref: q(
      "SELECT src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id FROM ref",
    ),
    path_ref: q("SELECT block_id, page_key, page_id FROM path_ref"),
    page_tag: q("SELECT page_id, tag_key, tag_page_id, source FROM page_tag"),
    page_alias: q("SELECT page_id, alias_key FROM page_alias"),
  };
}

/** A small graph with every kind of reference the index knows. */
function buildGraph(): { target: string; real: string; parent: string; child: string } {
  const target = page("Target");
  const real = page("Real");
  write([real, { kind: "page.prop", key: "alias", value: "Nick" }]);
  const person = page("Alice");
  write([person, { kind: "page.prop", key: "tags", value: "person, [[Target]]" }]);
  const day = page("2026-10-01", 20261001);
  const other = page("Other");
  const parent = block(other, "about [[Target]] and #topic");
  const child = block(other, "child, only inherits", parent);
  block(other, "grandchild ((not-a-block))", child);
  // The marker is a column, not text: it is what makes the block a `Task`.
  const task = block(day, "TODO call [[Nick]] about Target");
  write([task, { kind: "block.prop", key: "marker", value: "TODO" }]);
  const lone = block(day, "mentions Target without a link");
  write([lone, { kind: "block.prop", key: "ref", value: "[[Real]]" }]);
  block(other, "links [[Not Yet Created]]");
  // `((…))` takes a uuid, the shape Logseq block ids have.
  const refd = block(target, "a block someone points at", null, crypto.randomUUID());
  block(other, `see ((${refd}))`);
  const gone = block(other, "deleted [[Target]]");
  write([gone, { kind: "block.delete", deletedAt: BASE }]);
  driver.exec("INSERT INTO block_fts(block_fts) VALUES('rebuild')");
  return { target, real, parent, child };
}

describe("rebuildRefIndex", () => {
  it("produces exactly the rows the per-write path does", () => {
    buildGraph();
    const incremental = snapshot();
    expect(incremental.ref?.length).toBeGreaterThan(5);
    rebuildRefIndex(driver);
    expect(snapshot()).toEqual(incremental);
  });

  it("matches after a move and an alias change too", () => {
    const { child } = buildGraph();
    const elsewhere = page("Elsewhere");
    write([
      child,
      { kind: "block.place", place: { pageId: elsewhere, parentId: null, order: "z" } },
    ]);
    const real = driver.get<{ id: string }>("SELECT id FROM page WHERE name = 'Real'")?.id ?? "";
    write([real, { kind: "page.prop", key: "alias", value: "Nick, Nicky" }]);
    const incremental = snapshot();
    rebuildRefIndex(driver);
    expect(snapshot()).toEqual(incremental);
  });

  it("differs after a rename only where the per-write path is stale (logged, b641 progress)", () => {
    // A rename re-resolves every reference TO the page, but the renamed page's own blocks keep
    // `path_ref` rows under its old key: the per-write path (the server's too) never revisits
    // them. A rebuild writes the new key. Pinned here so the difference is known, not discovered.
    const { target } = buildGraph();
    write([target, { kind: "page.rename", name: "Target Renamed" }]);
    const own = (key: string) =>
      driver.all(
        "SELECT 1 FROM path_ref pr JOIN block b ON b.id = pr.block_id WHERE b.page_id = ? AND pr.page_key = ?",
        [target, key],
      ).length;
    expect(own("target")).toBe(1);
    expect(own("target renamed")).toBe(0);
    rebuildRefIndex(driver);
    expect(own("target")).toBe(0);
    expect(own("target renamed")).toBe(1);
  });
});

describe("reindexRefs' samePlace shortcut", () => {
  it("skips nothing that matters: an edit that adds or drops a link still reaches the subtree", () => {
    const { parent, child } = buildGraph();
    const edit = (content: string) => {
      applyOps(driver, [
        makeOp(formatHlc({ wall: BASE + tick, counter: tick++, device: DEV }), DEV, parent, {
          kind: "block.text",
          content,
        }),
      ]);
      reindexRefs(driver, [parent], [], { samePlace: new Set([parent]) });
    };
    const has = (blockId: string, key: string) =>
      driver.get("SELECT 1 FROM path_ref WHERE block_id = ? AND page_key = ?", [blockId, key]) !==
      undefined;

    edit("about [[Target]] and #topic, more words"); // same links: shortcut taken
    expect(has(child, "target")).toBe(true);
    edit("now about [[Fresh]] only"); // links changed: the subtree is re-walked
    expect(has(child, "target")).toBe(false);
    expect(has(child, "fresh")).toBe(true);

    const incremental = snapshot();
    rebuildRefIndex(driver);
    expect(snapshot()).toEqual(incremental);
  });
});

describe("backlinkRows over the index", () => {
  it("lists linked references with Logseq's direct count, aliases, mentions and tagged pages", () => {
    buildGraph();
    const answer = backlinkRows(driver, resolveBacklinksTarget(driver, "target"), {
      includeUnlinked: true,
      unlinkedLimit: 50,
    });
    // A `((block ref))` into the page is a reference to the page too.
    const texts = answer.linked.map((r) => r.content.replace(/\(\([0-9a-f-]{36}\)\)/, "((uuid))"));
    expect(texts.sort()).toEqual([
      "about [[Target]] and #topic",
      "child, only inherits",
      "grandchild ((not-a-block))",
      "see ((uuid))",
    ]);
    // Only blocks that link it themselves count (B-596); children are listed, not counted.
    expect(answer.linked.filter((r) => r.direct === 1)).toHaveLength(2);
    expect(answer.unlinked.map((r) => r.content).sort()).toEqual([
      "TODO call [[Nick]] about Target",
      "mentions Target without a link",
    ]);
    expect(answer.tagged).toHaveLength(1);

    // `[[Nick]]` is a link to Real (alias::), and a property value is a reference too.
    const real = backlinkRows(driver, resolveBacklinksTarget(driver, "Real"), {
      includeUnlinked: false,
      unlinkedLimit: 50,
    });
    expect(real.linked.map((r) => r.content).sort()).toEqual([
      "TODO call [[Nick]] about Target",
      "mentions Target without a link",
    ]);
    // A page that does not exist yet still has what points at it; a task is a `Task`.
    expect(
      backlinkRows(driver, resolveBacklinksTarget(driver, "Not Yet Created"), {
        includeUnlinked: false,
        unlinkedLimit: 50,
      }).linked,
    ).toHaveLength(1);
    expect(
      backlinkRows(driver, resolveBacklinksTarget(driver, "Task"), {
        includeUnlinked: false,
        unlinkedLimit: 50,
      }).linked,
    ).toHaveLength(1);
  });

  it("answers a block target with the blocks that ((ref)) it", () => {
    buildGraph();
    const refd = driver.get<{ id: string }>(
      "SELECT id FROM block WHERE content = 'a block someone points at'",
    )?.id as string;
    const target = resolveBacklinksTarget(driver, refd);
    expect(target.kind).toBe("block");
    expect(
      backlinkRows(driver, target, { includeUnlinked: false, unlinkedLimit: 50 }).linked,
    ).toHaveLength(1);
  });
});
