import { Hlc, makeOp, newId } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverApplyOps } from "../apply-ops.js";
import { registerBeforeWrite } from "../plugins/before-write.js";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
let unregister: (() => void) | undefined;
beforeEach(() => {
  s = makeTestServer();
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

async function tree(page: string): Promise<JsonAny[]> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : [];
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

function counts(): { ops: number; changes: number } {
  const d = s.serverCtx.driver;
  return {
    ops: d.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n ?? 0,
    changes: d.get<{ n: number }>("SELECT count(*) AS n FROM changes")?.n ?? 0,
  };
}

/** A beforeWrite hook that points the first block move/create of the next write at a page that
 * does not exist, so core rejects exactly that one op and applies the rest — the shape of every
 * partial rejection these handlers can meet. */
function rejectOneMoveInTheNextWrite(): void {
  let armed = true;
  unregister = registerBeforeWrite(s.serverCtx, (tx) => {
    if (!armed) return;
    const i = tx.ops.findIndex(
      (op) => op.payload.kind === "block.place" || op.payload.kind === "block.create",
    );
    const op = tx.ops[i];
    if (!op || (op.payload.kind !== "block.place" && op.payload.kind !== "block.create")) return;
    armed = false;
    tx.ops[i] = {
      ...op,
      payload: { ...op.payload, place: { ...op.payload.place, pageId: "nopage00000000" } },
    } as typeof op;
  });
}

describe("refactor ops are all or nothing (B-122)", () => {
  it("block.to_page onto an ordinary page named like a date extends that page", async () => {
    // An ordinary page whose name happens to be an ISO date (an imported pages/2026-09-07.md).
    const h = new Hlc("aaaaaaaa");
    serverApplyOps(
      s.serverCtx,
      [
        makeOp(h.next(), "aaaaaaaa", newId(), {
          kind: "page.create",
          name: "2026-09-07",
          journalDay: null,
          createdAt: 1,
        }),
      ],
      { origin: "import", actor: "test" },
    );
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Notes",
      markdown: "- 2026-09-07\n  more text\n  - kid",
    });
    const [block] = await tree("Notes");

    const r = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id: block.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ page_created: false, link: "[[2026-09-07]]" });
    const pages = s.serverCtx.driver.all<{ journal_day: number | null }>(
      "SELECT journal_day FROM page WHERE key = '2026-09-07'",
    );
    expect(pages).toEqual([{ journal_day: null }]);
    expect(shape(await tree("Notes"))).toEqual([["[[2026-09-07]]", []]]);
    const onPage = s.serverCtx.driver.all<{ content: string }>(
      "SELECT b.content FROM block b JOIN page p ON p.id = b.page_id WHERE p.key = '2026-09-07' ORDER BY b.order_key",
    );
    expect(onPage.map((b) => b.content)).toEqual(["more text", "kid"]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("block.to_page writes nothing when any op of its batch is rejected", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Notes",
      markdown: "- Topic\n  more text\n  - kid",
    });
    const [block] = await tree("Notes");
    const before = counts();
    rejectOneMoveInTheNextWrite();
    const r = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id: block.id });
    expect(r.status).toBe(400);
    expect(counts()).toEqual(before);
    expect(shape(await tree("Notes"))).toEqual([["Topic\nmore text", [["kid", []]]]]);
  });

  it("block.move_to_page writes nothing when any op of its batch is rejected", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Src",
      markdown: "- p\n  - c",
    });
    const [p] = await tree("Src");
    const before = counts();
    rejectOneMoveInTheNextWrite();
    const r = await post(s.app, "/api/v1/block.move_to_page", s.writeToken, {
      id: p.id,
      page: "Brand New",
    });
    expect(r.status).toBe(400);
    expect(counts()).toEqual(before);
    expect(shape(await tree("Src"))).toEqual([["p", [["c", []]]]]);
    const created = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Brand New" });
    expect(created.status).toBe(404);
  });

  it("page.merge writes nothing when any op of its batch is rejected", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Src", markdown: "- a\n- b" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Tgt", markdown: "- t" });
    const before = counts();
    rejectOneMoveInTheNextWrite();
    const r = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Src",
      target: "Tgt",
    });
    expect(r.status).toBe(400);
    expect(counts()).toEqual(before);
    expect(shape(await tree("Src"))).toEqual([
      ["a", []],
      ["b", []],
    ]);
    expect(shape(await tree("Tgt"))).toEqual([["t", []]]);
  });
});
