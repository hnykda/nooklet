/**
 * `block.update` on blocks with more than one line of raw text — property lines, continuation
 * lines, code fences — through the real HTTP route (B-172). Every one of these was a 400 "content
 * must describe exactly one block" before the fix, including flipping `TODO` to `DONE` by
 * `old_str` on a task with `scheduled::`, which the op's own description recommends.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function seed(name: string, markdown: string): Promise<string> {
  const created = await post(s.app, "/api/v1/page.create", s.writeToken, { name, markdown });
  expect(created.status).toBe(200);
  return created.json.created[0] as string;
}

async function readBlock(id: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/block.read", s.writeToken, { id, format: "json" });
  expect(r.status).toBe(200);
  return r.json.block;
}

async function update(body: Record<string, unknown>) {
  return post(s.app, "/api/v1/block.update", s.writeToken, body);
}

describe("block.update on multi-line raw text (B-172)", () => {
  it("flips TODO to DONE by old_str on a task with a scheduled:: line", async () => {
    const id = await seed("B172 Tasks", "- TODO buy milk\n  scheduled:: 2026-09-13");
    const { status, json } = await update({ id, old_str: "TODO", new_str: "DONE" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.before).toBe("TODO buy milk\nscheduled:: 2026-09-13");
    const b = await readBlock(id);
    expect(b.marker).toBe("DONE");
    expect(b.content).toBe("buy milk");
    expect(b.properties.scheduled).toBe("2026-09-13");
    expect(b.properties.done).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("flips a DONE task (with done::) back to TODO by old_str, clearing done::", async () => {
    const id = await seed("B172 Done", "- TODO file taxes");
    expect((await update({ id, old_str: "TODO", new_str: "DONE" })).status).toBe(200);
    const { status, json } = await update({ id, old_str: "DONE file", new_str: "TODO file" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.before).toMatch(/^DONE file taxes\ndone:: /);
    const b = await readBlock(id);
    expect(b.marker).toBe("TODO");
    expect(b.properties?.done).toBeUndefined();
  });

  it("edits the second line of multi-line content by old_str", async () => {
    const id = await seed("B172 Lines", "- first line\n  second line\n  third line");
    const { status, json } = await update({ id, old_str: "second", new_str: "2nd" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect((await readBlock(id)).content).toBe("first line\n2nd line\nthird line");
  });

  it("edits inside a code fence by old_str, keeping the block's properties", async () => {
    const id = await seed(
      "B172 Fence",
      "- snippet\n  lang:: js\n  ```js\n  const x = 1;\n  - not a child\n  ```",
    );
    const { status, json } = await update({ id, old_str: "x = 1", new_str: "x = 2" });
    expect(status, JSON.stringify(json)).toBe(200);
    const b = await readBlock(id);
    expect(b.content).toBe("snippet\n```js\nconst x = 2;\n- not a child\n```");
    expect(b.properties).toEqual({ lang: "js" });
    expect(b.children).toEqual([]);
  });

  it("edits a block that opens with a code fence and has a property (B-151's before-text)", async () => {
    const id = await seed("B172 Fence First", "- ```js\n  const x = 1;\n  ```\n  foo:: bar");
    expect((await readBlock(id)).properties).toEqual({ foo: "bar" });
    const { status, json } = await update({ id, old_str: "x = 1", new_str: "x = 2" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.before).toBe("```js\nconst x = 1;\n```\nfoo:: bar");
    const b = await readBlock(id);
    expect(b.content).toBe("```js\nconst x = 2;\n```");
    expect(b.properties).toEqual({ foo: "bar" });
  });

  it("takes content with flush-left property and continuation lines, as `before` shows them", async () => {
    const id = await seed("B172 Content", "- TODO buy milk");
    const { status, json } = await update({
      id,
      content: "TODO buy milk\nscheduled:: 2026-09-14\nand bread",
    });
    expect(status, JSON.stringify(json)).toBe(200);
    const b = await readBlock(id);
    expect(b.content).toBe("buy milk\nand bread");
    expect(b.properties.scheduled).toBe("2026-09-14");
  });

  it("still takes content in page_read's indented shape", async () => {
    const id = await seed("B172 Indented", "- TODO buy milk");
    const { status, json } = await update({
      id,
      content: "TODO buy milk\n  scheduled:: 2026-09-15\n  and bread",
    });
    expect(status, JSON.stringify(json)).toBe(200);
    const b = await readBlock(id);
    expect(b.content).toBe("buy milk\nand bread");
    expect(b.properties.scheduled).toBe("2026-09-15");
  });

  it("edits an empty block that has only a property line (not a page pre-block)", async () => {
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B172 Empty",
      markdown: "- anchor\n-\n  type:: book",
    });
    const id = created.json.created[1] as string;
    const { status, json } = await update({ id, old_str: "book", new_str: "article" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.before).toBe("\ntype:: book");
    const b = await readBlock(id);
    expect(b.content).toBe("");
    expect(b.properties).toEqual({ type: "article" });
  });

  it("refuses a nested bullet in content with the block_insert hint", async () => {
    const id = await seed("B172 Child", "- parent");
    const { status, json } = await update({ id, content: "parent\n- child" });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.hint).toMatch(/block_insert/);
  });

  it("leaves state a replay of the op log reproduces", async () => {
    const id = await seed("B172 Parity", "- TODO a\n  scheduled:: 2026-09-13\n  more");
    expect((await update({ id, old_str: "TODO", new_str: "DONE" })).status).toBe(200);
    expect((await update({ id, old_str: "more", new_str: "less" })).status).toBe(200);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });
});
