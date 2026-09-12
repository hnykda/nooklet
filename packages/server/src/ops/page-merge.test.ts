import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function read(page: string): Promise<JsonAny | undefined> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json : undefined;
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

/** Every live block's content, keyed by its first line, across the whole graph. */
function contents(): Map<string, string> {
  const rows = s.serverCtx.driver.all<{ content: string }>(
    "SELECT content FROM block WHERE deleted_at IS NULL",
  );
  return new Map(rows.map((r) => [r.content.split("\n")[0] as string, r.content]));
}

async function seed(): Promise<void> {
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Acme Corp",
    properties: { alias: "Acme, ACME Inc", tags: "vendor, supplier", status: "active" },
    markdown: "- contact: sam\n  - phone\n- see [[Acme Corp]] itself",
  });
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Acme",
    // Exists? No — "Acme" is an alias of Acme Corp, so page.create must NOT be called on it.
    // (This call is a no-op return, which is what we want to prove below.)
  });
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Acme Supply",
    properties: { tags: "vendor, preferred", region: "eu" },
    markdown: "- terms: net 30",
  });
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Journal-ish",
    markdown: [
      "- Met [[Acme Corp]] and [[acme corp]] today #acme",
      "- Their alias [[Acme]] and #[[ACME Inc]] too, plus [[Acme Corp|the corp]]",
      "- a `[[Acme Corp]]` in code stays",
      "- ```\n  [[Acme Corp]] in a fence stays\n  ```",
      "- tagged block\n  tags:: [[Acme Corp]], other",
      "- [[Acme Supply]] is not touched",
    ].join("\n"),
  });
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Tagger",
    properties: { tags: "Acme Corp, misc" },
  });
}

describe("page.merge", () => {
  it("moves the blocks, rewrites every reference (alias- and case-aware), aliases, and deletes", async () => {
    await seed();
    const sourceId = (await read("Acme Corp")).page.id as string;
    const { status, json } = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "Acme Supply",
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      source: "Acme Corp",
      blocks_moved: 3,
      alias_added: true,
      dry_run: false,
    });
    expect(typeof json.batch_id).toBe("string");
    // 3 (two links + a bare #alias) + 3 (alias link, #[[alias]], piped link) + 1 (tags:: on a
    // block) + 1 (page-level tags on Tagger) + 1 (the self-reference on the moved block)
    expect(json.refs_rewritten).toBe(9);

    // Blocks: appended after target's own, nesting kept; source is gone.
    const target = await read("Acme Supply");
    expect(shape(target.tree)).toEqual([
      ["terms: net 30", []],
      ["contact: sam", [["phone", []]]],
      ["see [[Acme Supply]] itself", []],
    ]);
    // Gone by id; by NAME it now resolves to the target (that is the alias doing its job).
    expect(await read(sourceId)).toBeUndefined();
    expect(
      s.serverCtx.driver.get<{ deleted_at: number | null }>(
        "SELECT deleted_at FROM page WHERE id = ?",
        [sourceId],
      )?.deleted_at,
    ).not.toBeNull();

    // References.
    const c = contents();
    expect(c.get("Met [[Acme Supply]] and [[Acme Supply]] today #[[Acme Supply]]")).toBeDefined();
    expect(
      c.get("Their alias [[Acme Supply]] and #[[Acme Supply]] too, plus [[Acme Supply|the corp]]"),
    ).toBeDefined();
    expect(c.get("a `[[Acme Corp]]` in code stays")).toBeDefined();
    expect(c.get("```")).toBe("```\n[[Acme Corp]] in a fence stays\n```");
    expect(c.get("[[Acme Supply]] is not touched")).toBeDefined();
    const tagged = s.serverCtx.driver.get<{ value: string }>(
      "SELECT value FROM block_prop WHERE key = 'tags' AND value LIKE '%other%'",
    );
    expect(tagged?.value).toBe("[[Acme Supply]], other");

    // Properties: alias gains the old name and the old aliases; tags are unioned; status fills
    // in; region (target's own) is untouched.
    expect(target.page.properties).toEqual({
      alias: "Acme Corp, Acme, ACME Inc",
      tags: "vendor, preferred, supplier",
      region: "eu",
      status: "active",
    });
    const tagger = await read("Tagger");
    expect(tagger.page.properties.tags).toBe("Acme Supply, misc");

    // The old names now resolve to the target — the alias is the safety net.
    for (const name of ["Acme Corp", "acme", "ACME Inc"]) {
      const r = await read(name);
      expect(r?.page.name).toBe("Acme Supply");
    }
    // And the merge is a pure function of the op log.
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("nested blocks survive the move (B-85) and page.backlinks sees the rewritten refs", async () => {
    await seed();
    await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "Acme Supply",
    });
    const orphan = s.serverCtx.driver.get<{ n: number }>(
      `SELECT count(*) AS n FROM block b JOIN block p ON p.id = b.parent_id
       WHERE b.deleted_at IS NULL AND b.page_id != p.page_id`,
    );
    expect(orphan?.n).toBe(0);
    const backlinks = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Acme Supply",
    });
    const pages = new Set(backlinks.json.linked.map((l: { page: string }) => l.page));
    expect(pages.has("Journal-ish")).toBe(true);
  });

  it("keep_alias: false leaves the old name unresolvable but still rewrites", async () => {
    await seed();
    const { json } = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "Acme Supply",
      keep_alias: false,
    });
    // Source's own aliases still carry over: they were names people used.
    expect(json.alias_added).toBe(true);
    const target = await read("Acme Supply");
    expect(target.page.properties.alias).toBe("Acme, ACME Inc");
    expect(await read("Acme Corp")).toBeUndefined();
  });

  it("dry_run reports counts and writes nothing", async () => {
    await seed();
    const before = s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM changes");
    const { json } = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "Acme Supply",
      dry_run: true,
    });
    expect(json).toMatchObject({ blocks_moved: 3, refs_rewritten: 9, dry_run: true });
    expect(json.batch_id).toBeUndefined();
    const after = s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM changes");
    expect(after).toEqual(before);
    expect((await read("Acme Corp"))?.page.name).toBe("Acme Corp");
  });

  it("batch_undo restores the source page, its blocks, every reference and target's properties", async () => {
    await seed();
    const snapshot = contents();
    const { json } = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "Acme Supply",
    });
    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: json.batch_id });
    expect(undo.status).toBe(200);
    const source = await read("Acme Corp");
    expect(shape(source.tree)).toEqual([
      ["contact: sam", [["phone", []]]],
      ["see [[Acme Corp]] itself", []],
    ]);
    expect(source.page.properties).toEqual({
      alias: "Acme, ACME Inc",
      tags: "vendor, supplier",
      status: "active",
    });
    const target = await read("Acme Supply");
    expect(shape(target.tree)).toEqual([["terms: net 30", []]]);
    expect(target.page.properties).toEqual({ tags: "vendor, preferred", region: "eu" });
    expect(contents()).toEqual(snapshot);
    expect((await read("Tagger")).page.properties.tags).toBe("Acme Corp, misc");
  });

  it("refuses a page merged into itself (also via an alias), a journal source, and unknown pages", async () => {
    await seed();
    const self = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "acme", // an alias of the same page
    });
    expect(self.status).toBe(400);
    expect(self.json.error.code).toBe("invalid");

    await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "2026-01-02",
      markdown: "- a day",
    });
    const journal = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "2026-01-02",
      target: "Acme Supply",
    });
    expect(journal.status).toBe(400);
    expect(journal.json.error.message).toContain("journal");

    const missing = await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "Acme Corp",
      target: "No Such Page",
    });
    expect(missing.status).toBe(404);
  });

  it("rewrites a bare #tag to #[[…]] only when the new name cannot be written bare", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "old" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "newer" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Two Words" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Uses",
      markdown: "- one #old.\n- two #old, done",
    });
    await post(s.app, "/api/v1/page.merge", s.writeToken, { source: "old", target: "newer" });
    let c = contents();
    expect(c.get("one #newer.")).toBeDefined();
    expect(c.get("two #newer, done")).toBeDefined();
    await post(s.app, "/api/v1/page.merge", s.writeToken, {
      source: "newer",
      target: "Two Words",
    });
    c = contents();
    expect(c.get("one #[[Two Words]].")).toBeDefined();
    expect(c.get("two #[[Two Words]], done")).toBeDefined();
  });
});
