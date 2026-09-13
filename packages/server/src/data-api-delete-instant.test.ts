import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDataApi } from "./data-api.js";
import { type JsonAny, makeTestServer, post, type TestServer } from "./test-helpers.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function tree(page: string): Promise<JsonAny[]> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : [];
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

/** A delete that spans milliseconds — a slow machine, a big page — is the case that broke. */
function clockAdvancingPerCall(): void {
  let t = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => t++);
}

describe("DataApi deletes are one action, one instant (B-121)", () => {
  it("a page deleted through ctx.data comes back from the trash with all its blocks", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Plug",
      markdown: "- a\n- b\n  - c",
    });
    const page = s.serverCtx.driver.get<{ id: string }>("SELECT id FROM page WHERE key = 'plug'");
    const api = createDataApi(s.serverCtx, { origin: "plugin", actor: "test-plugin" });
    clockAdvancingPerCall();
    await api.pages.delete(page?.id as string);
    vi.restoreAllMocks();

    const r = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: page?.id });
    expect(r.status).toBe(200);
    expect(r.json.restored).toHaveLength(4);
    expect(shape(await tree("Plug"))).toEqual([
      ["a", []],
      ["b", [["c", []]]],
    ]);
  });

  it("a subtree deleted through ctx.data comes back whole", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Plug",
      markdown: "- p\n  - c1\n    - g\n  - c2",
    });
    const [p] = await tree("Plug");
    const api = createDataApi(s.serverCtx, { origin: "plugin", actor: "test-plugin" });
    clockAdvancingPerCall();
    await api.blocks.delete(p.id);
    vi.restoreAllMocks();

    const trash = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(trash.json.items.map((i: JsonAny) => i.id)).toEqual([p.id]);
    const r = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: p.id });
    expect(r.status).toBe(200);
    expect(shape(await tree("Plug"))).toEqual([
      [
        "p",
        [
          ["c1", [["g", []]]],
          ["c2", []],
        ],
      ],
    ]);
  });
});
