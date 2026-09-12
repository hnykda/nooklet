import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function tree(page: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : undefined;
}

/** `[content, [children...]]` — the shape of a page, nesting included, in one comparison. */
function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

async function firstBlockId(page: string): Promise<string> {
  return (await tree(page))[0].id as string;
}

function rowCounts(): Record<string, number> {
  const count = (t: string): number =>
    s.serverCtx.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0;
  return { page: count("page"), block: count("block"), op: count("op"), changes: count("changes") };
}

describe("block.to_page", () => {
  it("names the page after the first line, moves the children (nesting kept) and leaves a link", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Home",
      markdown: "- Project Aurora\n  - kickoff\n    - agenda\n  - budget\n- other",
    });
    const id = await firstBlockId("Home");
    const { status, json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      page: "Project Aurora",
      page_created: true,
      block_id: id,
      link: "[[Project Aurora]]",
      moved: 3,
      dry_run: false,
    });
    expect(typeof json.batch_id).toBe("string");

    expect(shape(await tree("Home"))).toEqual([
      ["[[Project Aurora]]", []],
      ["other", []],
    ]);
    // The grandchild is what B-85 loses when only the roots are re-placed.
    expect(shape(await tree("Project Aurora"))).toEqual([
      ["kickoff", [["agenda", []]]],
      ["budget", []],
    ]);
    // Rebuild-from-log parity holds for the explicit per-descendant place ops.
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("keeps the block's marker and properties on the link block", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Tasks",
      markdown: "- TODO Buy a house\n  owner:: dan\n  - call the bank",
    });
    const id = await firstBlockId("Tasks");
    await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    const [block] = await tree("Tasks");
    expect(block).toMatchObject({
      content: "[[Buy a house]]",
      marker: "TODO",
      properties: { owner: "dan" },
      children: [],
    });
  });

  it("turns continuation lines into the page's first block, ahead of the children", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Notes",
      markdown: "- Recipe\n  two lines of notes\n  - flour\n  - eggs",
    });
    const id = await firstBlockId("Notes");
    const { json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(json.moved).toBe(2);
    expect(shape(await tree("Recipe"))).toEqual([
      ["two lines of notes", []],
      ["flour", []],
      ["eggs", []],
    ]);
  });

  it("appends to an existing page rather than failing, and links with that page's own casing", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Aurora",
      markdown: "- already here",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Journal",
      markdown: "- aurora\n  - new child",
    });
    const id = await firstBlockId("Journal");
    const { json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(json.page_created).toBe(false);
    expect(json.link).toBe("[[Aurora]]");
    expect(shape(await tree("Aurora"))).toEqual([
      ["already here", []],
      ["new child", []],
    ]);
  });

  it("a first line that is already one [[link]] names that page; name overrides both", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Links",
      markdown: "- [[Target Page]]\n  - a\n- plain\n  - b",
    });
    const [linkBlock, plainBlock] = await tree("Links");
    const r1 = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id: linkBlock.id });
    expect(r1.json.page).toBe("Target Page");
    const r2 = await post(s.app, "/api/v1/block.to_page", s.writeToken, {
      id: plainBlock.id,
      name: "Chosen Name",
    });
    expect(r2.json.page).toBe("Chosen Name");
    expect(shape(await tree("Links"))).toEqual([
      ["[[Target Page]]", []],
      ["[[Chosen Name]]", []],
    ]);
  });

  it("dry_run reports the outcome and writes nothing", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dry",
      markdown: "- Would be a page\n  - child",
    });
    const id = await firstBlockId("Dry");
    const before = rowCounts();
    const { json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, {
      id,
      dry_run: true,
    });
    expect(json).toMatchObject({ page: "Would be a page", moved: 1, dry_run: true });
    expect(json.batch_id).toBeUndefined();
    expect(rowCounts()).toEqual(before);
    expect(await tree("Would be a page")).toBeUndefined();
  });

  it("batch_undo puts the children back under the block and removes the page", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Undo",
      markdown: "- Heading\n  - x\n    - y",
    });
    const id = await firstBlockId("Undo");
    const { json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: json.batch_id });
    expect(undo.status).toBe(200);
    expect(shape(await tree("Undo"))).toEqual([["Heading", [["x", [["y", []]]]]]]);
    expect(await tree("Heading")).toBeUndefined();
  });

  it("refuses a block with no text and an unknown block", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Empty", markdown: "- x" });
    const id = await firstBlockId("Empty");
    await post(s.app, "/api/v1/block.update", s.writeToken, { id, content: "" });
    const empty = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe("invalid");
    const missing = await post(s.app, "/api/v1/block.to_page", s.writeToken, {
      id: "1k7f3q9xz2hav4",
    });
    expect(missing.status).toBe(404);
  });
});
