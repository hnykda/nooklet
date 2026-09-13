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

function createBlock(
  pageId: string,
  content: string,
  parentId: string | null = null,
  referencedPages: "mint" | "skip" = "mint",
) {
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
    { origin: "user", actor: "test", referencedPages },
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
      "page_tag",
      "plugin_kv",
      "idempotency",
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });
});

describe("serverApplyOps: refs and path_ref indexing", () => {
  it("indexes a [[page]] ref and, with minting skipped (the importer), resolves dst_page_id once the target exists", () => {
    const p1 = createPage("Page One");
    // An ordinary write would create both pages at once (ADR 024, `ref-pages.test.ts`); the
    // importer writes with minting off, and this is the resolution it then relies on.
    const b1 = createBlock(p1, "See [[Page Two]] and #tag", null, "skip");

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

    // Creating the target page resolves the reference the moment it exists (`reindexPageIdentity`
    // re-resolves the new page's own key) — it used to stay NULL until the referencing block
    // happened to be edited again.
    const p2 = createPage("Page Two");
    refs = ctx.driver.all(
      "SELECT kind, dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? ORDER BY kind",
      [b1],
    );
    expect(refs).toEqual([
      { kind: "page", dst_page_key: "page two", dst_page_id: p2 },
      { kind: "tag", dst_page_key: "tag", dst_page_id: null },
    ]);
    expect(
      ctx.driver.get<{ page_id: string | null }>(
        "SELECT page_id FROM path_ref WHERE block_id = ? AND page_key = 'page two'",
        [b1],
      )?.page_id,
    ).toBe(p2);
  });

  it("derives page_alias from alias:: and resolves [[alias]] references through it (B-55)", () => {
    const real = createPage("Real Name");
    const b = createBlock(createPage("Elsewhere"), "see [[Nick]] and #Nickname");
    const dstOf = () =>
      ctx.driver.all<{ dst_page_key: string; dst_page_id: string | null }>(
        "SELECT dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? ORDER BY dst_page_key",
        [b],
      );
    // The references made their pages exist (ADR 024): empty pages, nobody's but the references'.
    const [nickPage, nicknamePage] = dstOf().map((r) => r.dst_page_id);
    expect(nickPage).not.toBeNull();
    expect(nicknamePage).not.toBeNull();
    expect(nickPage).not.toBe(real);

    // Setting the property is what populates the index — never a direct write to page_alias.
    const setAlias = (value: string | null) => {
      const hlc = ctx.hlc.next();
      serverApplyOps(
        ctx,
        [
          {
            id: hlc,
            hlc,
            device: "aaaaaaaa",
            entity: real,
            payload: { kind: "page.prop", key: "alias", value },
          },
        ],
        { origin: "user", actor: "test" },
      );
    };
    setAlias("[[Nick]], #Nickname, Real Name");
    expect(
      ctx.driver.all<{ alias_key: string }>(
        "SELECT alias_key FROM page_alias WHERE page_id = ? ORDER BY alias_key",
        [real],
      ),
    ).toEqual([{ alias_key: "nick" }, { alias_key: "nickname" }]); // never its own key
    // The empty pages give the names up to the alias (an own key would otherwise outrank it).
    expect(dstOf().map((r) => r.dst_page_id)).toEqual([real, real]);

    // Removing an alias un-resolves the references that reached the page through it — to a new
    // empty page the reference keeps (ADR 024), not the real page and not the old tombstone.
    setAlias("Nickname");
    const afterRemoval = dstOf();
    expect(afterRemoval.map((r) => r.dst_page_key)).toEqual(["nick", "nickname"]);
    expect(afterRemoval[0]?.dst_page_id).not.toBeNull();
    expect([real, nickPage]).not.toContain(afterRemoval[0]?.dst_page_id);
    expect(afterRemoval[1]?.dst_page_id).toBe(real);

    // A real page with that name outranks the alias.
    const nick = createPage("Nickname");
    expect(dstOf().find((r) => r.dst_page_key === "nickname")?.dst_page_id).toBe(nick);
  });

  it("re-resolves references by the old name on rename and clears them on delete", () => {
    const p = createPage("Before");
    const b = createBlock(createPage("Other"), "[[Before]]");
    const target = () =>
      ctx.driver.get<{ dst_page_id: string | null }>(
        "SELECT dst_page_id FROM ref WHERE src_block_id = ?",
        [b],
      )?.dst_page_id;
    expect(target()).toBe(p);

    const apply = (payload: import("@nooklet/core").OpPayload) => {
      const hlc = ctx.hlc.next();
      serverApplyOps(ctx, [{ id: hlc, hlc, device: "aaaaaaaa", entity: p, payload }], {
        origin: "user",
        actor: "test",
      });
    };
    apply({ kind: "page.rename", name: "After" });
    // `[[Before]]` no longer names this page — it names the empty page the reference keeps (ADR 024)
    const kept = target();
    expect(kept).not.toBeNull();
    expect(kept).not.toBe(p);
    apply({ kind: "page.prop", key: "alias", value: "Before" });
    expect(target()).toBe(p); // ...until the old name is kept as an alias
    apply({ kind: "page.delete", deletedAt: Date.now() });
    // Deleted with the alias: the still-referenced name gets an empty page once more — a new one.
    expect(target()).not.toBeNull();
    expect([p, kept]).not.toContain(target());
    expect(
      ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM page_alias WHERE page_id = ?", [p])
        ?.n,
    ).toBe(0);
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
