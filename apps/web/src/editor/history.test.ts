import { applyOps, initSchema, makeOp, type Op } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { describe, expect, it } from "vitest";
import { EditHistory } from "./history.js";
import { tree as buildTree, makeBlock, makeFakeClock } from "./test-helpers.js";

const clock = () => makeFakeClock();

describe("EditHistory — text coalescing (ADR 006: 500ms, document-level, crosses block boundaries)", () => {
  it("merges consecutive text edits on the same block within the window into one undo step", () => {
    const h = new EditHistory(500);
    const c = clock();

    const treeBeforeFirstKeystroke = buildTree(makeBlock({ id: "A", order: "a0", content: "h" }));
    const treeBeforeSecondKeystroke = buildTree(makeBlock({ id: "A", order: "a0", content: "he" }));
    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "he" },
        },
      ],
      treeBeforeFirstKeystroke,
      "text",
      { id: "A", caret: { offset: 1 } },
      { id: "A", caret: { offset: 2 } },
      "A",
      0,
    );
    h.record(
      [
        {
          id: "op2",
          hlc: "h2",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "hel" },
        },
      ],
      treeBeforeSecondKeystroke,
      "text",
      { id: "A", caret: { offset: 2 } },
      { id: "A", caret: { offset: 3 } },
      "A",
      100, // within the 500ms window opened by the first push
    );

    expect(h.depths()).toEqual({ undo: 1, redo: 0 });

    const undo = h.undo(c);
    // The merged step's inverse must restore all the way back to "h" (before the FIRST keystroke),
    // not just back to "he" (the intermediate state) — that's the point of coalescing.
    expect(undo?.ops).toEqual([
      expect.objectContaining({ entity: "A", payload: { kind: "block.text", content: "h" } }),
    ]);
    expect(undo?.focus).toEqual({ id: "A", caret: { offset: 1 } });

    const redo = h.redo(c);
    // Redo reproduces the LATEST forward state ("hel"), not the intermediate "he".
    expect(redo?.ops).toEqual([
      expect.objectContaining({ entity: "A", payload: { kind: "block.text", content: "hel" } }),
    ]);
    expect(redo?.focus).toEqual({ id: "A", caret: { offset: 3 } });
  });

  it("does NOT merge across a structural command, even inside the coalescing window", () => {
    const h = new EditHistory(500);
    const treeA = buildTree(makeBlock({ id: "A", order: "a0", content: "h" }));

    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "he" },
        },
      ],
      treeA,
      "text",
      { id: "A", caret: { offset: 1 } },
      { id: "A", caret: { offset: 2 } },
      "A",
      0,
    );
    h.stopCapturing(); // the editor calls this before running any structural command (ADR 006 §7)
    h.record(
      [
        {
          id: "op2",
          hlc: "h2",
          device: "d",
          entity: "B",
          payload: { kind: "block.place", place: { pageId: "page1", parentId: "A", order: "m0" } },
        },
      ],
      buildTree(
        makeBlock({ id: "A", order: "a0", content: "he" }),
        makeBlock({ id: "B", order: "b0", content: "" }),
      ),
      "structure",
      null,
      null,
      null,
      100,
    );

    expect(h.depths()).toEqual({ undo: 2, redo: 0 });
  });

  it("undo/redo cross block boundaries: undoing an indent-then-type sequence undoes typing, then the indent", () => {
    const h = new EditHistory(500);
    const c = clock();

    // 1. Indent B under A (structural).
    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "B",
          payload: { kind: "block.place", place: { pageId: "page1", parentId: "A", order: "m0" } },
        },
      ],
      buildTree(makeBlock({ id: "A", order: "a0" }), makeBlock({ id: "B", order: "b0" })),
      "structure",
      { id: "B", caret: { at: "end" } },
      { id: "B", caret: { at: "end" } },
      null,
      0,
    );
    h.stopCapturing();

    // 2. Type into B (text).
    h.record(
      [
        {
          id: "op2",
          hlc: "h2",
          device: "d",
          entity: "B",
          payload: { kind: "block.text", content: "typed" },
        },
      ],
      buildTree(
        makeBlock({ id: "A", order: "a0" }),
        makeBlock({ id: "B", order: "m0", parentId: "A", content: "" }),
      ),
      "text",
      { id: "B", caret: { offset: 0 } },
      { id: "B", caret: { offset: 5 } },
      "B",
      1000,
    );

    const firstUndo = h.undo(c);
    expect(firstUndo?.ops[0]).toMatchObject({
      entity: "B",
      payload: { kind: "block.text", content: "" },
    });

    const secondUndo = h.undo(c);
    expect(secondUndo?.ops[0]).toMatchObject({
      entity: "B",
      payload: { kind: "block.place", place: { parentId: null } },
    });

    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
  });

  it("a new edit clears the redo stack", () => {
    const h = new EditHistory(500);
    const t = buildTree(makeBlock({ id: "A", order: "a0", content: "h" }));
    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "he" },
        },
      ],
      t,
      "text",
      null,
      null,
      "A",
      0,
    );
    h.undo(clock());
    expect(h.canRedo()).toBe(true);
    h.record(
      [
        {
          id: "op2",
          hlc: "h2",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "ha" },
        },
      ],
      t,
      "text",
      null,
      null,
      "A",
      10_000, // well outside any coalescing window
    );
    expect(h.canRedo()).toBe(false);
  });

  it("undo/redo mint FRESH ops each time (never replay the same hlc twice)", () => {
    const h = new EditHistory(500);
    const c = clock();
    const t = buildTree(makeBlock({ id: "A", order: "a0", content: "h" }));
    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "he" },
        },
      ],
      t,
      "text",
      null,
      null,
      "A",
      0,
    );
    const undo1 = h.undo(c);
    const redo1 = h.redo(c);
    const undo2 = h.undo(c);
    // Every mint must carry a distinct hlc/id — otherwise `applyOps`'s idempotence would make the
    // second undo/redo of the same transaction silently do nothing.
    const ids = [undo1?.ops[0]?.id, redo1?.ops[0]?.id, undo2?.ops[0]?.id];
    expect(new Set(ids).size).toBe(3);
    // ...but the payload content is identical each time (same logical effect).
    expect(undo1?.ops[0]?.payload).toEqual(undo2?.ops[0]?.payload);
  });
});

describe("EditHistory — block.create / block.delete invert to each other", () => {
  it("undoing a split (block.create) deletes the new block; redoing revives it", () => {
    const h = new EditHistory(500);
    const c = clock();
    const treeBefore = buildTree(makeBlock({ id: "A", order: "a0", content: "hello world" }));
    h.record(
      [
        {
          id: "op1",
          hlc: "h1",
          device: "d",
          entity: "A",
          payload: { kind: "block.text", content: "hello" },
        },
        {
          id: "op2",
          hlc: "h2",
          device: "d",
          entity: "NEW",
          payload: {
            kind: "block.create",
            place: { pageId: "page1", parentId: null, order: "b0" },
            content: " world",
            createdAt: 1000,
          },
        },
      ],
      treeBefore,
      "structure",
      { id: "A", caret: { offset: 5 } },
      { id: "NEW", caret: { at: "start" } },
      null,
      0,
    );

    const undo = h.undo(c);
    // Reverse order: NEW's create inverts to a delete, THEN A's text reverts to "hello world".
    expect(undo?.ops[0]).toMatchObject({ entity: "NEW", payload: { kind: "block.delete" } });
    expect(undo?.ops[1]).toMatchObject({
      entity: "A",
      payload: { kind: "block.text", content: "hello world" },
    });

    const redo = h.redo(c);
    // Revives the tombstone rather than re-sending the create, which `applyOps` would ignore
    // because the id already exists (B-240; the round trip below proves it against real SQLite).
    expect(redo?.ops[1]).toMatchObject({
      entity: "NEW",
      payload: { kind: "block.delete", deletedAt: null },
    });
  });

  it("create -> undo -> redo leaves the block alive in a real database, every time (B-240)", () => {
    const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
    initSchema(driver);
    const c = clock();
    const apply = (ops: readonly Op[]): string[] =>
      applyOps(driver, ops).results.map((r) => r.status);
    const alive = (id: string): boolean =>
      driver.get<{ deleted_at: number | null }>("SELECT deleted_at FROM block WHERE id = ?", [id])
        ?.deleted_at === null;

    apply([
      makeOp(c.next(), c.device, "page1", {
        kind: "page.create",
        name: "Redo Round Trip",
        journalDay: null,
        createdAt: 1,
      }),
    ]);
    const create = makeOp(c.next(), c.device, "NEW", {
      kind: "block.create",
      place: { pageId: "page1", parentId: null, order: "a0" },
      content: "",
      createdAt: 2,
    });
    expect(apply([create])).toEqual(["applied"]);
    const h = new EditHistory(500);
    h.record([create], buildTree(), "structure", null, { id: "NEW", caret: { at: "start" } });

    // Twice: the second cycle is where replaying a stored op (rather than minting) would also fail.
    for (let i = 0; i < 2; i++) {
      expect(apply(h.undo(c)?.ops ?? [])).toEqual(["applied"]);
      expect(alive("NEW")).toBe(false);
      expect(apply(h.redo(c)?.ops ?? [])).toEqual(["applied"]);
      expect(alive("NEW")).toBe(true);
    }
  });
});
