import { makeOp, newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { childLookup, LIVE_CHILDREN_SQL, TOMBSTONED_CHILDREN_SQL } from "./block-children.js";
import { openDb } from "./db.js";

let ctx: ServerContext;
beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function plan(sql: string, params: unknown[]): string {
  return ctx.driver
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
    .map((r) => r.detail)
    .join(" | ");
}

describe("childLookup (the subtree walks' child query)", () => {
  it("reads live children through the block_children index, never a table scan per parent", () => {
    // A bare `WHERE parent_id = ?` cannot use the partial index; it scanned the table once per
    // visited block and made reindexing a batch quadratic (F8, the note under B-85).
    expect(plan(LIVE_CHILDREN_SQL, ["x"])).toMatch(/USING INDEX block_children/);
    expect(plan("SELECT id FROM block WHERE parent_id = ?", ["x"])).toMatch(/SCAN block/);
    // The one scan is for tombstones, once per lookup.
    expect(plan(TOMBSTONED_CHILDREN_SQL, [])).toMatch(/SCAN block/);
  });

  it("returns live and tombstoned children together, in order", () => {
    const page = newId();
    const parent = newId();
    const [a, b, c] = [newId(), newId(), newId()];
    const hlc = () => ctx.hlc.next();
    const create = (id: string, parentId: string | null, order: string) =>
      makeOp(hlc(), "00000000", id, {
        kind: "block.create",
        place: { pageId: page, parentId, order },
        content: id,
        createdAt: 1,
      });
    serverApplyOps(
      ctx,
      [
        makeOp(hlc(), "00000000", page, {
          kind: "page.create",
          name: "P",
          journalDay: null,
          createdAt: 1,
        }),
        create(parent, null, "a0"),
        create(a, parent, "a0"),
        create(b, parent, "a1"),
        create(c, parent, "a2"),
      ],
      { origin: "api", actor: "t" },
    );
    serverApplyOps(ctx, [makeOp(hlc(), "00000000", b, { kind: "block.delete", deletedAt: 5 })], {
      origin: "api",
      actor: "t",
    });
    expect(childLookup(ctx.driver)(parent).map((r) => r.id)).toEqual([a, b, c]);
  });
});
