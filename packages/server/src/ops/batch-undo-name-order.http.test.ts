/**
 * B-370: `batch.undo` of one batch that renamed page A to B and then created a new A. The undo
 * wrote the rename back to A before it deleted the new A, core rejected the rename
 * (`page-key-collision`), and the call answered 400 with nothing written. A name has to be freed
 * before it is claimed again — whatever order the batch touched the pages in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function op(name: string, body: unknown): Promise<{ status: number; json: JsonAny }> {
  return post(s.app, `/api/v1/${name}`, s.writeToken, body);
}

async function ok(name: string, body: unknown): Promise<JsonAny> {
  const res = await op(name, body);
  if (res.status !== 200) throw new Error(`${name} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Live pages by name, with their blocks' text. */
function livePages(): Record<string, string[]> {
  const rows = s.serverCtx.driver.all<{ name: string; content: string | null }>(
    `SELECT p.name AS name, b.content AS content FROM page p
     LEFT JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
     WHERE p.deleted_at IS NULL ORDER BY p.name, b.content`,
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    out[r.name] ??= [];
    if (r.content !== null) out[r.name]?.push(r.content);
  }
  return out;
}

describe("batch.undo frees a page name before it claims it (B-370)", () => {
  it("undoes a rename of A to B plus a new A, and undoing the undo redoes both", async () => {
    await ok("page.create", { name: "Swap A", markdown: "- original" });
    const batch = await ok("batch", {
      ops: [
        { op: "page.update", page: "Swap A", new_name: "Swap B", keep_alias: false },
        { op: "page.create", name: "Swap A", markdown: "- replacement" },
      ],
    });
    expect(livePages()).toEqual({ "Swap A": ["replacement"], "Swap B": ["original"] });

    const dry = await op("batch.undo", { batch_id: batch.batch_id, dry_run: true });
    expect(dry.status).toBe(200);

    const undo = await op("batch.undo", { batch_id: batch.batch_id });
    expect(undo.status).toBe(200);
    expect(livePages()).toEqual({ "Swap A": ["original"] });

    // The undo's own batch claims "Swap A" for the new page (un-delete) before the original page
    // renames away from it — the same ordering problem the other way round.
    const redo = await op("batch.undo", { batch_id: undo.json.batch_id });
    expect(redo.status).toBe(200);
    expect(livePages()).toEqual({ "Swap A": ["replacement"], "Swap B": ["original"] });
  });

  it("undoes a chain of renames where each page took the previous one's name", async () => {
    await ok("page.create", { name: "Old", markdown: "- was old" });
    await ok("page.create", { name: "Draft", markdown: "- was draft" });
    const batch = await ok("batch", {
      ops: [
        { op: "page.update", page: "Old", new_name: "Archive", keep_alias: false },
        { op: "page.update", page: "Draft", new_name: "Old", keep_alias: false },
      ],
    });
    expect(livePages()).toEqual({ Archive: ["was old"], Old: ["was draft"] });

    const undo = await op("batch.undo", { batch_id: batch.batch_id });
    expect(undo.status).toBe(200);
    expect(livePages()).toEqual({ Draft: ["was draft"], Old: ["was old"] });
  });

  it("still refuses, writing nothing, to undo two pages swapping names (no order frees either)", async () => {
    await ok("page.create", { name: "Left", markdown: "- l" });
    await ok("page.create", { name: "Right", markdown: "- r" });
    const batch = await ok("batch", {
      ops: [
        { op: "page.update", page: "Left", new_name: "Swap Temp", keep_alias: false },
        { op: "page.update", page: "Right", new_name: "Left", keep_alias: false },
        { op: "page.update", page: "Swap Temp", new_name: "Right", keep_alias: false },
      ],
    });
    expect(livePages()).toEqual({ Left: ["r"], Right: ["l"] });
    const ops = () => s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n;
    const before = ops();

    const undo = await op("batch.undo", { batch_id: batch.batch_id });
    expect(undo.status).toBe(400);
    expect(undo.json.error.message).toContain("page-key-collision");
    expect(ops()).toBe(before);
    expect(livePages()).toEqual({ Left: ["r"], Right: ["l"] });
  });
  // Verification (core-ops-verify): the order is a walk over name claims, so it has to follow a
  // chain further than one step, and a page the batch CREATED can be the one holding the name.
  it("undoes a three-step chain touched in the order that frees each name first", async () => {
    await ok("page.create", { name: "Chain A", markdown: "- a" });
    await ok("page.create", { name: "Chain B", markdown: "- b" });
    await ok("page.create", { name: "Chain C", markdown: "- c" });
    const batch = await ok("batch", {
      ops: [
        { op: "page.update", page: "Chain C", new_name: "Chain D", keep_alias: false },
        { op: "page.update", page: "Chain B", new_name: "Chain C", keep_alias: false },
        { op: "page.update", page: "Chain A", new_name: "Chain B", keep_alias: false },
      ],
    });
    expect(livePages()).toEqual({ "Chain B": ["a"], "Chain C": ["b"], "Chain D": ["c"] });

    const undo = await op("batch.undo", { batch_id: batch.batch_id });
    expect(undo.status).toBe(200);
    expect(livePages()).toEqual({ "Chain A": ["a"], "Chain B": ["b"], "Chain C": ["c"] });
    const redo = await op("batch.undo", { batch_id: undo.json.batch_id });
    expect(redo.status).toBe(200);
    expect(livePages()).toEqual({ "Chain B": ["a"], "Chain C": ["b"], "Chain D": ["c"] });
  });

  it("undoes a new page renamed into the name another page gave up in the same batch", async () => {
    await ok("page.create", { name: "Moved", markdown: "- first" });
    const batch = await ok("batch", {
      ops: [
        { op: "page.create", name: "Moved Draft", markdown: "- second" },
        { op: "page.update", page: "Moved", new_name: "Moved Away", keep_alias: false },
        { op: "page.update", page: "Moved Draft", new_name: "Moved", keep_alias: false },
      ],
    });
    expect(livePages()).toEqual({ Moved: ["second"], "Moved Away": ["first"] });

    const undo = await op("batch.undo", { batch_id: batch.batch_id });
    expect(undo.status).toBe(200);
    expect(livePages()).toEqual({ Moved: ["first"] });
    const redo = await op("batch.undo", { batch_id: undo.json.batch_id });
    expect(redo.status).toBe(200);
    expect(livePages()).toEqual({ Moved: ["second"], "Moved Away": ["first"] });
  });
});
