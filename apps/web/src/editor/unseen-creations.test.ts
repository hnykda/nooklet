import type { OpPayload } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { UnseenCreations } from "./unseen-creations.js";

const create = (entity: string): { entity: string; payload: OpPayload } => ({
  entity,
  payload: {
    kind: "block.create",
    place: { pageId: "p", parentId: null, order: "a0" },
    content: "",
    createdAt: 1,
  },
});

describe("UnseenCreations (B-88)", () => {
  it("a block created here is unseen until a refetch returns it", () => {
    const u = new UnseenCreations();
    u.note([create("new")]);
    expect(u.has("new")).toBe(true);
    // A stale refetch that read before the write: still unseen, so the tree keeps the row.
    u.seen(["other"]);
    expect(u.has("new")).toBe(true);
    u.seen(["other", "new"]);
    expect(u.has("new")).toBe(false);
  });

  it("a block loaded from the database was never unseen — its absence later means it left", () => {
    const u = new UnseenCreations();
    u.seen(["loaded"]);
    expect(u.has("loaded")).toBe(false);
  });

  it("reviving a block (an undone delete, a redone create) makes it unseen again", () => {
    const u = new UnseenCreations();
    u.seen(["b"]);
    u.note([{ entity: "b", payload: { kind: "block.delete", deletedAt: null } }]);
    expect(u.has("b")).toBe(true);
  });

  it("text, place, prop and tombstone ops create nothing", () => {
    const u = new UnseenCreations();
    u.note([
      { entity: "t", payload: { kind: "block.text", content: "x" } },
      {
        entity: "m",
        payload: { kind: "block.place", place: { pageId: "p", parentId: null, order: "a" } },
      },
      { entity: "k", payload: { kind: "block.prop", key: "marker", value: "TODO" } },
      { entity: "d", payload: { kind: "block.delete", deletedAt: 5 } },
    ]);
    for (const id of ["t", "m", "k", "d"]) expect(u.has(id)).toBe(false);
  });
});
