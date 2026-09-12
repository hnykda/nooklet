import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

interface Batch {
  batch_id: string;
  seq: number;
  at: string;
  origin: string;
  actor: string;
  summary: string;
  entries: Array<{
    entity_type: string;
    entity_id: string;
    kind: string;
    before: { content?: string; name?: string; deleted_at: number | null } | null;
    after: { content?: string; name?: string; deleted_at: number | null } | null;
  }>;
}

async function history(page: string, extra: Record<string, unknown> = {}): Promise<Batch[]> {
  const r = await post(s.app, "/api/v1/page.history", s.writeToken, { page, ...extra });
  expect(r.status).toBe(200);
  return r.json.batches;
}

async function contents(page: string): Promise<string[]> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree.map((n: { content: string }) => n.content) : [];
}

/** create (page + "one") -> edit "one" -> append "two": three batches, oldest to newest. */
async function seedThreeBatches(
  name: string,
): Promise<{ create: string; edit: string; append: string }> {
  const create = await post(s.app, "/api/v1/page.create", s.writeToken, {
    name,
    markdown: "- one",
  });
  expect(create.status).toBe(200);
  const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: name, format: "json" });
  const edit = await post(s.app, "/api/v1/block.update", s.writeToken, {
    id: read.json.tree[0].id,
    old_str: "one",
    new_str: "one edited",
  });
  expect(edit.status).toBe(200);
  const append = await post(s.app, "/api/v1/page.append", s.writeToken, {
    page: name,
    markdown: "- two",
  });
  expect(append.status).toBe(200);
  return { create: create.json.batch_id, edit: edit.json.batch_id, append: append.json.batch_id };
}

describe("page.history", () => {
  it("groups the audit rows by batch, newest first, and says what happened in words", async () => {
    const ids = await seedThreeBatches("Hist");
    const batches = await history("Hist");
    expect(batches.map((b) => b.batch_id)).toEqual([ids.append, ids.edit, ids.create]);
    expect(batches.map((b) => b.summary)).toEqual([
      "1 block added",
      "1 block edited",
      "page created; 1 block added",
    ]);
    for (const b of batches) {
      expect(b).toMatchObject({ origin: "api", actor: "test-write" });
      expect(typeof b.seq).toBe("number");
      expect(Number.isNaN(Date.parse(b.at))).toBe(false);
    }
    expect(batches[0]?.seq).toBeGreaterThan(batches[2]?.seq ?? 0);
  });

  it("carries the before/after image an edit needs for a diff", async () => {
    const ids = await seedThreeBatches("Diffable");
    const [edit] = (await history("Diffable")).filter((b) => b.batch_id === ids.edit);
    expect(edit?.entries).toHaveLength(1);
    expect(edit?.entries[0]).toMatchObject({
      entity_type: "block",
      kind: "edited",
      before: { content: "one", deleted_at: null },
      after: { content: "one edited", deleted_at: null },
    });
    const [create] = (await history("Diffable")).filter((b) => b.batch_id === ids.create);
    const pageEntry = create?.entries.find((e) => e.entity_type === "page");
    expect(pageEntry).toMatchObject({ kind: "created", before: null, after: { name: "Diffable" } });
  });

  it("still answers for a deleted page, whose deletion is the newest batch", async () => {
    await seedThreeBatches("Doomed");
    const del = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Doomed" });
    expect(del.status).toBe(200);
    const batches = await history("doomed");
    expect(batches[0]?.batch_id).toBe(del.json.batch_id);
    expect(batches[0]?.summary).toBe("page deleted; 2 blocks deleted");
    expect(batches).toHaveLength(4);
  });

  it("hides a batch that changed nothing visible (identical text re-sent)", async () => {
    const ids = await seedThreeBatches("Quiet");
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Quiet",
      format: "json",
    });
    const same = await post(s.app, "/api/v1/block.update", s.writeToken, {
      id: read.json.tree[0].id,
      content: "one edited",
    });
    expect(same.status).toBe(200);
    const batches = await history("Quiet");
    expect(batches.map((b) => b.batch_id)).toEqual([ids.append, ids.edit, ids.create]);
  });

  it("paginates with a cursor", async () => {
    const ids = await seedThreeBatches("Paged");
    const first = await post(s.app, "/api/v1/page.history", s.writeToken, {
      page: "Paged",
      limit: 2,
    });
    expect(first.json.has_more).toBe(true);
    expect(first.json.batches.map((b: Batch) => b.batch_id)).toEqual([ids.append, ids.edit]);
    const second = await post(s.app, "/api/v1/page.history", s.writeToken, {
      page: "Paged",
      limit: 2,
      cursor: first.json.cursor,
    });
    expect(second.json.has_more).toBe(false);
    expect(second.json.cursor).toBeUndefined();
    expect(second.json.batches.map((b: Batch) => b.batch_id)).toEqual([ids.create]);
  });

  it("is not_found for a page that never existed, invalid for a bad cursor", async () => {
    expect(
      (await post(s.app, "/api/v1/page.history", s.writeToken, { page: "Never" })).status,
    ).toBe(404);
    await seedThreeBatches("Cur");
    expect(
      (await post(s.app, "/api/v1/page.history", s.writeToken, { page: "Cur", cursor: "x" }))
        .status,
    ).toBe(400);
  });

  it("'restore this version' = batch_undo of every newer batch, newest first (the client's walk)", async () => {
    const ids = await seedThreeBatches("Rewind");
    expect(await contents("Rewind")).toEqual(["one edited", "two"]);
    const batches = await history("Rewind");
    // Restore to right after the create batch: undo everything above it in the timeline.
    const target = batches.findIndex((b) => b.batch_id === ids.create);
    const newer = batches.slice(0, target);
    for (const b of newer) {
      const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: b.batch_id });
      expect(undo.status).toBe(200);
    }
    expect(await contents("Rewind")).toEqual(["one"]);
    // The walk is itself history: two more batches, each a restore.
    const after = await history("Rewind");
    expect(after).toHaveLength(5);
    expect(after[0]?.summary).toBe("1 block edited");
    expect(after[1]?.summary).toBe("1 block deleted");
  });
});
