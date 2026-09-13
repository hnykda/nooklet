/**
 * A page-properties pre-block (`key:: value` lines before the first bullet, markdown-grammar.md
 * OUT-2) in write markdown (B-235). `page.create` used to create the page and its blocks and drop
 * the pre-block without a word — `parseMarkdownBlocks` kept `parsed.blocks` only. Now `page.create`
 * applies it as the new page's properties, and the ops that write into an existing page refuse it
 * with a hint instead of losing it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function readPage(page: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

function writeCounts(): Record<string, number> {
  const count = (t: string): number =>
    s.serverCtx.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0;
  return {
    page: count("page"),
    page_prop: count("page_prop"),
    block: count("block"),
    op: count("op"),
  };
}

describe("page.create applies a markdown pre-block as page properties (B-235)", () => {
  it("sets the properties and still creates the blocks", async () => {
    const r = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B235 Locked",
      markdown: "read-only:: true\nicon:: lock\n\n- a\n- b",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.created).toHaveLength(2);
    const page = await readPage("B235 Locked");
    expect(page.page.properties).toEqual({ "read-only": "true", icon: "lock" });
    expect(page.tree.map((b: JsonAny) => b.content)).toEqual(["a", "b"]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("reads a bulleted pre-block the same way (Logseq's own spelling)", async () => {
    const r = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B235 Bulleted",
      markdown: "- type:: project\n  status:: draft\n- first block",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const page = await readPage("B235 Bulleted");
    expect(page.page.properties).toEqual({ type: "project", status: "draft" });
    expect(page.tree.map((b: JsonAny) => b.content)).toEqual(["first block"]);
  });

  it("lets the explicit properties field win over the pre-block for the keys both give", async () => {
    const r = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B235 Both",
      properties: { status: "active" },
      markdown: "status:: draft\ntype:: project\n\n- a",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await readPage("B235 Both")).page.properties).toEqual({
      status: "active",
      type: "project",
    });
  });

  it("creates a page from a pre-block alone, with no blocks", async () => {
    const r = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B235 Props Only",
      markdown: "read-only:: true",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.created).toEqual([]);
    const page = await readPage("B235 Props Only");
    expect(page.page.properties).toEqual({ "read-only": "true" });
    expect(page.tree).toEqual([]);
  });
});

describe("writes into an existing page refuse a markdown pre-block instead of dropping it (B-235)", () => {
  const PRE_BLOCK = "read-only:: true\n\n- a";

  async function expectRefused(path: string, body: Record<string, unknown>): Promise<void> {
    const before = writeCounts();
    const r = await post(s.app, path, s.writeToken, body);
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.error.code).toBe("invalid");
    expect(r.json.error.message).toMatch(/page properties \(read-only\)/);
    expect(r.json.error.hint).toMatch(/page_update/);
    expect(writeCounts()).toEqual(before);
  }

  it("page.append", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "B235 Target" });
    await expectRefused("/api/v1/page.append", { page: "B235 Target", markdown: PRE_BLOCK });
  });

  it("block.insert", async () => {
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B235 Insert",
      markdown: "- anchor",
    });
    await expectRefused("/api/v1/block.insert", {
      ref: created.json.created[0],
      position: "after",
      markdown: PRE_BLOCK,
    });
  });

  it("page.create with if_exists: append on a page that exists", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "B235 Existing" });
    await expectRefused("/api/v1/page.create", {
      name: "B235 Existing",
      markdown: PRE_BLOCK,
      if_exists: "append",
    });
  });

  it("still takes block properties under a bullet", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "B235 Block Props" });
    const r = await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "B235 Block Props",
      markdown: "- a\n  type:: book",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await readPage("B235 Block Props")).tree[0].properties).toEqual({ type: "book" });
  });
});

// B-312: `page.append` resolved — and so created — its page before checking the markdown, so any
// refusal left a new, empty page or journal day behind.
describe("a refused page.append creates no page (B-312)", () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["a page pre-block", { page: "B312 Fresh", markdown: "read-only:: true\n\n- a" }, 400],
    ["an unknown ^id", { page: "B312 Fresh", markdown: "- a ^1k7f3q9xz2hav4" }, 400],
    [
      "an unknown ^id on a journal day not written yet",
      { page: "2026-07-19", markdown: "- a ^1k7f3q9xz2hav4" },
      400,
    ],
    [
      "a parent on a page that does not exist",
      { page: "B312 Fresh", markdown: "- a", parent: "1k7f3q9xz2hav4" },
      404,
    ],
  ];
  for (const [name, body, status] of cases) {
    it(name, async () => {
      const before = writeCounts();
      const r = await post(s.app, "/api/v1/page.append", s.writeToken, body);
      expect(r.status, JSON.stringify(r.json)).toBe(status);
      expect(writeCounts()).toEqual(before);
    });
  }
});
