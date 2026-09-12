import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function backlinks(target: string) {
  const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
    target,
    include_unlinked: true,
  });
  expect(status).toBe(200);
  return json as {
    linked: Array<{ id: string; text: string }>;
    unlinked: Array<{ id: string; text: string }>;
  };
}

async function firstLines(page: string): Promise<string[]> {
  const { json } = await post(s.app, "/api/v1/page.read", s.writeToken, {
    page,
    format: "json",
  });
  return (json.tree as Array<{ content: string }>).map((n) => n.content);
}

describe("mentions.link", () => {
  it("links every plain mention in one batch, and batch.undo puts them all back", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Aurora", markdown: "- hub" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Notes",
      markdown: "- talked about aurora today\n- Aurora ships Monday\n- unrelated",
    });
    const before = await backlinks("Aurora");
    expect(before.linked).toHaveLength(0);
    expect(before.unlinked).toHaveLength(2);

    const res = await post(s.app, "/api/v1/mentions.link", s.writeToken, { page: "Aurora" });
    expect(res.status).toBe(200);
    expect(res.json.updated).toHaveLength(2);
    expect(res.json.skipped).toEqual([]);
    expect(typeof res.json.batch_id).toBe("string");
    expect(res.json.page).toBe("Aurora");

    // The author's spelling survives inside the brackets.
    expect(await firstLines("Notes")).toEqual([
      "talked about [[aurora]] today",
      "[[Aurora]] ships Monday",
      "unrelated",
    ]);
    const after = await backlinks("Aurora");
    expect(after.linked).toHaveLength(2);
    expect(after.unlinked).toHaveLength(0);

    // A second call has nothing left to do and writes nothing.
    const again = await post(s.app, "/api/v1/mentions.link", s.writeToken, { page: "Aurora" });
    expect(again.status).toBe(200);
    expect(again.json.updated).toEqual([]);
    expect(again.json.batch_id).toBeUndefined();

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: res.json.batch_id,
    });
    expect(undo.status).toBe(200);
    expect(await firstLines("Notes")).toEqual([
      "talked about aurora today",
      "Aurora ships Monday",
      "unrelated",
    ]);
    const restored = await backlinks("Aurora");
    expect(restored.unlinked).toHaveLength(2);
  });

  it("writes the full name for a namespaced page", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Aurora",
      markdown: "- hub",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Vendors",
      markdown: "- quoted pricing for the Aurora launch",
    });
    const res = await post(s.app, "/api/v1/mentions.link", s.writeToken, {
      page: "Projects/Aurora",
    });
    expect(res.status).toBe(200);
    expect(await firstLines("Vendors")).toEqual([
      "quoted pricing for the [[Projects/Aurora]] launch",
    ]);
    expect((await backlinks("Projects/Aurora")).linked).toHaveLength(1);
  });

  it("leaves a mention it cannot safely rewrite alone, and says why", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Aurora", markdown: "- hub" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Snippets",
      markdown: "- run `aurora --help`\n- see https://aurora.example.com\n- plain aurora mention",
    });
    const res = await post(s.app, "/api/v1/mentions.link", s.writeToken, { page: "Aurora" });
    expect(res.status).toBe(200);
    expect(res.json.updated).toHaveLength(1);
    expect(res.json.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual([
      "inside code",
      "part of a URL",
    ]);
    expect(await firstLines("Snippets")).toEqual([
      "run `aurora --help`",
      "see https://aurora.example.com",
      "plain [[aurora]] mention",
    ]);
  });

  it("block_ids restricts the rewrite to those blocks and reports strangers", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Aurora", markdown: "- hub" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Two",
      markdown: "- first aurora\n- second aurora",
    });
    const mentions = (await backlinks("Aurora")).unlinked;
    const first = mentions.find((m) => m.text.startsWith("first"));
    if (!first) throw new Error("seed did not produce the expected mention");
    const res = await post(s.app, "/api/v1/mentions.link", s.writeToken, {
      page: "Aurora",
      block_ids: [first.id, "1k7f3q9xz2hav4"],
    });
    expect(res.status).toBe(200);
    expect(res.json.updated).toEqual([first.id]);
    expect(res.json.skipped).toEqual([
      { id: "1k7f3q9xz2hav4", reason: "not an unlinked mention of this page" },
    ]);
    expect(await firstLines("Two")).toEqual(["first [[aurora]]", "second aurora"]);
  });

  it("dry_run previews without writing", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Aurora", markdown: "- hub" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dry",
      markdown: "- aurora here",
    });
    const res = await post(s.app, "/api/v1/mentions.link", s.writeToken, {
      page: "Aurora",
      dry_run: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.dry_run).toBe(true);
    expect(res.json.updated).toHaveLength(1);
    expect(res.json.batch_id).toBeUndefined();
    expect(await firstLines("Dry")).toEqual(["aurora here"]);
  });

  it("404s on an unknown page and refuses a read-only token", async () => {
    const missing = await post(s.app, "/api/v1/mentions.link", s.writeToken, {
      page: "Nope",
    });
    expect(missing.status).toBe(404);
    const readOnly = await post(s.app, "/api/v1/mentions.link", s.readToken, {
      page: "Nope",
    });
    expect(readOnly.status).toBe(403);
  });
});
