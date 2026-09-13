import { Hlc, makeOp, type Op, orderBetween } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSyncTestServer, type SyncTestServer } from "./sync/sync-test-helpers.js";
import { type JsonAny, post } from "./test-helpers.js";
import { verifyRebuildParity } from "./verify.js";

let s: SyncTestServer;
beforeEach(() => {
  s = makeSyncTestServer();
});

async function tree(page: string): Promise<JsonAny[]> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : [];
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

function pageId(name: string): string {
  const row = s.serverCtx.driver.get<{ id: string }>("SELECT id FROM page WHERE key = ?", [
    name.toLowerCase(),
  ]);
  if (!row) throw new Error(`no page ${name}`);
  return row.id;
}

function orderOf(id: string): string {
  return (
    s.serverCtx.driver.get<{ order_key: string }>("SELECT order_key FROM block WHERE id = ?", [id])
      ?.order_key ?? "a0"
  );
}

async function push(ops: Op[]): Promise<JsonAny> {
  const r = await post(s.app, "/sync/push", s.syncToken, { device_id: "bbbbbbbb", ops });
  expect(r.status).toBe(200);
  return r.json;
}

describe("children follow their parent's page, whoever moved the parent (B-120)", () => {
  it("a later device reorder on the old page wins, and the subtree comes back with it", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- a\n- x\n  - c1\n    - g\n  - c2",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const [a, x] = await tree("Src");

    // The server (an agent, or the menu) moves x and its subtree to Dst.
    const mv = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id: x.id,
      page: "Dst",
    });
    expect(mv.json.moved).toBe(4);

    // Device B had Src synced and reorders x above a — without having pulled the move. Its op
    // carries the later HLC, so LWW lets it win: x goes back to Src.
    const devB = new Hlc("bbbbbbbb");
    devB.receive(s.serverCtx.hlc.next());
    const reorder = makeOp(devB.next(), "bbbbbbbb", x.id, {
      kind: "block.place",
      place: { pageId: pageId("Src"), parentId: null, order: orderBetween(null, orderOf(a.id)) },
    });
    const res = await push([reorder]);
    expect(res.accepted.map((r: JsonAny) => r.id)).toEqual([reorder.id]);

    // The children came back with x — they are not left on Dst under a parent on Src.
    expect(shape(await tree("Src"))).toEqual([
      [
        "x",
        [
          ["c1", [["g", []]]],
          ["c2", []],
        ],
      ],
      ["a", []],
    ]);
    expect(shape(await tree("Dst"))).toEqual([["d", []]]);

    // The repair is ordinary logged ops, returned as corrections so device B converges too.
    const repaired = res.corrections.map((c: JsonAny) => c.entity).sort();
    const ids = s.serverCtx.driver.all<{ id: string }>(
      "SELECT id FROM block WHERE content IN ('c1', 'g', 'c2') ORDER BY id",
    );
    expect(repaired).toEqual(ids.map((r) => r.id));
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("a device moving a child to another page brings the grandchildren along", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- x\n  - c1\n    - g\n      - gg",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const [x] = await tree("Src");
    const c1 = x.children[0];
    const dev = new Hlc("bbbbbbbb");
    dev.receive(s.serverCtx.hlc.next());
    const res = await push([
      makeOp(dev.next(), "bbbbbbbb", c1.id, {
        kind: "block.place",
        place: { pageId: pageId("Dst"), parentId: null, order: orderBetween(orderOf(x.id), null) },
      }),
    ]);
    expect(res.corrections).toHaveLength(2);
    expect(shape(await tree("Src"))).toEqual([["x", []]]);
    expect(shape(await tree("Dst"))).toEqual([
      ["d", []],
      ["c1", [["g", [["gg", []]]]]],
    ]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("a batch that moves a block away and back does not strand what was placed under it meanwhile", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- x\n- c1\n  - g",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const [x, c1] = await tree("Src");
    const src = pageId("Src");
    const dst = pageId("Dst");
    const dev = new Hlc("bbbbbbbb");
    dev.receive(s.serverCtx.hlc.next());
    await push([
      makeOp(dev.next(), "bbbbbbbb", x.id, {
        kind: "block.place",
        place: { pageId: dst, parentId: null, order: "n0" },
      }),
      makeOp(dev.next(), "bbbbbbbb", c1.id, {
        kind: "block.place",
        place: { pageId: dst, parentId: x.id, order: "a0" },
      }),
      makeOp(dev.next(), "bbbbbbbb", x.id, {
        kind: "block.place",
        place: { pageId: src, parentId: null, order: orderOf(x.id) },
      }),
    ]);
    // x ends where it began; c1 (placed under x while x was on Dst) and g come with it.
    expect(shape(await tree("Src"))).toEqual([["x", [["c1", [["g", []]]]]]]);
    expect(shape(await tree("Dst"))).toEqual([["d", []]]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });
});

describe("tombstoned descendants move with their parent (B-120)", () => {
  it("a deleted child follows a cross-page move and restores onto the parent's page, grandchild attached", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- p\n  - c1\n    - g\n  - c2",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const [p] = await tree("Src");
    const c1 = p.children[0];
    expect((await post(s.app, "/api/v1/block.delete", s.writeToken, { id: c1.id })).status).toBe(
      200,
    );
    const mv = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id: p.id,
      page: "Dst",
    });
    expect(mv.json.moved).toBe(2); // p and c2: the count is of live blocks

    // Nothing is left on Src, live or not.
    const onSrc = s.serverCtx.driver.all<{ content: string }>(
      "SELECT content FROM block WHERE page_id = ?",
      [pageId("Src")],
    );
    expect(onSrc).toEqual([]);

    const trash = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(trash.json.items.map((i: JsonAny) => i.id)).toEqual([c1.id]);
    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: c1.id });
    expect(restore.status).toBe(200);
    expect(restore.json.page).toBe("Dst");
    expect(shape(await tree("Dst"))).toEqual([
      ["d", []],
      [
        "p",
        [
          ["c1", [["g", []]]],
          ["c2", []],
        ],
      ],
    ]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("page.merge carries a deleted child along too, so restoring it lands on the target", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- p\n  - c1",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Tgt", markdown: "- t" });
    const [p] = await tree("Src");
    const c1 = p.children[0];
    await post(s.app, "/api/v1/block.delete", s.writeToken, { id: c1.id });
    const merge = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Src",
      target: "Tgt",
    });
    expect(merge.status).toBe(200);
    const restore = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: c1.id });
    expect(restore.status).toBe(200);
    expect(restore.json.page).toBe("Tgt");
    expect(shape(await tree("Tgt"))).toEqual([
      ["t", []],
      ["p", [["c1", []]]],
    ]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });
});
