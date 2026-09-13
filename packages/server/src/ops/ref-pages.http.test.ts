/**
 * ADR 024 through the API an agent uses: a reference written by `block.update` makes its page
 * exist for `page.list`, `page.read` and `search`; `page.create` takes such a page over instead of
 * reporting it as existing; the trash never lists the pages the server removed again; a restore
 * pushes an empty reference page aside. `verify` holds after each.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function call(op: string, body: unknown) {
  const r = await post(s.app, `/api/v1/${op}`, s.writeToken, body);
  expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

async function pageNames(): Promise<string[]> {
  const out = await call("page.list", { limit: 200 });
  return (out.items as Array<{ name: string }>).map((p) => p.name).sort();
}

function expectParity(): void {
  const report = verifyRebuildParity(s.serverCtx.driver);
  expect(report.divergences).toEqual([]);
}

describe("pages exist once referenced, over HTTP", () => {
  it("an agent's block.update adding [[Agent Made Page]] makes page.list, page.read and search see it", async () => {
    const created = await call("page.create", { name: "Agent Notes", markdown: "- first draft" });
    const blockId = created.created[0] as string;
    expect(await pageNames()).toEqual(["Agent Notes"]);

    await call("block.update", { id: blockId, content: "first draft, see [[Agent Made Page]]" });

    expect(await pageNames()).toEqual(["Agent Made Page", "Agent Notes"]);
    const read = await call("page.read", { page: "Agent Made Page", format: "json" });
    expect(read.page.name).toBe("Agent Made Page");
    const backlinks = await call("page.backlinks", { target: "Agent Made Page" });
    expect((backlinks.linked as unknown[]).length).toBe(1);
    const found = await call("search", { query: "Agent Made", mode: "keyword" });
    expect(JSON.stringify(found)).toContain("Agent Made Page");
    expectParity();
  });

  it("page.create fills in a page that exists only because it is linked — same id, not 'existed'", async () => {
    await call("page.create", { name: "Hub", markdown: "- see [[deep work]]" });
    const listed = await call("page.list", { prefix: "deep" });
    const autoId = listed.items[0].id as string;

    const out = await call("page.create", {
      name: "Deep Work",
      properties: { type: "book" },
      markdown: "- chapter one",
    });
    expect(out.existed).toBe(false);
    expect(out.page_id).toBe(autoId);
    expect(out.page).toBe("Deep Work");
    const read = await call("page.read", { page: "Deep Work", format: "json" });
    expect((read.tree as Array<{ content: string }>).map((b) => b.content)).toEqual([
      "chapter one",
    ]);

    // Now it is somebody's page: a second create returns it untouched, as for any page.
    const again = await call("page.create", { name: "Deep Work", markdown: "- ignored" });
    expect(again.existed).toBe(true);
    // And removing the link no longer removes the page.
    const hub = await call("page.read", { page: "Hub", format: "json" });
    await call("block.update", { id: hub.tree[0].id, content: "no link" });
    expect(await pageNames()).toContain("Deep Work");
    expectParity();
  });

  it("page.create claims an empty linked page even with no content, so it outlives the link", async () => {
    const hub = await call("page.create", { name: "Hub", markdown: "- [[Placeholder]]" });
    await call("page.create", { name: "Placeholder" });
    await call("block.update", { id: hub.created[0], content: "unlinked" });
    expect(await pageNames()).toEqual(["Hub", "Placeholder"]);
  });

  it("the trash never lists a page the server removed with its last link", async () => {
    const hub = await call("page.create", { name: "Hub", markdown: "- [[Draft One]]" });
    const blockId = hub.created[0] as string;
    for (const name of ["Draft Two", "Draft Three", "Final"]) {
      await call("block.update", { id: blockId, content: `[[${name}]]` });
    }
    expect(await pageNames()).toEqual(["Final", "Hub"]);
    const trash = await call("trash.list", {});
    expect(trash.items).toEqual([]);
    expectParity();
  });

  it("undoing the write that linked a page leaves no empty page in the trash either", async () => {
    const hub = await call("page.create", { name: "Hub", markdown: "- plain" });
    const edit = await call("block.update", { id: hub.created[0], content: "[[Undone Link]]" });
    expect(await pageNames()).toContain("Undone Link");
    await call("batch.undo", { batch_id: edit.batch_id });
    expect(await pageNames()).toEqual(["Hub"]);
    expect((await call("trash.list", {})).items).toEqual([]);
    expectParity();
  });

  it("restoring a deleted page takes its name back from the empty page its links kept", async () => {
    await call("page.create", { name: "Topic", markdown: "- the content" });
    await call("page.create", { name: "Hub", markdown: "- [[Topic]]" });
    const deleted = await call("page.delete", { page: "Topic" });
    expect(deleted.batch_id).toBeTruthy();
    // The link keeps a page under the name: an empty one.
    const empty = await call("page.read", { page: "Topic", format: "json" });
    expect(empty.tree ?? []).toEqual([]);

    const trash = await call("trash.list", {});
    const entry = (trash.items as Array<{ id: string; title: string }>).find(
      (i) => i.title === "Topic",
    );
    expect(entry).toBeTruthy();
    await call("trash.restore", { id: entry?.id });
    const back = await call("page.read", { page: "Topic", format: "json" });
    expect((back.tree as Array<{ content: string }>).map((b) => b.content)).toEqual([
      "the content",
    ]);
    const backlinks = await call("page.backlinks", { target: "Topic" });
    expect((backlinks.linked as unknown[]).length).toBe(1);
    expect((await call("trash.list", {})).items).toEqual([]);
    expectParity();
  });
});
