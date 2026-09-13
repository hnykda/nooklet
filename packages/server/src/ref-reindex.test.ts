import { newId, type Op } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { reindexPipeAliasRefs } from "./ref-reindex.js";
import { makeTestServer, post } from "./test-helpers.js";

let ctx: ServerContext;
beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function op(entity: string, payload: Op["payload"]): Op {
  const hlc = ctx.hlc.next();
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

describe("reindexPipeAliasRefs (B-86)", () => {
  it("rebuilds only the blocks whose ref rows carry a pipe, resolves them, and runs once", () => {
    const target = newId();
    const src = newId();
    const block = newId();
    const other = newId();
    serverApplyOps(
      ctx,
      [
        op(target, { kind: "page.create", name: "Target", journalDay: null, createdAt: 1 }),
        op(src, { kind: "page.create", name: "Src", journalDay: null, createdAt: 1 }),
        op(block, {
          kind: "block.create",
          place: { pageId: src, parentId: null, order: "a0" },
          content: "see [[Target|the target]]",
          createdAt: 1,
        }),
        op(other, {
          kind: "block.create",
          place: { pageId: src, parentId: null, order: "a1" },
          content: "see [[Target]]",
          createdAt: 1,
        }),
      ],
      { origin: "user", actor: "test" },
    );
    // What a graph indexed before the fix looks like: the whole interior as the key, unresolved.
    ctx.driver.run(
      "UPDATE ref SET dst_page_key = 'target|the target', dst_page_id = NULL WHERE src_block_id = ?",
      [block],
    );

    expect(reindexPipeAliasRefs(ctx)).toBe(1);
    const rows = ctx.driver.all<{ dst_page_key: string; dst_page_id: string | null }>(
      "SELECT dst_page_key, dst_page_id FROM ref WHERE src_block_id = ?",
      [block],
    );
    expect(rows).toEqual([{ dst_page_key: "target", dst_page_id: target }]);
    expect(reindexPipeAliasRefs(ctx)).toBe(0);
  });

  /** Target, and a Src page linking to it by `[[Target|the target]]` with a child under the link;
   * then `path_ref` for Src's blocks (and, unless `refFixed`, `ref`) reset to the pre-fix keys. */
  async function preFixGraph(opts: { refFixed: boolean }) {
    const server = makeTestServer();
    await post(server.app, "/api/v1/page.create", server.writeToken, {
      name: "Target",
      markdown: "- t",
    });
    await post(server.app, "/api/v1/page.create", server.writeToken, {
      name: "Src",
      markdown: "- see [[Target|the target]]\n  - child",
    });
    const linked = async (): Promise<string[]> => {
      const r = await post(server.app, "/api/v1/page.backlinks", server.writeToken, {
        target: "Target",
      });
      expect(r.status).toBe(200);
      return r.json.linked.map((l: { text: string }) => l.text).sort();
    };
    expect(await linked()).toEqual(["child", "see [[Target|the target]]"]);

    const d = server.serverCtx.driver;
    if (!opts.refFixed) {
      d.run(
        "UPDATE ref SET dst_page_key = 'target|the target', dst_page_id = NULL WHERE dst_page_key = 'target'",
      );
    }
    // Only Src's rows: Target's own block keys its path on its own page, which the bug never touched.
    d.run(
      `UPDATE path_ref SET page_key = 'target|the target', page_id = NULL
        WHERE page_key = 'target' AND block_id IN
          (SELECT b.id FROM block b JOIN page p ON p.id = b.page_id WHERE p.key = 'src')`,
    );
    expect(await linked()).toEqual([]);
    return { server, linked };
  }

  it("rebuilds path_ref too, so the old links show in backlinks again, children included", async () => {
    const { server, linked } = await preFixGraph({ refFixed: false });
    expect(reindexPipeAliasRefs(server.serverCtx)).toBe(2); // the link block and its child
    expect(
      server.serverCtx.driver.all("SELECT block_id FROM path_ref WHERE page_key LIKE '%|%'"),
    ).toEqual([]);
    expect(await linked()).toEqual(["child", "see [[Target|the target]]"]);
  });

  it("runs again on a graph whose first re-index fixed ref but left path_ref stale", async () => {
    const { server, linked } = await preFixGraph({ refFixed: true });
    server.serverCtx.driver.run(
      "INSERT INTO setting(key, graph_id, value_json, updated_at, hlc) VALUES ('refs.pipe_alias', 'default', 'true', 1, 'x')",
    );
    expect(reindexPipeAliasRefs(server.serverCtx)).toBe(2);
    expect(await linked()).toEqual(["child", "see [[Target|the target]]"]);
    expect(reindexPipeAliasRefs(server.serverCtx)).toBe(0);
  });
});
