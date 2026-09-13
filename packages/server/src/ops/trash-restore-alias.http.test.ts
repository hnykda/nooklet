/**
 * `trash.restore` must not hand a name back to a deleted page while a live page answers to it as
 * an alias (QA finding Q6, docs/bugs-inbox/qafix-views.md B-256). A page's own key wins over an
 * alias when a `[[link]]` resolves, so restoring merged-away "Alex" beside "@Alex" (which carries
 * `alias:: Alex` from the merge) silently re-pointed every `[[Alex]]` at the empty restored page.
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

async function deletedPageId(name: string): Promise<string> {
  const row = s.serverCtx.driver.get<{ id: string }>(
    "SELECT id FROM page WHERE name = ? AND deleted_at IS NOT NULL",
    [name],
  );
  if (!row) throw new Error(`no deleted page ${name}`);
  return row.id;
}

describe("trash.restore and aliases", () => {
  it("refuses to restore a merged-away page under the name its merge target now aliases", async () => {
    await op("page.create", { name: "Alex", markdown: "- about Alex" });
    await op("page.create", { name: "@Alex", markdown: "- the person" });
    await op("page.create", { name: "Journal", markdown: "- met [[Alex]] today" });
    const merge = await op("page.merge", { source: "Alex", target: "@Alex" });
    expect(merge.status).toBe(200);
    const id = await deletedPageId("Alex");

    const refused = await op("trash.restore", { id });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("conflict");
    expect(refused.json.error.message).toBe('a live page, "@Alex", uses "Alex" as an alias');
    // Nothing moved: [[Alex]] still means @Alex.
    const read = await op("page.read", { page: "Alex" });
    expect(read.json.page.name).toBe("@Alex");

    // The same check applies by name, and to new_name.
    expect((await op("trash.restore", { page: "Alex" })).status).toBe(409);
    await op("page.update", { page: "@Alex", properties: { alias: "Alex, Alexandra" } });
    const clashNew = await op("trash.restore", { id, new_name: "alexandra" });
    expect(clashNew.status).toBe(409);
    expect(clashNew.json.error.message).toContain('uses "alexandra" as an alias');

    const renamed = await op("trash.restore", { id, new_name: "Alex (restored)" });
    expect(renamed.status).toBe(200);
    expect((await op("page.read", { page: "Alex (restored)" })).status).toBe(200);
    expect((await op("page.read", { page: "Alex" })).json.page.name).toBe("@Alex");
  });

  it("a page's own alias rows do not block restoring it", async () => {
    await op("page.create", {
      name: "Self Aliased",
      properties: { alias: "Selfie" },
      markdown: "- x",
    });
    await op("page.delete", { page: "Self Aliased" });
    const id = await deletedPageId("Self Aliased");
    expect((await op("trash.restore", { id })).status).toBe(200);
  });
});
