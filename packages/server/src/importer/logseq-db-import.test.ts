import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";
import { verifyRebuildParity } from "../verify.js";
import { detectLogseqGraph, importLogseqGraph } from "./logseq.js";
import { U, writeFixtureDbGraph } from "./logseq-db-fixture.js";

let ctx: ServerContext;
let root: string;
let dataDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  root = mkdtempSync(join(tmpdir(), "nooklet-logseq-dbgraph-"));
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-logseq-dbdata-"));
  writeFixtureDbGraph(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function journalBlocks(): Array<{ id: string; content: string; marker: string | null }> {
  return ctx.driver.all(
    `SELECT b.id, b.content, b.marker FROM block b JOIN page p ON p.id = b.page_id
     WHERE p.journal_day = 20260914 AND b.deleted_at IS NULL ORDER BY b.parent_id NULLS FIRST, b.order_key`,
  );
}

describe("detectLogseqGraph", () => {
  it("tells a DB-version graph from a file graph, from the root or from the mirror folder", () => {
    expect(detectLogseqGraph(root).kind).toBe("db");
    expect(detectLogseqGraph(join(root, "mirror")).root).toBe(root);
    expect(detectLogseqGraph(join(root, "mirror", "markdown")).root).toBe(root);
    const fileGraph = mkdtempSync(join(tmpdir(), "nooklet-logseq-filegraph-"));
    try {
      mkdirSync(join(fileGraph, "pages"));
      expect(detectLogseqGraph(fileGraph)).toEqual({
        kind: "file",
        root: fileGraph,
        markdownDir: fileGraph,
      });
    } finally {
      rmSync(fileGraph, { recursive: true, force: true });
    }
  });

  it("says how to turn the mirror on when a DB graph has none", () => {
    rmSync(join(root, "mirror"), { recursive: true });
    expect(() => detectLogseqGraph(root)).toThrow(/Markdown Mirror/);
  });
});

describe("importLogseqGraph on a DB-version graph (B-715)", () => {
  it("turns the asset block's timestamp line into an image of the imported file", async () => {
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    expect(stats.format).toBe("db");
    expect(stats.errors).toEqual([]);
    const blocks = journalBlocks();
    const image = blocks.find((b) => b.content.startsWith("!["));
    expect(image?.content).toMatch(/^!\[2026-09-14-10-20-30\]\(assets\/[0-9a-z]+\.png\)$/);
    expect(blocks.some((b) => b.content === "2026-09-14-10-20-30")).toBe(false);
    expect(stats.logseqDb?.assetLinesResolved).toBe(1);
    expect(stats.danglingAssetLinks).toBe(0);
  });

  it("turns a [[uuid]] ref to an asset into a file link, and to a page into its name", async () => {
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    const contents = journalBlocks().map((b) => b.content);
    expect(contents).toContainEqual(
      expect.stringMatching(/^\[seed-catalogue\]\(assets\/\w+\.pdf\)$/),
    );
    expect(contents.join("\n")).not.toContain(U.catalogue);
    expect(contents).toContain("Planted [[Garden Plans]] today");
    expect(stats.logseqDb?.assetRefsResolved).toBe(1);
    // No page was minted for a uuid.
    expect(
      ctx.driver.get("SELECT 1 FROM page WHERE name LIKE '00000000-%' AND deleted_at IS NULL"),
    ).toBeUndefined();
  });

  it("turns a [[uuid]] ref to a block into a block ref to the imported block", async () => {
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    const blocks = journalBlocks();
    const planted = blocks.find((b) => b.content.startsWith("Planted"));
    expect(blocks.find((b) => b.content.startsWith("see"))?.content).toBe(`see ((${planted?.id}))`);
    expect(stats.logseqDb?.blockUuidRefsResolved).toBe(1);
    expect(stats.logseqDb?.uuidRefsUnresolved).toBe(0);
  });

  it("restores SCHEDULED from the database and keeps the task marker", async () => {
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    const task = journalBlocks().find((b) => b.content === "Water the plants");
    expect(task?.marker).toBe("TODO");
    expect(
      ctx.driver.get("SELECT scheduled_day, scheduled_time FROM block WHERE id = ?", [task?.id]),
    ).toEqual({ scheduled_day: 20260920, scheduled_time: "10:00" });
    // The `* Scheduled::` list item became a property, not an empty child block.
    expect(journalBlocks().filter((b) => b.content.trim() === "")).toEqual([]);
    expect(stats.logseqDb?.datesRestored).toBe(1);
  });

  it("marks Logseq's favourites as favourites", async () => {
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    expect(stats.favoritesMarked).toBe(1);
    const fav = ctx.driver.get<{ value: string }>(
      `SELECT pp.value FROM page_prop pp JOIN page p ON p.id = pp.page_id
       WHERE p.name = 'Garden Plans' AND pp.key = 'favorite'`,
    );
    expect(fav?.value).toBe("true");
  });

  it("never mints a page named after a uuid it cannot resolve", async () => {
    // The ref's target is not in the mirror at all (the mirror is a stale export).
    writeFileSync(
      join(root, "mirror", "markdown", "journals", "2026_09_14.md"),
      `- see [[${U.late}]]\n`,
    );
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    expect(stats.logseqDb?.uuidRefsUnresolved).toBe(1);
    expect(stats.danglingBlockRefs).toBe(1);
    expect(
      ctx.driver.get("SELECT 1 FROM page WHERE name LIKE '00000000-%' AND deleted_at IS NULL"),
    ).toBeUndefined();
  });

  it("leaves an ambiguous asset title as text and reports it", async () => {
    // A second, identical line next to the asset block and a reordered mirror: position no longer
    // identifies the asset, and the title is not unique.
    writeFileSync(
      join(root, "mirror", "markdown", "journals", "2026_09_14.md"),
      "- 2026-09-14-10-20-30\n- 2026-09-14-10-20-30\n",
    );
    const stats = await importLogseqGraph(ctx, root, { dataDir });
    expect(stats.logseqDb?.assetLinesResolved).toBe(0);
    expect(stats.logseqDb?.assetLinesAmbiguous).toBe(1);
    expect(journalBlocks().map((b) => b.content)).toEqual([
      "2026-09-14-10-20-30",
      "2026-09-14-10-20-30",
    ]);
  });

  it("leaves the op log replayable (verify)", async () => {
    await importLogseqGraph(ctx, root, { dataDir });
    expect(verifyRebuildParity(ctx.driver).ok).toBe(true);
  });
});

describe("file-graph favourites", () => {
  it("marks the pages config.edn's :favorites names", async () => {
    const g = mkdtempSync(join(tmpdir(), "nooklet-logseq-filegraph-"));
    try {
      mkdirSync(join(g, "pages"));
      mkdirSync(join(g, "logseq"));
      writeFileSync(join(g, "pages", "Seed Swap.md"), "- bring beans\n");
      writeFileSync(join(g, "pages", "Compost.md"), "- turn it\n");
      writeFileSync(
        join(g, "logseq", "config.edn"),
        '{:favorites ["seed swap" "[[Compost]]" "no such page"]\n ;; :favorites ["ignored"]\n :hidden []}',
      );
      const stats = await importLogseqGraph(ctx, g);
      expect(stats.format).toBe("file");
      expect(stats.favoritesMarked).toBe(2);
      expect(stats.favoritesMissing).toBe(1);
      const favs = ctx.driver
        .all<{ name: string }>(
          `SELECT p.name FROM page p JOIN page_prop pp ON pp.page_id = p.id
           WHERE pp.key = 'favorite' AND pp.value = 'true' ORDER BY p.name`,
        )
        .map((r) => r.name);
      expect(favs).toEqual(["Compost", "Seed Swap"]);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });
});
