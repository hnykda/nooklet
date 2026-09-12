import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function createPage(name: string, markdown: string): Promise<string> {
  const r = await post(s.app, "/api/v1/page.create", s.writeToken, { name, markdown });
  expect(r.status).toBe(200);
  return r.json.page_id as string;
}

async function firstBlockId(name: string): Promise<string> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page: name, format: "json" });
  return r.json.tree[0].id as string;
}

async function deletePage(name: string): Promise<string> {
  const r = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: name });
  expect(r.status).toBe(200);
  return r.json.batch_id as string;
}

async function deleteBlock(id: string): Promise<string> {
  const r = await post(s.app, "/api/v1/block.delete", s.writeToken, { id });
  expect(r.status).toBe(200);
  return r.json.batch_id as string;
}

/** The tombstone instant is the trash's ordering key; two deletes in the same millisecond would
 * tie, so space them out the way real deletions are. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 2));
}

describe("trash.list", () => {
  it("is empty on a fresh graph, and readable with a read token", async () => {
    const r = await post(s.app, "/api/v1/trash.list", s.readToken, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [], has_more: false });
  });

  it("lists pages and blocks together, newest deletion first, with who deleted them", async () => {
    const aId = await createPage("Alpha", "- a");
    await createPage("Beta", "- b1\n- b2");
    const gammaId = await createPage("Gamma", "- g");
    const b1 = await firstBlockId("Beta");

    const alphaBatch = await deletePage("Alpha");
    await tick();
    const blockBatch = await deleteBlock(b1);
    await tick();
    const gammaBatch = await deletePage("Gamma");

    const r = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(r.status).toBe(200);
    expect(r.json.has_more).toBe(false);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([gammaId, b1, aId]);

    const [gamma, block, alpha] = r.json.items;
    expect(gamma).toMatchObject({
      kind: "page",
      title: "Gamma",
      page: "Gamma",
      block_count: 1,
      deleted_by: { origin: "api", actor: "test-write", batch_id: gammaBatch },
    });
    expect(block).toMatchObject({
      kind: "block",
      title: "b1",
      page: "Beta",
      block_count: 1,
      deleted_by: { origin: "api", actor: "test-write", batch_id: blockBatch },
    });
    expect(alpha).toMatchObject({
      kind: "page",
      title: "Alpha",
      deleted_by: { batch_id: alphaBatch },
    });
    expect(typeof gamma.deleted_at).toBe("string");
    expect(Date.parse(gamma.deleted_at)).toBeGreaterThan(Date.parse(alpha.deleted_at));
  });

  it("lists one entry per delete action, not one per tombstoned block", async () => {
    await createPage("Tree", "- a\n  - b\n    - c\n- d");
    const a = await firstBlockId("Tree");
    await deleteBlock(a);
    const r = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ kind: "block", id: a, title: "a", block_count: 3 });
  });

  it("lists a deleted page once, without its blocks — even one deleted earlier on its own", async () => {
    await createPage("Mixed", "- first\n- second");
    const first = await firstBlockId("Mixed");
    await deleteBlock(first);
    await tick();
    await deletePage("Mixed");
    const r = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    // The earlier-deleted block is not restorable while its page is in the trash, so it is not
    // offered; it counts neither toward the page's entry (it does not come back with the page)…
    expect(r.json.items.map((i: { kind: string; title: string }) => [i.kind, i.title])).toEqual([
      ["page", "Mixed"],
    ]);
    expect(r.json.items[0].block_count).toBe(1);
    // …nor disappears: once the page is back, it is the trash's one entry.
    await post(s.app, "/api/v1/trash.restore", s.writeToken, { page: "Mixed" });
    const after = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(after.json.items.map((i: { kind: string; id: string }) => [i.kind, i.id])).toEqual([
      ["block", first],
    ]);
  });

  it("filters by kind and by page", async () => {
    await createPage("P1", "- x");
    await createPage("P2", "- y");
    const x = await firstBlockId("P1");
    const y = await firstBlockId("P2");
    await deleteBlock(x);
    await tick();
    await deleteBlock(y);
    await tick();
    await createPage("P3", "- z");
    await deletePage("P3");

    const pages = await post(s.app, "/api/v1/trash.list", s.writeToken, { kind: "page" });
    expect(pages.json.items.map((i: { title: string }) => i.title)).toEqual(["P3"]);
    const blocks = await post(s.app, "/api/v1/trash.list", s.writeToken, { kind: "block" });
    expect(blocks.json.items.map((i: { title: string }) => i.title)).toEqual(["y", "x"]);
    const onP1 = await post(s.app, "/api/v1/trash.list", s.writeToken, { page: "p1" });
    expect(onP1.json.items.map((i: { id: string }) => i.id)).toEqual([x]);
    const missing = await post(s.app, "/api/v1/trash.list", s.writeToken, { page: "Nope" });
    expect(missing.status).toBe(404);
  });

  it("paginates with a cursor across both kinds", async () => {
    await createPage("Q1", "- q");
    const q = await firstBlockId("Q1");
    await deleteBlock(q);
    await tick();
    await createPage("Q2", "- r");
    await deletePage("Q2");
    await tick();
    await createPage("Q3", "- s");
    await deletePage("Q3");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await post(s.app, "/api/v1/trash.list", s.writeToken, { limit: 1, cursor });
      expect(r.status).toBe(200);
      expect(r.json.items).toHaveLength(1);
      seen.push(r.json.items[0].title);
      if (!r.json.has_more) {
        expect(r.json.cursor).toBeUndefined();
        break;
      }
      cursor = r.json.cursor;
      expect(typeof cursor).toBe("string");
    }
    expect(seen).toEqual(["Q3", "Q2", "q"]);
  });

  it("rejects a malformed cursor (invalid)", async () => {
    const r = await post(s.app, "/api/v1/trash.list", s.writeToken, { cursor: "nonsense" });
    expect(r.status).toBe(400);
  });
});
