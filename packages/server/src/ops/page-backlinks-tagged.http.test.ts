/**
 * ADR 017's `tagged_pages` group on `page.backlinks` (B-111): asking about `Person` or `Journal`
 * returns the pages that carry that tag — from the `page_tag` index — next to the blocks that link
 * to it. The index existed and `page.list({tag})` read it; the backlinks op, which is what a tag
 * page and an agent asking "what is this connected to" call, never did.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function backlinks(body: Record<string, unknown>): Promise<JsonAny> {
  const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, body);
  expect(status).toBe(200);
  return json;
}

async function create(body: Record<string, unknown>): Promise<void> {
  const { status } = await post(s.app, "/api/v1/page.create", s.writeToken, body);
  expect(status).toBe(200);
}

describe("page.backlinks tagged_pages (B-111)", () => {
  it("lists the pages whose tags:: name the target, by name, with their source", async () => {
    await create({ name: "Person" });
    await create({ name: "Zuzana", properties: { tags: "person, czech" } });
    await create({ name: "Adam", properties: { tags: "[[Person]]" } });
    await create({ name: "Unrelated", properties: { tags: "personal" } });
    await create({ name: "Notes", markdown: "- met a #Person today" });

    const out = await backlinks({ target: "Person" });
    expect(out.tagged_pages).toEqual([
      { id: expect.any(String), page: "Adam", source: "property" },
      { id: expect.any(String), page: "Zuzana", source: "property" },
    ]);
    expect(out.tagged_total).toBe(2);
    // The block-level #Person is still a linked reference, not a tagged page.
    expect(out.linked.map((l: { page: string }) => l.page)).toEqual(["Notes"]);
  });

  it("lists every journal day under Journal as intrinsic, newest first, after named pages", async () => {
    // A journal day is born through page.append (page.create refuses a date name, B-23).
    for (const day of ["2026-09-01", "2026-09-03"]) {
      const { status } = await post(s.app, "/api/v1/page.append", s.writeToken, {
        page: day,
        markdown: "- a day",
      });
      expect(status).toBe(200);
    }
    await create({ name: "Not a journal" });
    await create({ name: "Journaling habit", properties: { tags: "Journal" } });

    const out = await backlinks({ target: "Journal" });
    expect(
      out.tagged_pages.map((t: { page: string; source: string }) => [t.page, t.source]),
    ).toEqual([
      ["Journaling habit", "property"],
      ["2026-09-03", "intrinsic"],
      ["2026-09-01", "intrinsic"],
    ]);
    // Journal has no page of its own here — a tag that is only ever derived still answers.
    expect(out.target).toBe("Journal");
  });

  it("matches a tag written as one of the target's aliases, and never lists the page itself", async () => {
    await create({ name: "Person", properties: { alias: "people", tags: "person" } });
    await create({ name: "Eva", properties: { tags: "people" } });

    const out = await backlinks({ target: "Person" });
    expect(out.tagged_pages.map((t: { page: string }) => t.page)).toEqual(["Eva"]);
  });

  it("pages tagged_pages with the same limit and cursor as linked", async () => {
    for (const name of ["P1", "P2", "P3"]) await create({ name, properties: { tags: "Topic" } });

    const first = await backlinks({ target: "Topic", limit: 2 });
    expect(first.tagged_pages.map((t: { page: string }) => t.page)).toEqual(["P1", "P2"]);
    expect(first.tagged_total).toBe(3);
    expect(first.cursor).toBeDefined();

    const second = await backlinks({ target: "Topic", limit: 2, cursor: first.cursor });
    expect(second.tagged_pages.map((t: { page: string }) => t.page)).toEqual(["P3"]);
    expect(second.cursor).toBeUndefined();
  });

  it("is described to MCP clients, and page_backlinks returns it with a summary line", async () => {
    // An agent only uses what the tool description tells it exists.
    const mcp = async (method: string, params: unknown): Promise<JsonAny> => {
      const res = await s.app.request("/mcp", {
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${s.writeToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      const data = text.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse(data ? data.slice("data:".length) : text);
    };

    const list = await mcp("tools/list", {});
    const tool = list.result.tools.find((t: { name: string }) => t.name === "page_backlinks");
    expect(tool.description).toContain("tagged_pages");
    expect(tool.description).toContain("Journal");

    await create({ name: "Book" });
    await create({ name: "Dune", properties: { tags: "book" } });
    const call = await mcp("tools/call", { name: "page_backlinks", arguments: { target: "Book" } });
    expect(call.result.isError).toBeFalsy();
    expect(call.result.structuredContent.tagged_pages).toEqual([
      { id: expect.any(String), page: "Dune", source: "property" },
    ]);
    expect(call.result.content[0].text).toContain("1 page(s) tagged Book");
  });

  it("drops a page whose tag is removed, and is empty for a block target", async () => {
    await create({ name: "Idea", markdown: "- a block" });
    await create({ name: "Draft", properties: { tags: "Idea" } });
    expect((await backlinks({ target: "Idea" })).tagged_pages).toHaveLength(1);

    await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: "Draft",
      properties: { tags: null },
    });
    expect((await backlinks({ target: "Idea" })).tagged_pages).toEqual([]);

    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Idea",
      format: "json",
    });
    const blockId = read.json.tree[0].id as string;
    const byBlock = await backlinks({ target: blockId });
    expect(byBlock.tagged_pages).toEqual([]);
    expect(byBlock.tagged_total).toBe(0);
  });
});
