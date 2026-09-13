/**
 * `batch.undo` must not hand a name back to a page while a live page answers to it as an alias
 * (B-367) — the rule `trash.restore` already follows (B-256, `trash-restore-alias.http.test.ts`).
 * A page's own key wins over an alias when a `[[link]]` resolves, so un-deleting "Alex" beside an
 * "@Alex" that carries `alias:: Alex` silently re-points every `[[Alex]]` at the restored page.
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

function opCount(): number {
  return s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n ?? 0;
}

describe("batch.undo and aliases (B-367)", () => {
  it("refuses to undo a page delete while another live page uses the name as an alias", async () => {
    await ok("page.create", { name: "Alex", markdown: "- old alex page" });
    await ok("page.create", { name: "@Alex", markdown: "- the person" });
    await ok("page.create", { name: "Notes", markdown: "- met [[Alex]] today" });
    const del = await ok("page.delete", { page: "Alex" });
    await ok("page.update", { page: "@Alex", properties: { alias: "Alex" } });
    const before = opCount();

    for (const dry_run of [true, false]) {
      const undo = await op("batch.undo", { batch_id: del.batch_id, dry_run });
      expect(undo.status).toBe(409);
      expect(undo.json.error.code).toBe("conflict");
      expect(undo.json.error.message).toBe(
        'cannot restore page "Alex": a live page, "@Alex", uses "Alex" as an alias',
      );
    }
    expect(opCount()).toBe(before);
    expect((await ok("page.read", { page: "Alex" })).page.name).toBe("@Alex");
    // Same answer as the Trash view gives for the same page.
    expect((await op("trash.restore", { page: "Alex", dry_run: true })).status).toBe(409);
  });

  it("still undoes a merge, whose own batch added the alias it removes again", async () => {
    await ok("page.create", { name: "Alex", markdown: "- about Alex" });
    await ok("page.create", { name: "@Alex", markdown: "- the person" });
    const merge = await ok("page.merge", { source: "Alex", target: "@Alex" });
    expect((await ok("page.read", { page: "@Alex" })).page.properties?.alias).toBe("Alex");

    const undo = await op("batch.undo", { batch_id: merge.batch_id });
    expect(undo.status).toBe(200);
    const read = await ok("page.read", { page: "Alex" });
    expect(read.page.name).toBe("Alex");
    expect((await ok("page.read", { page: "@Alex" })).page.properties?.alias).toBeUndefined();
  });

  it("with keep_later_edits, a later edit of the merge target's aliases is kept, so the undo is refused", async () => {
    await ok("page.create", { name: "Alex", markdown: "- about Alex" });
    await ok("page.create", { name: "@Alex", markdown: "- the person" });
    const merge = await ok("page.merge", { source: "Alex", target: "@Alex" });
    await ok("page.update", { page: "@Alex", properties: { alias: "Alex, Alexandra" } });

    const kept = await op("batch.undo", { batch_id: merge.batch_id, keep_later_edits: true });
    expect(kept.status).toBe(409);
    expect(kept.json.error.message).toContain('uses "Alex" as an alias');
    expect((await ok("page.read", { page: "Alex" })).page.name).toBe("@Alex");

    // Without the flag the alias is written back to what it was before the merge: no clash.
    const lww = await op("batch.undo", { batch_id: merge.batch_id });
    expect(lww.status).toBe(200);
    expect((await ok("page.read", { page: "Alex" })).page.name).toBe("Alex");
  });

  it("does not refuse an undo that leaves a page's name and tombstone as they are", async () => {
    // An alias shadowed by a real page already (page.create does not check aliases, B-256's
    // note): undoing a property change on that page moves no name, so it is none of undo's business.
    await ok("page.create", { name: "Alex", markdown: "- a page" });
    await ok("page.create", { name: "@Alex", properties: { alias: "Alex" }, markdown: "- x" });
    const setProp = await ok("page.update", { page: "Alex", properties: { status: "draft" } });
    expect((await op("batch.undo", { batch_id: setProp.batch_id })).status).toBe(200);
  });
});
