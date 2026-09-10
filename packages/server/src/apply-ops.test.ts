import { newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function createPage(name: string) {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "page.create", name, journalDay: null, createdAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function createBlock(pageId: string, content: string, parentId: string | null = null) {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: {
          kind: "block.create",
          place: { pageId, parentId, order: "a0" },
          content,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

describe("db + schema", () => {
  it("initializes the full core + server schema", () => {
    const driver = openDb({ path: ":memory:" });
    const tables = driver
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .map((r) => r.name)
      .sort();
    for (const t of [
      "page",
      "block",
      "block_prop",
      "page_prop",
      "op",
      "setting",
      "keybinding",
      "plugin",
      "ref",
      "path_ref",
      "page_alias",
      "changes",
      "token",
      "device",
      "mirror_file",
      "asset",
      "embedding_model",
      "embedding",
      "embed_dirty",
      "schema_migration",
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });
});

describe("serverApplyOps: refs and path_ref indexing", () => {
  it("indexes a [[page]] ref and resolves dst_page_id once the target exists", () => {
    const p1 = createPage("Page One");
    const b1 = createBlock(p1, "See [[Page Two]] and #tag");

    let refs = ctx.driver.all<{
      kind: string;
      dst_page_key: string | null;
      dst_page_id: string | null;
    }>("SELECT kind, dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? ORDER BY kind", [
      b1,
    ]);
    expect(refs).toEqual([
      { kind: "page", dst_page_key: "page two", dst_page_id: null },
      { kind: "tag", dst_page_key: "tag", dst_page_id: null },
    ]);

    const p2 = createPage("Page Two");
    // Creating the target page does not retroactively backfill dst_page_id (rule 11 says a
    // future write must refresh it; page.create alone doesn't touch existing ref rows) — but a
    // subsequent edit to the referencing block does re-resolve it.
    const hlc = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: b1,
          payload: { kind: "block.text", content: "See [[Page Two]] and #tag" },
        },
      ],
      { origin: "user", actor: "test" },
    );
    refs = ctx.driver.all(
      "SELECT kind, dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? ORDER BY kind",
      [b1],
    );
    expect(refs).toEqual([
      { kind: "page", dst_page_key: "page two", dst_page_id: p2 },
      { kind: "tag", dst_page_key: "tag", dst_page_id: null },
    ]);
  });

  it("computes path_ref as the closure of a block's own refs plus every ancestor's", () => {
    const page = createPage("Home");
    const parent = createBlock(page, "About [[Topic A]]");
    const child = createBlock(page, "no refs here", parent);

    const childPaths = ctx.driver
      .all<{ page_key: string }>(
        "SELECT page_key FROM path_ref WHERE block_id = ? ORDER BY page_key",
        [child],
      )
      .map((r) => r.page_key);
    expect(childPaths).toEqual(["home", "topic a"]);

    const parentPaths = ctx.driver
      .all<{ page_key: string }>(
        "SELECT page_key FROM path_ref WHERE block_id = ? ORDER BY page_key",
        [parent],
      )
      .map((r) => r.page_key);
    expect(parentPaths).toEqual(["home", "topic a"]);
  });

  it("computes linked references per sql-schema.md rule 13 (excluding the target page's own blocks)", () => {
    const target = createPage("Target");
    const other = createPage("Other Page");
    const referencing = createBlock(other, "mentions [[Target]]");
    createBlock(target, "does not mention itself via [[Target]] semantics"); // own block, must be excluded

    const rows = ctx.driver.all<{ block_id: string; src_page_id: string }>(
      `SELECT b.id AS block_id, b.page_id AS src_page_id
       FROM path_ref pr
       JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
       WHERE pr.page_key = 'target' AND b.page_id != ?`,
      [target],
    );
    expect(rows).toEqual([{ block_id: referencing, src_page_id: other }]);
  });

  it("finds unlinked references via FTS, excluding blocks that already link", () => {
    const target = createPage("Widget");
    const linking = createBlock(target, "placeholder");
    const other = createPage("Notes");
    const mentionsUnlinked = createBlock(other, "I should try a widget soon");
    const mentionsLinked = createBlock(other, "See [[Widget]] for details");
    void linking;

    const rows = ctx.driver.all<{ block_id: string }>(
      `SELECT b.id AS block_id
       FROM block_fts
       JOIN block b ON b.rowid = block_fts.rowid
       WHERE block_fts MATCH '"widget"'
         AND b.deleted_at IS NULL
         AND b.page_id != ?
         AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key = 'widget')`,
      [target],
    );
    expect(rows.map((r) => r.block_id)).toEqual([mentionsUnlinked]);
    expect(rows.map((r) => r.block_id)).not.toContain(mentionsLinked);
  });
});

describe("serverApplyOps: cycle rejection emits a corrective op", () => {
  it("rejects a cycle-creating move and restores the block's prior place with a server-authored op", () => {
    const page = createPage("Tree");
    const a = createBlock(page, "A");
    const b = createBlock(page, a, null); // sibling of A, will become A's child, then try the reverse
    // make B a child of A first (valid)
    let hlc = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: b,
          payload: { kind: "block.place", place: { pageId: page, parentId: a, order: "a1" } },
        },
      ],
      { origin: "user", actor: "test" },
    );

    // Now try to move A under B — a cycle (A is B's ancestor).
    hlc = ctx.hlc.next();
    const result = serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "bbbbbbbb",
          entity: a,
          payload: { kind: "block.place", place: { pageId: page, parentId: b, order: "a0" } },
        },
      ],
      { origin: "user", actor: "test" },
    );

    expect(result.rejected).toBeGreaterThanOrEqual(1);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]?.device).toBe("00000000");

    const row = ctx.driver.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [a],
    );
    expect(row?.parent_id).toBeNull(); // A stayed at top level, the cycle never took effect

    const correctiveChange = ctx.driver.get(
      "SELECT * FROM changes WHERE entity_id = ? AND actor = 'test' ORDER BY seq DESC LIMIT 1",
      [a],
    );
    expect(correctiveChange).toBeDefined();
  });
});

describe("serverApplyOps: audit trail", () => {
  it("writes one changes row per touched entity, sharing a batchId, skipping rejected ops", () => {
    const p1 = createPage("Audit Page");
    const p2id = newId();
    const dupHlc = ctx.hlc.next();
    // A page.create colliding on the same normalized key as an existing page is rejected.
    const before = ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM changes");
    serverApplyOps(
      ctx,
      [
        {
          id: dupHlc,
          hlc: dupHlc,
          device: "aaaaaaaa",
          entity: p2id,
          payload: {
            kind: "page.create",
            name: "Audit Page",
            journalDay: null,
            createdAt: Date.now(),
          },
        },
      ],
      { origin: "api", actor: "token:abc" },
    );
    const after = ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM changes");
    expect(after?.n).toBe(before?.n); // rejected op produced no changes row

    const b1 = newId();
    const b2 = newId();
    const h1 = ctx.hlc.next();
    const h2 = ctx.hlc.next();
    const res = serverApplyOps(
      ctx,
      [
        {
          id: h1,
          hlc: h1,
          device: "aaaaaaaa",
          entity: b1,
          payload: {
            kind: "block.create",
            place: { pageId: p1, parentId: null, order: "a0" },
            content: "one",
            createdAt: Date.now(),
          },
        },
        {
          id: h2,
          hlc: h2,
          device: "aaaaaaaa",
          entity: b2,
          payload: {
            kind: "block.create",
            place: { pageId: p1, parentId: null, order: "a1" },
            content: "two",
            createdAt: Date.now(),
          },
        },
      ],
      { origin: "api", actor: "token:abc" },
    );
    const rows = ctx.driver.all<{
      entity_id: string;
      batch_id: string;
      origin: string;
      actor: string;
    }>("SELECT entity_id, batch_id, origin, actor FROM changes WHERE batch_id = ?", [res.batchId]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin === "api" && r.actor === "token:abc")).toBe(true);
    expect(new Set(rows.map((r) => r.entity_id))).toEqual(new Set([b1, b2]));
  });
});
