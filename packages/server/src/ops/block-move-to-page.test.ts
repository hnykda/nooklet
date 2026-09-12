import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function tree(page: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : undefined;
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

async function seedSource(): Promise<string> {
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Src",
    markdown: "- p\n  - c\n    - gc\n- stays",
  });
  return (await tree("Src"))[0].id as string;
}

describe("block.move_to_page", () => {
  it("moves the whole subtree, not just the root (B-85), to the end of an existing page", async () => {
    const id = await seedSource();
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const { status, json } = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Dst",
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ page: "Dst", page_created: false, moved: 3 });
    // Every moved block is reported, root first — each one got its own block.place.
    expect(json.updated).toHaveLength(3);
    expect(json.updated[0]).toBe(id);
    expect(shape(await tree("Dst"))).toEqual([
      ["d", []],
      ["p", [["c", [["gc", []]]]]],
    ]);
    expect(shape(await tree("Src"))).toEqual([["stays", []]]);
    // Every descendant now says it is on Dst — the row-level fact B-85 got wrong.
    const pages = s.serverCtx.driver.all<{ page_id: string }>(
      "SELECT DISTINCT page_id FROM block WHERE content IN ('p', 'c', 'gc')",
    );
    expect(pages).toHaveLength(1);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("position: start puts it first", async () => {
    const id = await seedSource();
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Dst",
      position: "start",
    });
    expect((await tree("Dst")).map((n: JsonAny) => n.content)).toEqual(["p", "d"]);
  });

  it("creates the page when it does not exist, in the same batch, and a date becomes a journal", async () => {
    const id = await seedSource();
    const { json } = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Brand New",
    });
    expect(json.page_created).toBe(true);
    expect(shape(await tree("Brand New"))).toEqual([["p", [["c", [["gc", []]]]]]]);

    const stays = (await tree("Src"))[0].id as string;
    const j = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id: stays,
      page: "2026-03-04",
    });
    expect(j.json.page).toBe("2026-03-04");
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "2026-03-04" });
    expect(read.json.page.kind).toBe("journal");
  });

  it("create_page: false fails with not_found and moves nothing", async () => {
    const id = await seedSource();
    const { status, json } = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Nowhere",
      create_page: false,
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(shape(await tree("Src"))).toEqual([
      ["p", [["c", [["gc", []]]]]],
      ["stays", []],
    ]);
  });

  it("batch_undo returns the subtree to its original page and position", async () => {
    const id = await seedSource();
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dst", markdown: "- d" });
    const { json } = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Dst",
    });
    await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: json.batch_id });
    expect(shape(await tree("Src"))).toEqual([
      ["p", [["c", [["gc", []]]]]],
      ["stays", []],
    ]);
    expect(shape(await tree("Dst"))).toEqual([["d", []]]);
  });

  it("dry_run changes nothing", async () => {
    const id = await seedSource();
    const { json } = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id,
      page: "Dst",
      dry_run: true,
    });
    expect(json).toMatchObject({ page_created: true, moved: 3, dry_run: true });
    expect(await tree("Dst")).toBeUndefined();
    expect(shape(await tree("Src"))).toEqual([
      ["p", [["c", [["gc", []]]]]],
      ["stays", []],
    ]);
  });
});
