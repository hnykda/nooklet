import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

function allContents(): string[] {
  return s.serverCtx.driver
    .all<{ content: string }>("SELECT content FROM block WHERE deleted_at IS NULL ORDER BY content")
    .map((r) => r.content);
}

async function seed(): Promise<void> {
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Spelling",
    markdown: "- the colour of money\n  - Colour me surprised\n- no match here",
  });
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "More",
    markdown: "- COLOUR twice: colour\n- Barva, česká: Černá",
  });
}

async function replace(body: Record<string, unknown>): Promise<{ status: number; json: JsonAny }> {
  return post(s.app, "/api/v1/graph.replace", s.writeToken, body);
}

describe("graph.replace", () => {
  it("dry_run previews every block that would change, before and after, and writes nothing", async () => {
    await seed();
    const before = allContents();
    const { status, json } = await replace({
      query: "colour",
      replacement: "color",
      dry_run: true,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      blocks_matched: 3,
      occurrences: 4,
      truncated: false,
      dry_run: true,
    });
    expect(json.batch_id).toBeUndefined();
    expect(json.matches.map((m: JsonAny) => [m.page, m.before, m.after, m.count])).toEqual([
      ["More", "COLOUR twice: colour", "color twice: color", 2],
      ["Spelling", "the colour of money", "the color of money", 1],
      ["Spelling", "Colour me surprised", "color me surprised", 1],
    ]);
    expect(allContents()).toEqual(before);
  });

  it("the real run changes every match in ONE batch that batch_undo reverses", async () => {
    await seed();
    const before = allContents();
    const { json } = await replace({ query: "colour", replacement: "color" });
    expect(json.blocks_matched).toBe(3);
    expect(typeof json.batch_id).toBe("string");
    expect(allContents()).toEqual([
      "Barva, česká: Černá",
      "color me surprised",
      "color twice: color",
      "no match here",
      "the color of money",
    ]);
    const rows = s.serverCtx.driver.all<{ batch_id: string }>(
      "SELECT DISTINCT batch_id FROM changes WHERE entity_type = 'block' AND after_json LIKE '%color%'",
    );
    expect(rows).toEqual([{ batch_id: json.batch_id }]);

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, { batch_id: json.batch_id });
    expect(undo.status).toBe(200);
    expect(allContents()).toEqual(before);
  });

  it("case_sensitive matches exactly; case-insensitive folds non-ASCII letters too", async () => {
    await seed();
    const exact = await replace({ query: "Colour", case_sensitive: true, dry_run: true });
    expect(exact.json.blocks_matched).toBe(1);
    const czech = await replace({ query: "černá", replacement: "bílá", dry_run: true });
    expect(czech.json.matches[0].after).toBe("Barva, česká: bílá");
  });

  it("regex: true reads the pattern as a RegExp and lets replacement use groups", async () => {
    await seed();
    const { json } = await replace({
      query: "(colou?r) of (\\w+)",
      replacement: "$2-$1",
      regex: true,
      dry_run: true,
    });
    expect(json.blocks_matched).toBe(1);
    expect(json.matches[0].after).toBe("the money-colour");
  });

  it("a literal replacement containing $1 stays literal", async () => {
    await seed();
    const { json } = await replace({ query: "money", replacement: "$1 & $&", dry_run: true });
    expect(json.matches[0].after).toBe("the colour of $1 & $&");
  });

  it("pages restricts the scan", async () => {
    await seed();
    const { json } = await replace({ query: "colour", pages: ["More"], dry_run: true });
    expect(json.blocks_matched).toBe(1);
    expect(json.matches[0].page).toBe("More");
    const none = await replace({ query: "colour", pages: ["Nope"], dry_run: true });
    expect(none.json.blocks_matched).toBe(0);
  });

  it("rejects an invalid regex, an empty-matching pattern, and too many blocks", async () => {
    await seed();
    const bad = await replace({ query: "(", regex: true });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid");
    const empty = await replace({ query: "x*", regex: true });
    expect(empty.status).toBe(400);
    expect(empty.json.error.message).toContain("empty string");
    const many = await replace({ query: "colour", replacement: "c", max_blocks: 2 });
    expect(many.status).toBe(413);
    expect(many.json.error.code).toBe("too_large");
    expect(many.json.error.details.blocks_matched).toBe(3);
    // Nothing was written by any of the three.
    expect(allContents()).toContain("the colour of money");
  });

  it("a backtracking pattern is refused within the time budget, and the server answers meanwhile (B-125)", async () => {
    // `(a+)+$` against 40 `a`s and a `!` backtracks ~2^40 steps. Run on the event loop, as it
    // was, 25 `a`s already held `/healthz` for 5 s; 40 would never return.
    const n = 40;
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Redos",
      markdown: `- ${"a".repeat(n)}!\n- an ordinary block`,
    });
    const started = Date.now();
    const pending = replace({ query: "(a+)+$", regex: true, replacement: "x", dry_run: true });
    // Asked 100 ms in; timed from `started`, because a blocked event loop delays the timer itself.
    const health = new Promise<{ status: number; ms: number }>((resolve) => {
      setTimeout(async () => {
        const res = await s.app.request("/healthz");
        resolve({ status: res.status, ms: Date.now() - started });
      }, 100);
    });
    const { status, json } = await pending;
    const totalMs = Date.now() - started;

    expect((await health).status).toBe(200);
    expect((await health).ms).toBeLessThan(1000);
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.message).toContain("too long");
    expect(totalMs).toBeLessThan(6000);
    expect(allContents()).toContain(`${"a".repeat(n)}!`);
  }, 20_000);

  it("refuses a replacement that would grow a block past the content cap, even in a dry run (B-125)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Grow",
      markdown: `- ${"a".repeat(60)}`,
    });
    // 60 × 2000 = 120,000 characters: more than block.update would ever accept.
    const body = { query: "a", replacement: "x".repeat(2000) };
    const preview = await replace({ ...body, dry_run: true });
    expect(preview.status).toBe(413);
    expect(preview.json.error.code).toBe("too_large");
    expect(preview.json.error.details.length).toBe(120_000);
    const real = await replace(body);
    expect(real.status).toBe(413);
    expect(allContents()).toEqual(["a".repeat(60)]);
  });

  it("still edits a block that is already past the cap, as long as the edit does not grow it", async () => {
    // The owner's graph has a 120,016-character block; a cap on the result alone would lock it.
    const big = `${"b".repeat(100_050)} tail`;
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Big", markdown: `- ${big}` });
    const { status, json } = await replace({ query: "tail", replacement: "TAIL" });
    expect(status).toBe(200);
    expect(json.blocks_matched).toBe(1);
    expect(allContents()).toEqual([`${"b".repeat(100_050)} TAIL`]);
  });

  it("a replacement too large to even build is too_large, and the server carries on (B-125)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Explode",
      markdown: `- ${"a".repeat(100_000)}`,
    });
    // 200 million characters for one block: past the scan worker's heap, if not V8's string limit.
    const { status, json } = await replace({
      query: "a",
      replacement: "x".repeat(2000),
      dry_run: true,
    });
    expect(status).toBe(413);
    expect(json.error.code).toBe("too_large");
    const health = await s.app.request("/healthz");
    expect(health.status).toBe(200);
  }, 20_000);

  it("limit caps the preview list, not the counts", async () => {
    await seed();
    const { json } = await replace({ query: "colour", limit: 1, dry_run: true });
    expect(json.matches).toHaveLength(1);
    expect(json.blocks_matched).toBe(3);
    expect(json.truncated).toBe(true);
  });

  it("a read-scoped token cannot even preview", async () => {
    await seed();
    const { status } = await post(s.app, "/api/v1/graph.replace", s.readToken, {
      query: "colour",
      dry_run: true,
    });
    expect(status).toBe(403);
  });
});
