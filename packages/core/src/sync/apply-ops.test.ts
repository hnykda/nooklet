import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "../hlc.js";
import { newId } from "../ids.js";
import type { Op } from "../ops.js";
import { makeOp } from "../ops.js";
import { applyOps, rebuild } from "./apply-ops.js";
import type { SqlDriver } from "./driver.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";
import { getBlock, getPage, listBlockProps, listChildren } from "./queries.js";
import { initSchema } from "./schema.js";

function newDb(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const driver = createNodeSqliteDriver(db);
  initSchema(driver);
  return driver;
}

/** Deterministic HLC string, no clock needed. */
function hlcAt(wall: number, device: string, counter = 0): string {
  return formatHlc({ wall, counter, device });
}

const DEV_A = "aaaaaaaa";
const DEV_B = "bbbbbbbb";
const BASE = Date.UTC(2026, 8, 10, 12, 0, 0);

let driver: SqlDriver;

beforeEach(() => {
  driver = newDb();
});

// -------------------------------------------------------------------------------------------
// page.*
// -------------------------------------------------------------------------------------------

describe("page.create / rename / prop / delete", () => {
  it("creates a page and applies its inline properties", () => {
    const id = newId();
    const hlc = hlcAt(BASE, DEV_A);
    const res = applyOps(driver, [
      makeOp(hlc, DEV_A, id, {
        kind: "page.create",
        name: "Projects/Nooklet",
        journalDay: null,
        properties: { area: "writing" },
        createdAt: BASE,
      }),
    ]);
    expect(res.applied).toBe(1);
    const page = getPage(driver, id);
    expect(page?.name).toBe("Projects/Nooklet");
    expect(page?.key).toBe("projects/nooklet");
  });

  it("stores a journal page under its ISO name whatever name the op proposed (ADR 018)", () => {
    const id = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, id, {
        kind: "page.create",
        // What a client written before ADR 018 — or an importer reading a Logseq graph — sends.
        name: "Mon, 07.09.2026",
        journalDay: 20260907,
        createdAt: BASE,
      }),
    ]);
    const page = getPage(driver, id);
    expect(page?.name).toBe("2026-09-07");
    expect(page?.key).toBe("2026-09-07");
  });

  it("renaming a journal page lands on the ISO name, not the one asked for", () => {
    // Which is what lets the one-time migration do its work through ordinary rename ops, and what
    // stops a display format becoming data again by way of the title editor.
    const id = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, id, {
        kind: "page.create",
        name: "Mon, 07.09.2026",
        journalDay: 20260907,
        createdAt: BASE,
      }),
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, id, { kind: "page.rename", name: "My Favourite Day" }),
    ]);
    expect(getPage(driver, id)?.name).toBe("2026-09-07");
  });

  it("leaves an ordinary page whose name looks like a date exactly as named", () => {
    // `journal_day` is the fact, not the shape of the string: a page someone deliberately called
    // "11.12.2024" is theirs to name.
    const id = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, id, {
        kind: "page.create",
        name: "11.12.2024",
        journalDay: null,
        createdAt: BASE,
      }),
    ]);
    expect(getPage(driver, id)?.name).toBe("11.12.2024");
  });

  it("rejects a create that collides with a live page of the same key under a different id", () => {
    const id1 = newId();
    const id2 = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, id1, {
        kind: "page.create",
        name: "Nooklet",
        journalDay: null,
        createdAt: BASE,
      }),
    ]);
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_B), DEV_B, id2, {
        kind: "page.create",
        name: "nooklet", // same normalized key
        journalDay: null,
        createdAt: BASE + 1,
      }),
    ]);
    expect(res.rejected).toBe(1);
    expect(getPage(driver, id2)).toBeUndefined();
  });

  it("rename is stale-op-is-noop LWW, and also checks the collision", () => {
    const id = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, id, {
        kind: "page.create",
        name: "Old Name",
        journalDay: null,
        createdAt: BASE,
      }),
    ]);
    // stale rename (older hlc than the create's name_hlc) is a no-op
    const stale = applyOps(driver, [
      makeOp(hlcAt(BASE - 1, DEV_A), DEV_A, id, { kind: "page.rename", name: "Stale Name" }),
    ]);
    expect(stale.noop).toBe(1);
    expect(getPage(driver, id)?.name).toBe("Old Name");

    // fresh rename applies
    const fresh = applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, id, { kind: "page.rename", name: "New Name" }),
    ]);
    expect(fresh.applied).toBe(1);
    expect(getPage(driver, id)?.name).toBe("New Name");
  });

  it("page.delete/restore is LWW on deleted_at, does not touch blocks", () => {
    const pageId = newId();
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, pageId, {
        kind: "page.create",
        name: "P",
        journalDay: null,
        createdAt: BASE,
      }),
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "hello",
        createdAt: BASE + 1,
      }),
    ]);
    applyOps(driver, [
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, pageId, { kind: "page.delete", deletedAt: BASE + 2 }),
    ]);
    expect(getPage(driver, pageId)?.deletedAt).toBe(BASE + 2);
    expect(getBlock(driver, blockId)?.deletedAt).toBeNull(); // never cascaded

    applyOps(driver, [
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, pageId, { kind: "page.delete", deletedAt: null }),
    ]);
    expect(getPage(driver, pageId)?.deletedAt).toBeNull();
  });

  it("rejects an un-delete whose name a live page has taken meanwhile (B-90)", () => {
    const oldId = newId();
    const newId2 = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, oldId, {
        kind: "page.create",
        name: "Dup",
        journalDay: null,
        createdAt: BASE,
      }),
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, oldId, { kind: "page.delete", deletedAt: BASE + 1 }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, newId2, {
        kind: "page.create",
        name: "dup", // same key, different case
        journalDay: null,
        createdAt: BASE + 2,
      }),
    ]);
    // The un-delete (an undo, or a late-syncing device) must not blow up the transaction on the
    // unique index; it must be rejected like a colliding create or rename, and change nothing.
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 3, DEV_B), DEV_B, oldId, { kind: "page.delete", deletedAt: null }),
    ]);
    expect(res.rejected).toBe(1);
    expect(res.applied).toBe(0);
    expect(getPage(driver, oldId)?.deletedAt).toBe(BASE + 1);
    expect(getPage(driver, newId2)?.deletedAt).toBeNull();
    // A restore under a fresh name is the sanctioned way out: rename the tombstoned page first.
    const out = applyOps(driver, [
      makeOp(hlcAt(BASE + 4, DEV_B), DEV_B, oldId, { kind: "page.rename", name: "Dup (restored)" }),
      makeOp(hlcAt(BASE + 5, DEV_B), DEV_B, oldId, { kind: "page.delete", deletedAt: null }),
    ]);
    expect(out.applied).toBe(2);
    expect(getPage(driver, oldId)?.deletedAt).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// block.create / block.place / cycle rejection
// -------------------------------------------------------------------------------------------

function createPage(hlc: string, device: string): string {
  const id = newId();
  applyOps(driver, [
    makeOp(hlc, device, id, { kind: "page.create", name: id, journalDay: null, createdAt: BASE }),
  ]);
  return id;
}

describe("block.create placement + reserved properties", () => {
  it("routes reserved keys to dedicated columns, not block_prop", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "TODO ship it",
        marker: "TODO",
        properties: { scheduled: "2026-09-12", area: "writing" },
        createdAt: BASE + 1,
      }),
    ]);
    const block = getBlock(driver, blockId);
    expect(block?.marker).toBe("TODO");
    expect(block?.scheduledDay).toBe(20260912);
    expect(block?.dueDay).toBe(20260912);
    const props = listBlockProps(driver, blockId);
    expect(props).toEqual([{ key: "area", value: "writing", hlc: expect.any(String) }]);
  });

  it("marker/priority/collapsed in the properties bag land in their columns (B-89)", () => {
    // The row INSERT stamps marker_hlc/priority_hlc/collapsed_hlc with the create's own HLC, and
    // the bag used to go through the LWW writer afterwards — which refuses a write whose HLC ties
    // the column's. So these three keys, and only these, vanished from a bag (`scheduled` worked).
    const pageId = newId();
    const blockId = newId();
    const ops = [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, pageId, {
        kind: "page.create",
        name: "B-89",
        journalDay: null,
        createdAt: BASE,
      }),
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "ship it",
        properties: { marker: "TODO", priority: "A", collapsed: "true", area: "writing" },
        createdAt: BASE + 1,
      }),
    ];
    const res = applyOps(driver, ops);
    expect(res.applied).toBe(2);
    const block = getBlock(driver, blockId);
    expect(block?.marker).toBe("TODO");
    expect(block?.priority).toBe("A");
    expect(block?.collapsed).toBe(true);
    // Reserved keys never leak into block_prop (rule 4); the ordinary key still does.
    expect(listBlockProps(driver, blockId)).toEqual([
      { key: "area", value: "writing", hlc: expect.any(String) },
    ]);
    // A replay of the same op on another device lands on the same row (what `verify` compares).
    const other = newDb();
    rebuild(other, ops);
    expect(getBlock(other, blockId)).toEqual(block);
  });

  it("a set top-level field wins over the bag; an unset one takes the bag's value (B-89)", () => {
    // Core producers (templates, outline import) always send `marker: null` / `collapsed: false`
    // next to a bag, so "unset" has to mean null/false, not only "key absent" — otherwise their
    // explicit defaults would shadow a bag value exactly the way the HLC tie used to.
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        marker: "DOING",
        priority: null,
        collapsed: false,
        properties: { marker: "TODO", priority: "A", collapsed: "true" },
        createdAt: BASE + 1,
      }),
    ]);
    const block = getBlock(driver, blockId);
    expect([block?.marker, block?.priority, block?.collapsed]).toEqual(["DOING", "A", true]);
  });

  it("an invalid reserved value in the bag is dropped, the block is still created (B-89)", () => {
    // Same contract as every other bag key: an invalid inline property is not written, but it
    // does not fail the create. Only a top-level marker/priority rejects outright.
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        properties: { marker: "SOMEDAY", priority: "Z" },
        createdAt: BASE + 1,
      }),
    ]);
    expect(res.applied).toBe(1);
    const block = getBlock(driver, blockId);
    expect(block?.marker).toBeNull();
    expect(block?.priority).toBeNull();
    expect(listBlockProps(driver, blockId)).toEqual([]);
  });

  it("falls back an invalid/missing parent to top-level and logs the corrected place", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: "nonexistent00", order: "a0" },
        content: "orphan",
        createdAt: BASE + 1,
      }),
    ]);
    expect(getBlock(driver, blockId)?.parentId).toBeNull();
    const logged = driver.get<{ payload_json: string }>(
      "SELECT payload_json FROM op WHERE entity = ?",
      [blockId],
    );
    expect(logged).toBeDefined();
    expect(JSON.parse(logged?.payload_json ?? "{}").place.parentId).toBeNull();
  });
});

describe("block.place cycle rejection", () => {
  function chain(pageId: string): { a: string; b: string; c: string } {
    const a = newId();
    const b = newId();
    const c = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, a, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "a",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, b, {
        kind: "block.create",
        place: { pageId, parentId: a, order: "a0" },
        content: "b",
        createdAt: BASE + 2,
      }),
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, c, {
        kind: "block.create",
        place: { pageId, parentId: b, order: "a0" },
        content: "c",
        createdAt: BASE + 3,
      }),
    ]);
    return { a, b, c };
  }

  it("rejects moving an ancestor under its own descendant", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const { a, c } = chain(pageId);
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, a, {
        kind: "block.place",
        place: { pageId, parentId: c, order: "a0" },
      }),
    ]);
    expect(res.rejected).toBe(1);
    expect(res.results[0]?.reason).toBe("cycle");
    expect(getBlock(driver, a)?.parentId).toBeNull(); // unchanged
  });

  it("rejects a block becoming its own parent", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const { a } = chain(pageId);
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, a, {
        kind: "block.place",
        place: { pageId, parentId: a, order: "a0" },
      }),
    ]);
    expect(res.rejected).toBe(1);
  });

  it("a non-cycle-creating move still applies normally", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const { a, b, c } = chain(pageId);
    const res = applyOps(driver, [
      makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, c, {
        kind: "block.place",
        place: { pageId, parentId: a, order: "a0" },
      }),
    ]);
    expect(res.applied).toBe(1);
    expect(getBlock(driver, c)?.parentId).toBe(a);
    expect(getBlock(driver, b)?.parentId).toBe(a); // untouched
  });
});

// -------------------------------------------------------------------------------------------
// block.text / block.prop LWW + validation
// -------------------------------------------------------------------------------------------

describe("property LWW", () => {
  it("a stale block.prop op is a no-op (test case 1 from sql-schema.md)", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        createdAt: BASE + 1,
      }),
    ]);
    applyOps(driver, [
      makeOp(hlcAt(BASE + 5, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "marker",
        value: "DONE",
      }),
    ]);
    const stale = applyOps(driver, [
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "marker",
        value: "TODO",
      }),
    ]);
    expect(stale.noop).toBe(1);
    expect(getBlock(driver, blockId)?.marker).toBe("DONE");
  });

  it("rejects invalid reserved values without touching state", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        createdAt: BASE + 1,
      }),
    ]);
    const badMarker = applyOps(driver, [
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "marker",
        value: "NOPE",
      }),
    ]);
    expect(badMarker.rejected).toBe(1);
    const badSched = applyOps(driver, [
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "scheduled",
        value: "not-a-date",
      }),
    ]);
    expect(badSched.rejected).toBe(1);
    const idKey = applyOps(driver, [
      makeOp(hlcAt(BASE + 4, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "id",
        value: "whatever",
      }),
    ]);
    expect(idKey.rejected).toBe(1);
    expect(getBlock(driver, blockId)?.marker).toBeNull();
  });

  it("parses scheduled with a time component and clears it via null", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        createdAt: BASE + 1,
      }),
    ]);
    applyOps(driver, [
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "scheduled",
        value: "2026-09-12 14:30",
      }),
    ]);
    let b = getBlock(driver, blockId);
    expect(b?.scheduledDay).toBe(20260912);
    expect(b?.scheduledTime).toBe("14:30");

    applyOps(driver, [
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "scheduled",
        value: null,
      }),
    ]);
    b = getBlock(driver, blockId);
    expect(b?.scheduledDay).toBeNull();
    expect(b?.scheduledTime).toBeNull();
  });

  it("collapsed follows the outline.ts wire convention (only literal 'true' is truthy)", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "x",
        createdAt: BASE + 1,
      }),
    ]);
    applyOps(driver, [
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, blockId, {
        kind: "block.prop",
        key: "collapsed",
        value: "true",
      }),
    ]);
    expect(getBlock(driver, blockId)?.collapsed).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Tricky cases explicitly called out by sql-schema.md / ADR 003
// -------------------------------------------------------------------------------------------

describe("tricky sync cases", () => {
  it("concurrent move-and-reorder of the same block: higher HLC wins atomically, order-independent", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const parentX = newId();
    const parentY = newId();
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, parentX, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "X",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, parentY, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a1" },
        content: "Y",
        createdAt: BASE + 2,
      }),
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: parentX, order: "a0" },
        content: "moved",
        createdAt: BASE + 3,
      }),
    ]);
    const reorder = makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, blockId, {
      kind: "block.place",
      place: { pageId, parentId: parentX, order: "z0" }, // same parent, new order
    });
    const move = makeOp(hlcAt(BASE + 20, DEV_B), DEV_B, blockId, {
      kind: "block.place",
      place: { pageId, parentId: parentY, order: "m0" }, // different parent
    });

    for (const order of [
      [reorder, move],
      [move, reorder],
    ]) {
      const d = newDb();
      applyOps(d, [
        makeOp(hlcAt(BASE, DEV_A), DEV_A, pageId, {
          kind: "page.create",
          name: pageId,
          journalDay: null,
          createdAt: BASE,
        }),
        makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, parentX, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "X",
          createdAt: BASE + 1,
        }),
        makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, parentY, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a1" },
          content: "Y",
          createdAt: BASE + 2,
        }),
        makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, blockId, {
          kind: "block.create",
          place: { pageId, parentId: parentX, order: "a0" },
          content: "moved",
          createdAt: BASE + 3,
        }),
      ]);
      applyOps(d, order);
      const final = getBlock(d, blockId);
      // move (higher hlc) must win entirely: parent AND order from `move`, never a mix.
      expect(final?.parentId).toBe(parentY);
      expect(final?.order).toBe("m0");
    }
  });

  it("delete-vs-move: the block survives, tombstoned, at its new location", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const parentY = newId();
    const blockId = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, parentY, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "Y",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a1" },
        content: "moved-and-deleted",
        createdAt: BASE + 2,
      }),
    ]);
    // concurrent: device A deletes it, device B moves it under Y
    const del = makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, blockId, {
      kind: "block.delete",
      deletedAt: BASE + 10,
    });
    const move = makeOp(hlcAt(BASE + 11, DEV_B), DEV_B, blockId, {
      kind: "block.place",
      place: { pageId, parentId: parentY, order: "z0" },
    });
    applyOps(driver, [del, move]);
    const final = getBlock(driver, blockId);
    expect(final?.deletedAt).toBe(BASE + 10);
    expect(final?.parentId).toBe(parentY);
    expect(final?.order).toBe("z0");
  });

  it("delete-ancestor-with-live-descendant: descendant stays attached; restoring the ancestor restores visibility", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const parent = newId();
    const child = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, parent, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "parent",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, child, {
        kind: "block.create",
        place: { pageId, parentId: parent, order: "a0" },
        content: "child",
        createdAt: BASE + 2,
      }),
    ]);
    applyOps(driver, [
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, parent, { kind: "block.delete", deletedAt: BASE + 3 }),
    ]);
    let c = getBlock(driver, child);
    expect(c?.deletedAt).toBeNull();
    expect(c?.parentId).toBe(parent); // still attached, no cascade

    applyOps(driver, [
      makeOp(hlcAt(BASE + 4, DEV_A), DEV_A, parent, { kind: "block.delete", deletedAt: null }),
    ]);
    expect(getBlock(driver, parent)?.deletedAt).toBeNull();
    c = getBlock(driver, child);
    expect(c?.deletedAt).toBeNull();
    expect(c?.parentId).toBe(parent);
  });

  it("concurrent inserts between the same two siblings tie-break by block id", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const x = newId();
    const y = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, x, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "X",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, y, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a2" },
        content: "Y",
        createdAt: BASE + 2,
      }),
    ]);
    const m1 = newId();
    const m2 = newId();
    // Both devices independently insert "between X and Y": generateKeyBetween(a0, a2) is a pure
    // function of its two arguments, so both concurrent inserts land on the *same* order_key.
    const betweenOrder = "a1"; // fractional-indexing's actual output for ("a0","a2")
    applyOps(driver, [
      makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, m1, {
        kind: "block.create",
        place: { pageId, parentId: null, order: betweenOrder },
        content: "M1",
        createdAt: BASE + 10,
      }),
      makeOp(hlcAt(BASE + 11, DEV_B), DEV_B, m2, {
        kind: "block.create",
        place: { pageId, parentId: null, order: betweenOrder },
        content: "M2",
        createdAt: BASE + 11,
      }),
    ]);
    const children = listChildren(driver, pageId, null);
    expect(children.map((b) => b.id)).toEqual([x, ...[m1, m2].sort(), y]);
  });

  it("concurrent cross-device cycle-creating moves: naive incremental merge diverges, HLC-canonical rebuild converges", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const a = newId();
    const b = newId();
    applyOps(driver, [
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, a, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "A",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_A), DEV_A, b, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a1" },
        content: "B",
        createdAt: BASE + 2,
      }),
    ]);
    // Common ancestry both devices start from.
    const baseOps = driver.all<{
      payload_json: string;
      hlc: string;
      device_id: string;
      kind: string;
      entity: string;
    }>("SELECT * FROM op ORDER BY seq");
    const op1 = makeOp(hlcAt(BASE + 10, DEV_A), DEV_A, a, {
      kind: "block.place",
      place: { pageId, parentId: b, order: "a0" },
    }); // A under B
    const op2 = makeOp(hlcAt(BASE + 20, DEV_B), DEV_B, b, {
      kind: "block.place",
      place: { pageId, parentId: a, order: "a0" },
    }); // B under A, concurrently, on a device that has not seen op1 yet

    // Naive incremental merge: each device applies only the op it didn't already have, one at a
    // time, in receipt order -> they DIVERGE (this is exactly why ADR 003 needs a real server).
    const dev1 = newDb();
    replay(dev1, baseOps);
    applyOps(dev1, [op1]); // local
    applyOps(dev1, [op2]); // received later, against dev1's already-updated state

    const dev2 = newDb();
    replay(dev2, baseOps);
    applyOps(dev2, [op2]); // local
    applyOps(dev2, [op1]); // received later, against dev2's already-updated state

    expect(getBlock(dev1, a)?.parentId).not.toBe(getBlock(dev2, a)?.parentId); // diverged

    // HLC-canonical rebuild (this package's substitute for server arrival order, see file header
    // in apply-ops.ts): replay the *same set* of ops through `rebuild`, sorted by HLC, on both
    // devices -> deterministically converges, and the winner is the same everywhere.
    const allOps = [...baseOps.map(rowToOp), op1, op2];
    const r1 = newDb();
    rebuild(r1, allOps);
    const r2 = newDb();
    rebuild(r2, allOps);
    expect(getBlock(r1, a)).toEqual(getBlock(r2, a));
    expect(getBlock(r1, b)).toEqual(getBlock(r2, b));
    // op1 (earlier hlc) applies; op2 (later hlc) is rejected as a cycle against op1's result.
    expect(getBlock(r1, a)?.parentId).toBe(b);
    expect(getBlock(r1, b)?.parentId).toBeNull();
  });
});

function rowToOp(row: {
  payload_json: string;
  hlc: string;
  device_id: string;
  entity: string;
}): Op {
  return makeOp(row.hlc, row.device_id, row.entity, JSON.parse(row.payload_json));
}

function replay(
  d: SqlDriver,
  rows: Array<{ payload_json: string; hlc: string; device_id: string; entity: string }>,
): void {
  applyOps(d, rows.map(rowToOp));
}

// -------------------------------------------------------------------------------------------
// rebuild()
// -------------------------------------------------------------------------------------------

describe("rebuild", () => {
  it("reproduces live state regardless of the input array's order, and is idempotent", () => {
    const pageId = newId();
    const a = newId();
    const b = newId();
    const ops: Op[] = [
      makeOp(hlcAt(BASE, DEV_A), DEV_A, pageId, {
        kind: "page.create",
        name: "P",
        journalDay: null,
        createdAt: BASE,
      }),
      makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, a, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "a",
        createdAt: BASE + 1,
      }),
      makeOp(hlcAt(BASE + 2, DEV_B), DEV_B, b, {
        kind: "block.create",
        place: { pageId, parentId: a, order: "a0" },
        content: "b",
        createdAt: BASE + 2,
      }),
      makeOp(hlcAt(BASE + 3, DEV_A), DEV_A, a, { kind: "block.text", content: "a edited" }),
      makeOp(hlcAt(BASE + 4, DEV_B), DEV_B, b, { kind: "block.prop", key: "area", value: "x" }),
    ];

    const live = newDb();
    applyOps(live, ops);

    const scrambled = [ops[4], ops[0], ops[2], ops[1], ops[3]] as Op[];
    const rebuilt = newDb();
    rebuild(rebuilt, scrambled);

    expect(getPage(rebuilt, pageId)).toEqual(getPage(live, pageId));
    expect(getBlock(rebuilt, a)).toEqual(getBlock(live, a));
    expect(getBlock(rebuilt, b)).toEqual(getBlock(live, b));
    expect(listBlockProps(rebuilt, b)).toEqual(listBlockProps(live, b));
  });

  it("applyOps skips an op id it has already recorded (idempotent replay)", () => {
    const pageId = createPage(hlcAt(BASE, DEV_A), DEV_A);
    const blockId = newId();
    const createOp = makeOp(hlcAt(BASE + 1, DEV_A), DEV_A, blockId, {
      kind: "block.create",
      place: { pageId, parentId: null, order: "a0" },
      content: "x",
      createdAt: BASE + 1,
    });
    const first = applyOps(driver, [createOp]);
    expect(first.applied).toBe(1);
    const replayed = applyOps(driver, [createOp]);
    expect(replayed.results[0]?.reason).toBe("already-recorded");
    const count = driver.get<{ n: number }>("SELECT count(*) as n FROM op WHERE id = ?", [
      createOp.id,
    ]);
    expect(count?.n).toBe(1);
  });
});
