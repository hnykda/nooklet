import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isId, newId } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { importLogseqGraph, parseLogseqConfigEdn } from "./logseq.js";

let ctx: ServerContext;
let graphDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  graphDir = mkdtempSync(join(tmpdir(), "nooklet-logseq-import-"));
});

afterEach(() => {
  rmSync(graphDir, { recursive: true, force: true });
});

function writeGraphFile(relPath: string, content: string): void {
  const full = join(graphDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Mirrors `apply-ops.test.ts`'s own fixture helper: create a page directly, bypassing the
 *  importer, so a test can force a name collision the importer must survive. */
function createPage(name: string): string {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "page.create", name, journalDay: null, createdAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function getPage(key: string) {
  return ctx.driver.get<{ id: string; name: string; journal_day: number | null }>(
    "SELECT id, name, journal_day FROM page WHERE key = ?",
    [key],
  );
}

describe("parseLogseqConfigEdn", () => {
  it("extracts the handful of keys that matter, ignoring commented-out examples", () => {
    const text = `{:meta/version 1
 ;; :journal/page-title-format "EEE do, MMM yyyy"
 :journal/page-title-format "E, dd.MM.yyyy"
 :file/name-format :triple-lowbar
 :favorites ["TODO" "Useful Constants"]}`;
    const config = parseLogseqConfigEdn(text);
    expect(config.journalPageTitleFormat).toBe("E, dd.MM.yyyy");
    expect(config.fileNameFormat).toBe("triple-lowbar");
  });

  it("falls back to Logseq's documented defaults when keys are absent", () => {
    const config = parseLogseqConfigEdn("{:meta/version 1}");
    expect(config.journalPageTitleFormat).toBe("MMM do, yyyy");
    expect(config.journalFileNameFormat).toBe("yyyy_MM_dd");
    expect(config.fileNameFormat).toBe("legacy");
  });
});

describe("importLogseqGraph: basic pages + journals", () => {
  it("imports a page and a journal with nested blocks", async () => {
    writeGraphFile("pages/Hello World.md", "- first block\n- second block\n\t- child block\n");
    writeGraphFile("journals/2026_09_10.md", "- journal entry\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.errors).toEqual([]);
    expect(stats.pagesImported).toBe(1);
    expect(stats.journalsImported).toBe(1);
    expect(stats.blocksImported).toBe(4);

    const page = getPage("hello world");
    expect(page?.name).toBe("Hello World");
    expect(page?.journal_day).toBeNull();

    const journal = ctx.driver.get<{ name: string }>(
      "SELECT name FROM page WHERE journal_day = 20260910",
    );
    expect(journal).toBeDefined();
  });

  it("uses config.edn's :journal/page-title-format for the journal page's display name", async () => {
    writeGraphFile("logseq/config.edn", '{:journal/page-title-format "yyyy-MM-dd"}');
    writeGraphFile("journals/2026_09_10.md", "- entry\n");

    await importLogseqGraph(ctx, graphDir);

    const journal = ctx.driver.get<{ name: string }>(
      "SELECT name FROM page WHERE journal_day = 20260910",
    );
    expect(journal?.name).toBe("2026-09-10");
  });
});

describe("importLogseqGraph: page name resolution", () => {
  it("decodes triple-lowbar namespace file names (A___B___C.md -> A/B/C)", async () => {
    writeGraphFile("pages/A___B___C.md", "- nested content\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.errors).toEqual([]);
    const page = getPage("a/b/c");
    expect(page?.name).toBe("A/B/C");
  });

  it("decodes legacy %2F-encoded file names even with no config.edn present", async () => {
    writeGraphFile("pages/A%2FB%2FC.md", "- legacy encoded\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.errors).toEqual([]);
    const page = getPage("a/b/c");
    expect(page?.name).toBe("A/B/C");
  });

  it("lets a title:: page property override the filename-derived name", async () => {
    writeGraphFile("pages/some-file.md", "title:: My Real Title\n\n- content\n");

    await importLogseqGraph(ctx, graphDir);

    expect(getPage("some-file")).toBeUndefined();
    const page = getPage("my real title");
    expect(page?.name).toBe("My Real Title");
  });

  it("keeps the first file and warns when two files resolve to the same page name", async () => {
    writeGraphFile("pages/FileOne.md", "title:: Shared Name\n\n- from file one\n");
    writeGraphFile("pages/FileTwo.md", "title:: Shared Name\n\n- from file two\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.pagesImported).toBe(1);
    expect(stats.warnings.some((w) => w.includes("Shared Name"))).toBe(true);
    const block = ctx.driver.get<{ content: string }>(
      "SELECT content FROM block WHERE content LIKE 'from file%'",
    );
    expect(block?.content).toBe("from file one");
  });
});

describe("importLogseqGraph: block refs", () => {
  it("rewrites a ((uuid)) block ref to the target block's new nooklet id", async () => {
    const uuid = "61506710-484c-46d5-9983-3d1651ec02c8";
    writeGraphFile(
      "pages/RefSource.md",
      `- Target block\n  id:: ${uuid}\n- See ((${uuid})) for details\n`,
    );

    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);
    expect(stats.danglingBlockRefs).toBe(0);

    const target = ctx.driver.get<{ id: string }>(
      "SELECT id FROM block WHERE content = 'Target block'",
    );
    expect(target).toBeDefined();
    expect(isId(target?.id ?? "")).toBe(true);

    const referencing = ctx.driver.get<{ content: string }>(
      "SELECT content FROM block WHERE content LIKE 'See %'",
    );
    expect(referencing?.content).toBe(`See ((${target?.id})) for details`);
  });

  it("leaves a dangling ((uuid)) block ref untouched when its target doesn't exist", async () => {
    const danglingUuid = "00000000-0000-4000-8000-000000000000";
    writeGraphFile("pages/Dangling.md", `- See ((${danglingUuid})) nowhere\n`);

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.errors).toEqual([]);
    expect(stats.danglingBlockRefs).toBe(1);
    const page = getPage("dangling");
    const block = ctx.driver.get<{ content: string }>(
      "SELECT content FROM block WHERE page_id = ?",
      [page?.id],
    );
    expect(block?.content).toBe(`See ((${danglingUuid})) nowhere`);
  });
});

describe("importLogseqGraph: task markers, scheduling, nesting", () => {
  it("imports task markers, priority, and SCHEDULED as reserved block columns", async () => {
    writeGraphFile(
      "pages/Tasks.md",
      "- TODO Write report\n  SCHEDULED: <2026-09-12 Sat>\n- DONE [#A] Book room\n",
    );

    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);

    const todo = ctx.driver.get<{ marker: string; scheduled_day: number | null }>(
      "SELECT marker, scheduled_day FROM block WHERE content LIKE 'Write report%'",
    );
    expect(todo?.marker).toBe("TODO");
    expect(todo?.scheduled_day).toBe(20260912);

    const done = ctx.driver.get<{ marker: string; priority: string }>(
      "SELECT marker, priority FROM block WHERE content LIKE 'Book room%'",
    );
    expect(done?.marker).toBe("DONE");
    expect(done?.priority).toBe("A");
  });

  it("preserves nested block parent/child structure and per-level order", async () => {
    writeGraphFile("pages/Nested.md", "- a\n\t- b\n\t- c\n\t\t- d\n- e\n");

    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);
    expect(stats.blocksImported).toBe(5);

    const page = getPage("nested");
    const roots = ctx.driver.all<{ id: string; content: string }>(
      "SELECT id, content FROM block WHERE page_id = ? AND parent_id IS NULL ORDER BY order_key",
      [page?.id],
    );
    expect(roots.map((r) => r.content)).toEqual(["a", "e"]);

    const aChildren = ctx.driver.all<{ id: string; content: string }>(
      "SELECT id, content FROM block WHERE parent_id = ? ORDER BY order_key",
      [roots[0]?.id],
    );
    expect(aChildren.map((r) => r.content)).toEqual(["b", "c"]);

    const cChildren = ctx.driver.all<{ content: string }>(
      "SELECT content FROM block WHERE parent_id = ? ORDER BY order_key",
      [aChildren[1]?.id],
    );
    expect(cChildren.map((r) => r.content)).toEqual(["d"]);
  });
});

describe("importLogseqGraph: per-page failure isolation", () => {
  it("records an error for a colliding page but still imports the rest of the graph", async () => {
    createPage("Colliding");
    writeGraphFile("pages/Colliding.md", "- should not be imported\n");
    writeGraphFile("pages/Fine.md", "- should still import\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    expect(stats.pagesSkipped).toBe(1);
    expect(stats.pagesImported).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toMatch(/Colliding/);

    const fine = getPage("fine");
    expect(fine).toBeDefined();
    const fineBlock = ctx.driver.get<{ content: string }>(
      "SELECT content FROM block WHERE page_id = ?",
      [fine?.id],
    );
    expect(fineBlock?.content).toBe("should still import");

    // The pre-existing "Colliding" page is untouched (no blocks were attributed to it).
    const collidingBlocks = ctx.driver.all(
      "SELECT id FROM block WHERE page_id = (SELECT id FROM page WHERE key = 'colliding')",
    );
    expect(collidingBlocks).toHaveLength(0);
  });
});
