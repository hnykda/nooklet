import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

interface Node {
  id: string;
  content: string;
  children: Node[];
}

/** The page's tree as `content` strings, nested — the shape restore assertions read best in. */
function shape(tree: Node[]): unknown[] {
  return tree.map((n) => (n.children.length > 0 ? [n.content, shape(n.children)] : n.content));
}

async function readShape(name: string): Promise<{ status: number; shape: unknown[] }> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page: name, format: "json" });
  return { status: r.status, shape: r.status === 200 ? shape(r.json.tree) : [] };
}

async function blockIdByContent(name: string, content: string): Promise<string> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page: name, format: "json" });
  const walk = (nodes: Node[]): string | undefined => {
    for (const n of nodes) {
      if (n.content === content) return n.id;
      const inner = walk(n.children);
      if (inner) return inner;
    }
    return undefined;
  };
  const id = walk(r.json.tree);
  if (!id) throw new Error(`no block "${content}" on ${name}`);
  return id;
}

async function trash(): Promise<
  Array<{ kind: string; id: string; title: string; block_count: number }>
> {
  const r = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
  expect(r.status).toBe(200);
  return r.json.items;
}

/** One delete action = one tombstone instant (ADR 019). Two actions in the same millisecond
 * would share it, so tests space them out the way real deletions are. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 2));
}

describe("trash.restore — pages", () => {
  it("brings a deleted page back with every block deleted along with it (success)", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Restore Me",
      markdown: "- a\n  - b\n- c",
    });
    expect(create.status).toBe(200);
    const del = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Restore Me" });
    expect(del.status).toBe(200);
    expect((await readShape("Restore Me")).status).toBe(404);

    const items = await trash();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "page", id: create.json.page_id, title: "Restore Me" });
    expect(items[0]?.block_count).toBe(3);

    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: create.json.page_id,
    });
    expect(restore.status).toBe(200);
    expect(restore.json.kind).toBe("page");
    expect(restore.json.page).toBe("Restore Me");
    expect(restore.json.restored).toHaveLength(4); // the page + 3 blocks
    expect(restore.json.restored[0]).toBe(create.json.page_id);
    expect(typeof restore.json.batch_id).toBe("string");

    expect((await readShape("Restore Me")).shape).toEqual([["a", ["b"]], "c"]);
    expect(await trash()).toEqual([]);
    // The restore went through the op log like any write: replaying it reproduces live state.
    expect(verifyRebuildParity(s.serverCtx.driver).ok).toBe(true);
  });

  it("resolves a deleted page by name (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "By Name", markdown: "- x" });
    await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "By Name" });
    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { page: "by name" });
    expect(restore.status).toBe(200);
    expect((await readShape("By Name")).shape).toEqual(["x"]);
  });

  it("leaves a block that was deleted separately, earlier, in the trash", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Partial",
      markdown: "- keep\n- gone first",
    });
    const goneId = await blockIdByContent("Partial", "gone first");
    expect((await post(s.app, "/api/v1/block.delete", s.writeToken, { id: goneId })).status).toBe(
      200,
    );
    await tick();
    const page = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Partial" });
    expect(page.status).toBe(200);

    // While the page is in the trash only the page is listed (a block on a deleted page cannot be
    // restored on its own); its entry does not count the earlier-deleted block.
    let items = await trash();
    expect(items.map((i) => i.kind)).toEqual(["page"]);
    expect(items[0]?.block_count).toBe(1);

    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { page: "Partial" });
    expect(restore.status).toBe(200);
    expect((await readShape("Partial")).shape).toEqual(["keep"]);

    // The page is back; the block deleted earlier is now the trash's one entry.
    items = await trash();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "block", id: goneId, title: "gone first" });

    const restoreBlock = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: goneId });
    expect(restoreBlock.status).toBe(200);
    expect((await readShape("Partial")).shape).toEqual(["keep", "gone first"]);
    expect(await trash()).toEqual([]);
  });

  it("is conflict when a live page now has the name, and new_name resolves it", async () => {
    const first = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dup",
      markdown: "- old body",
    });
    await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Dup" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dup", markdown: "- new body" });

    const clash = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: first.json.page_id,
    });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe("conflict");
    expect(clash.json.error.hint).toMatch(/new_name/);

    const renamed = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: first.json.page_id,
      new_name: "Dup (restored)",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.page).toBe("Dup (restored)");
    expect((await readShape("Dup (restored)")).shape).toEqual(["old body"]);
    expect((await readShape("Dup")).shape).toEqual(["new body"]);
    expect(verifyRebuildParity(s.serverCtx.driver).ok).toBe(true);
  });

  it("is itself undoable: batch_undo of the restore deletes the page again", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Undo Restore",
      markdown: "- a",
    });
    await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Undo Restore" });
    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: create.json.page_id,
    });
    expect((await readShape("Undo Restore")).status).toBe(200);
    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: restore.json.batch_id,
    });
    expect(undo.status).toBe(200);
    expect((await readShape("Undo Restore")).status).toBe(404);
    expect((await trash()).map((i) => i.id)).toEqual([create.json.page_id]);
  });
});

describe("trash.restore — blocks", () => {
  it("brings a block back with the subtree deleted along with it (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Subtree",
      markdown: "- a\n  - b\n    - c\n- d",
    });
    const aId = await blockIdByContent("Subtree", "a");
    const del = await post(s.app, "/api/v1/block.delete", s.writeToken, { id: aId });
    expect(del.status).toBe(200);
    expect(del.json.deleted_count).toBe(3);
    expect((await readShape("Subtree")).shape).toEqual(["d"]);

    const items = await trash();
    expect(items).toHaveLength(1); // one entry for the whole subtree, not three
    expect(items[0]).toMatchObject({ kind: "block", id: aId, title: "a", block_count: 3 });

    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: aId });
    expect(restore.status).toBe(200);
    expect(restore.json.kind).toBe("block");
    expect(restore.json.page).toBe("Subtree");
    expect(restore.json.restored).toHaveLength(3);
    expect(restore.json.restored[0]).toBe(aId);
    expect((await readShape("Subtree")).shape).toEqual([["a", [["b", ["c"]]]], "d"]);
    expect(verifyRebuildParity(s.serverCtx.driver).ok).toBe(true);
  });

  it("restores the deleted ancestors a block needs to be visible, and only those", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Chain",
      markdown: "- a\n  - b\n    - c\n  - sibling",
    });
    const aId = await blockIdByContent("Chain", "a");
    const cId = await blockIdByContent("Chain", "c");
    await post(s.app, "/api/v1/block.delete", s.writeToken, { id: cId }); // first: c alone
    await tick(); // a separate action is a separate instant (ADR 019's grouping key)
    await post(s.app, "/api/v1/block.delete", s.writeToken, { id: aId }); // then: a, b, sibling

    const items = await trash();
    expect(items.map((i) => [i.id, i.block_count])).toEqual([
      [aId, 3],
      [cId, 1],
    ]);

    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: cId });
    expect(restore.status).toBe(200);
    // c, then its tombstoned parents b and a — but not `sibling`, which stays in the trash.
    expect(restore.json.restored).toHaveLength(3);
    expect(restore.json.restored[0]).toBe(cId);
    expect((await readShape("Chain")).shape).toEqual([["a", [["b", ["c"]]]]]);
    const left = await trash();
    expect(left).toHaveLength(1);
    expect(left[0]?.title).toBe("sibling");
  });

  it("refuses a block whose page is in the trash, pointing at the page (conflict)", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Whole Page",
      markdown: "- a",
    });
    const aId = await blockIdByContent("Whole Page", "a");
    await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Whole Page" });
    const r = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: aId });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ page_id: create.json.page_id });
    expect(r.json.error.hint).toContain(create.json.page_id);
  });
});

describe("trash.restore — arguments and dry runs", () => {
  it("dry_run reports what would come back and writes nothing", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dry", markdown: "- a\n- b" });
    await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Dry" });
    const dry = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      page: "Dry",
      dry_run: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.restored).toHaveLength(3);
    expect(dry.json.batch_id).toBeUndefined();
    expect((await readShape("Dry")).status).toBe(404);
    expect(await trash()).toHaveLength(1);
  });

  it("is not_found for an unknown id or name, invalid for something not in the trash", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Live", markdown: "- a" });
    const live = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Live" });
    expect(
      (await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: "00000000000000" })).status,
    ).toBe(404);
    expect(
      (await post(s.app, "/api/v1/trash.restore", s.writeToken, { page: "Never Existed" })).status,
    ).toBe(404);
    const notTrashed = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: live.json.page.id,
    });
    expect(notTrashed.status).toBe(400);
    expect(notTrashed.json.error.message).toMatch(/not in the trash/);
    const byName = await post(s.app, "/api/v1/trash.restore", s.writeToken, { page: "Live" });
    expect(byName.status).toBe(400);
  });

  it("requires exactly one of id and page (invalid)", async () => {
    expect((await post(s.app, "/api/v1/trash.restore", s.writeToken, {})).status).toBe(400);
    expect(
      (await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: "x", page: "y" })).status,
    ).toBe(400);
  });

  it("requires write scope (forbidden for a read token)", async () => {
    const r = await post(s.app, "/api/v1/trash.restore", s.readToken, { page: "x" });
    expect(r.status).toBe(403);
  });
});
