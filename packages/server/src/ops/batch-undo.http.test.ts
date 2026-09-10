import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

/** The batch_id of the first change recorded strictly after `cursor` -- every entity a single
 *  top-level write touches shares one batch_id (mcp-tools.md §3.7), so the first item's is enough. */
async function batchIdSince(cursor: string): Promise<string> {
  const { status, json } = await post(s.app, "/api/v1/changes.since", s.writeToken, { cursor });
  expect(status).toBe(200);
  const first = json.items[0];
  if (!first) throw new Error(`no changes recorded after cursor ${cursor}`);
  return first.batch_id as string;
}

function contents(tree: Array<{ content: string }>): string[] {
  return tree.map((n) => n.content);
}

describe("batch.undo", () => {
  it("restores a page_append's prior state exactly: block count and content (success)", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "UndoPage",
      markdown: "- a\n- b",
    });
    expect(create.status).toBe(200);
    const cursorAfterCreate = String(create.json.seq);

    const append = await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "UndoPage",
      markdown: "- c\n- d",
    });
    expect(append.status).toBe(200);
    const appendBatchId = await batchIdSince(cursorAfterCreate);

    const afterAppend = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "UndoPage",
      format: "json",
    });
    expect(contents(afterAppend.json.tree)).toEqual(["a", "b", "c", "d"]);

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: appendBatchId,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.dry_run).toBe(false);
    expect(undo.json.deleted).toHaveLength(2); // c and d were created by the undone batch
    expect(typeof undo.json.undo_batch_id).toBe("string");
    expect(undo.json.undo_batch_id).not.toBe(appendBatchId);

    const restored = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "UndoPage",
      format: "json",
    });
    expect(contents(restored.json.tree)).toEqual(["a", "b"]);
  });

  it("restores a block.update's prior text and marker (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "UndoBlock",
      markdown: "- TODO buy milk",
    });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "UndoBlock",
      format: "json",
    });
    const id = read.json.tree[0].id;
    const cursorBefore = String(
      (await post(s.app, "/api/v1/graph.overview", s.writeToken, {})).json.seq,
    );

    const update = await post(s.app, "/api/v1/block.update", s.writeToken, {
      id,
      old_str: "TODO buy milk",
      new_str: "DONE buy milk",
    });
    expect(update.status).toBe(200);
    const updateBatchId = await batchIdSince(cursorBefore);

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: updateBatchId,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.updated).toEqual([id]);

    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "UndoBlock" });
    expect(after.json.text).toContain("TODO buy milk");
    expect(after.json.text).not.toContain("done::");
  });

  it("undo of a batch that created a page deletes it (success)", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, { name: "ToUndo" });
    expect(create.status).toBe(200);
    const batchId = await batchIdSince("0");

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: batchId });
    expect(undo.status).toBe(200);
    expect(undo.json.deleted).toContain(create.json.page_id);

    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "ToUndo" });
    expect(after.status).toBe(404);
  });

  it("restores a renamed page's name and properties (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Original Name",
      properties: { status: "draft" },
    });
    const cursorAfterCreate = String(
      (await post(s.app, "/api/v1/graph.overview", s.writeToken, {})).json.seq,
    );
    const update = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: "Original Name",
      new_name: "Renamed",
      properties: { status: "final", extra: "yes" },
    });
    expect(update.status).toBe(200);
    const updateBatchId = await batchIdSince(cursorAfterCreate);

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: updateBatchId,
    });
    expect(undo.status).toBe(200);

    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Original Name" });
    expect(after.status).toBe(200);
    expect(after.json.page.properties).toEqual({ status: "draft" });
  });

  it("undo is itself undoable: undoing an undo restores the post-original state (success)", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "DoubleUndo",
      markdown: "- a",
    });
    const cursorAfterCreate = String(create.json.seq);
    await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "DoubleUndo",
      markdown: "- b",
    });
    const appendBatchId = await batchIdSince(cursorAfterCreate);

    const undo1 = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: appendBatchId,
    });
    expect(undo1.status).toBe(200);
    let read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "DoubleUndo",
      format: "json",
    });
    expect(contents(read.json.tree)).toEqual(["a"]);

    const undo2 = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: undo1.json.undo_batch_id,
    });
    expect(undo2.status).toBe(200);
    read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "DoubleUndo",
      format: "json",
    });
    expect(contents(read.json.tree)).toEqual(["a", "b"]);
  });

  it("dry_run previews without changing anything", async () => {
    const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "DryUndo",
      markdown: "- a\n- b",
    });
    const cursorAfterCreate = String(create.json.seq);
    await post(s.app, "/api/v1/page.append", s.writeToken, { page: "DryUndo", markdown: "- c" });
    const appendBatchId = await batchIdSince(cursorAfterCreate);

    const before = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "DryUndo",
      format: "json",
    });

    const dry = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: appendBatchId,
      dry_run: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.json.dry_run).toBe(true);

    const after = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "DryUndo",
      format: "json",
    });
    expect(contents(after.json.tree)).toEqual(contents(before.json.tree));
    expect(contents(after.json.tree)).toEqual(["a", "b", "c"]);
  });

  it("is not_found for an unknown batch_id", async () => {
    const { status, json } = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: "nonexistent-batch",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("is invalid for a batch that only touched an asset (not undoable via the op log)", async () => {
    const upload = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "x.txt",
      mime_type: "text/plain",
      data_base64: Buffer.from("hello").toString("base64"),
    });
    expect(upload.status).toBe(200);
    const batchId = await batchIdSince("0");

    const { status, json } = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: batchId,
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});
