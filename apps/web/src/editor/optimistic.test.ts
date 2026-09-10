import { describe, expect, it } from "vitest";
import { applyOptimistic } from "./optimistic.js";
import { makeBlock } from "./test-helpers.js";

describe("applyOptimistic", () => {
  it("applies create/place/text/prop immediately", () => {
    const blocks = [makeBlock({ id: "A", order: "a0", content: "hi" })];
    const cache = new Map();
    const out = applyOptimistic(
      blocks,
      [
        { entity: "A", payload: { kind: "block.text", content: "hello" } },
        {
          entity: "NEW",
          payload: {
            kind: "block.create",
            place: { parentId: "A", order: "m0" },
            content: "child",
          },
        },
        { entity: "A", payload: { kind: "block.prop", key: "collapsed", value: "true" } },
      ],
      cache,
    );
    const a = out.find((b) => b.id === "A");
    const n = out.find((b) => b.id === "NEW");
    expect(a?.content).toBe("hello");
    expect(a?.collapsed).toBe(true);
    expect(n?.parentId).toBe("A");
    expect(n?.content).toBe("child");
  });

  it("restores a deleted block's full data on undelete via the cache", () => {
    const blocks = [makeBlock({ id: "A", order: "a0", content: "keep me", marker: "TODO" })];
    const cache = new Map();
    const afterDelete = applyOptimistic(
      blocks,
      [{ entity: "A", payload: { kind: "block.delete", deletedAt: 1000 } }],
      cache,
    );
    expect(afterDelete.find((b) => b.id === "A")).toBeUndefined();
    expect(cache.has("A")).toBe(true);

    const afterUndelete = applyOptimistic(
      afterDelete,
      [{ entity: "A", payload: { kind: "block.delete", deletedAt: null } }],
      cache,
    );
    const revived = afterUndelete.find((b) => b.id === "A");
    expect(revived?.content).toBe("keep me");
    expect(revived?.marker).toBe("TODO");
  });
});
