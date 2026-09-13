import { newId, type Op } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { reindexPipeAliasRefs } from "./ref-reindex.js";

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
});
