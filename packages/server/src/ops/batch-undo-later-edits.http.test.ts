/**
 * `batch.undo`'s `keep_later_edits` / `ignore_batches` (B-251): an undo that leaves alone what
 * other batches changed afterwards, per field, and a walk of undos that does not mistake its own
 * steps for someone's later edit. The e2e side (the History view) is
 * `e2e/tests/history-later-edits.spec.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function op<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
  const res = await post(s.app, `/api/v1/${name}`, s.writeToken, body);
  if (res.status !== 200) throw new Error(`${name} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json as T;
}

async function blocks(
  page: string,
): Promise<Array<{ id: string; content: string; properties?: Record<string, string> }>> {
  const read = await op<{
    tree: Array<{ id: string; content: string; properties?: Record<string, string> }>;
  }>("page.read", { page, format: "json" });
  return read.tree;
}

async function firstBlockId(page: string): Promise<string> {
  const [b] = await blocks(page);
  if (!b) throw new Error(`no block on ${page}`);
  return b.id;
}

describe("batch.undo keep_later_edits", () => {
  it("without the flag a later edit is overwritten (the ADR 013 default, unchanged)", async () => {
    await op("page.create", { name: "Lww", markdown: "- one" });
    const id = await firstBlockId("Lww");
    const edit = await op<{ batch_id: string }>("block.update", { id, content: "two" });
    await op("block.update", { id, content: "three, later" });
    const undo = await op<{ kept: unknown[] }>("batch.undo", { batch_id: edit.batch_id });
    expect(undo.kept).toEqual([]);
    expect((await blocks("Lww")).map((b) => b.content)).toEqual(["one"]);
  });

  it("leaves a field another batch changed later, reports it with its page, restores the rest", async () => {
    await op("page.create", { name: "Keep", markdown: "- one" });
    const id = await firstBlockId("Keep");
    const edit = await op<{ batch_id: string }>("block.update", { id, content: "[#A] two" });
    // old_str, not content: `content` rewrites the priority too, which would make it a later
    // edit of that field as well.
    await op("block.update", { id, old_str: "two", new_str: "two, edited later" });

    const undo = await op<{
      kept: Array<{ entity_type: string; id: string; page: string; fields: string[] }>;
      outline: string;
    }>("batch.undo", { batch_id: edit.batch_id, keep_later_edits: true });

    expect(undo.kept).toEqual([{ entity_type: "block", id, page: "Keep", fields: ["content"] }]);
    expect(undo.outline).toContain("changed again later");
    // The priority was the undone batch's and nobody touched it since: removed again. The text
    // was edited again: left as it is.
    const read = await op<{ text: string }>("page.read", { page: "Keep" });
    expect(read.text).toContain("- two, edited later");
    expect(read.text).not.toContain("[#A]");
  });

  it("is per field: a later property on the block does not stop its text being restored, and survives", async () => {
    await op("page.create", { name: "PerField", markdown: "- original" });
    const id = await firstBlockId("PerField");
    const edit = await op<{ batch_id: string }>("block.update", { id, content: "changed" });
    await op("block.update", { id, properties: { status: "later" } });

    const undo = await op<{ kept: unknown[] }>("batch.undo", {
      batch_id: edit.batch_id,
      keep_later_edits: true,
    });
    // The property was never the undone batch's to restore, so nothing is reported as kept.
    expect(undo.kept).toEqual([]);
    const [b] = await blocks("PerField");
    expect(b?.content).toBe("original");
    expect(b?.properties).toEqual({ status: "later" });
  });

  it("does not delete a block the batch created if another batch edited it since", async () => {
    await op("page.create", { name: "Created", markdown: "- a" });
    const append = await op<{ batch_id: string; created: string[] }>("page.append", {
      page: "Created",
      markdown: "- b",
    });
    const [bId] = append.created;
    await op("block.update", { id: bId, content: "b, worked on since" });

    const undo = await op<{ kept: Array<{ id: string; fields: string[] }>; deleted: string[] }>(
      "batch.undo",
      { batch_id: append.batch_id, keep_later_edits: true },
    );
    expect(undo.deleted).toEqual([]);
    expect(undo.kept).toEqual([expect.objectContaining({ id: bId, fields: ["deleted"] })]);
    expect((await blocks("Created")).map((b) => b.content)).toEqual(["a", "b, worked on since"]);
  });

  it("a walk of undos with ignore_batches restores one page and keeps a later edit on another", async () => {
    // The QA repro (hist5): a replace over A and B, its undo, then a later edit on A only.
    await op("page.create", { name: "Walk A", markdown: "- word zqxtag" });
    await op("page.create", { name: "Walk B", markdown: "- other zqxtag" });
    const replace = await op<{ batch_id: string }>("graph.replace", {
      query: "zqxtag",
      replacement: "REPLACED",
    });
    const undoReplace = await op<{ batch_id: string }>("batch.undo", {
      batch_id: replace.batch_id,
    });
    const aId = await firstBlockId("Walk A");
    await op("block.update", { id: aId, content: "A: important later edit" });

    // Restore B to right after its creation: undo [undoReplace, replace], newest first.
    const walk = [undoReplace.batch_id, replace.batch_id];
    const ignore = [...walk];
    const kept: Array<{ page: string }> = [];
    for (const batchId of walk) {
      const step = await op<{ batch_id?: string; kept: Array<{ page: string }> }>("batch.undo", {
        batch_id: batchId,
        keep_later_edits: true,
        ignore_batches: ignore,
      });
      if (step.batch_id) ignore.push(step.batch_id);
      kept.push(...step.kept);
    }

    expect((await blocks("Walk A")).map((b) => b.content)).toEqual(["A: important later edit"]);
    expect((await blocks("Walk B")).map((b) => b.content)).toEqual(["other zqxtag"]);
    expect(kept.map((k) => k.page)).toEqual(["Walk A", "Walk A"]);
  });

  it("without ignore_batches a walk's own first step would count as a later edit", async () => {
    await op("page.create", { name: "NoIgnore", markdown: "- v1" });
    const id = await firstBlockId("NoIgnore");
    const e2 = await op<{ batch_id: string }>("block.update", { id, content: "v2" });
    const e3 = await op<{ batch_id: string }>("block.update", { id, content: "v3" });
    await op("batch.undo", { batch_id: e3.batch_id, keep_later_edits: true });
    // e3 and its undo both changed the text after e2: without naming them, e2's undo keeps "v2".
    const step = await op<{ kept: unknown[] }>("batch.undo", {
      batch_id: e2.batch_id,
      keep_later_edits: true,
    });
    expect(step.kept).toHaveLength(1);
    expect((await blocks("NoIgnore")).map((b) => b.content)).toEqual(["v2"]);
  });
});
