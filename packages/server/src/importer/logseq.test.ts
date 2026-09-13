import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isId, newId } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { suggestedJournalTitleFormat } from "../journal-format.js";
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

  it("stores a journal under its ISO name, not the source graph's title format (ADR 018)", async () => {
    writeGraphFile("logseq/config.edn", '{:journal/page-title-format "E, dd.MM.yyyy"}');
    writeGraphFile("journals/2026_09_10.md", "- entry\n");

    const stats = await importLogseqGraph(ctx, graphDir);

    const journal = ctx.driver.get<{ name: string }>(
      "SELECT name FROM page WHERE journal_day = 20260910",
    );
    expect(journal?.name).toBe("2026-09-10");
    // The format is not lost, it moves from storage to a suggestion: it is the format this person
    // has been reading for years, so it becomes the client's initial display setting rather than a
    // fact about the data. Without this, 825 imported journals change appearance overnight.
    expect(stats.warnings.some((w) => w.includes("E, dd.MM.yyyy"))).toBe(true);
    expect(suggestedJournalTitleFormat(ctx.driver)).toBe("E, dd.MM.yyyy");
  });

  it("suggests nothing when the graph used the same format we default to", async () => {
    writeGraphFile("journals/2026_09_10.md", "- entry\n");
    await importLogseqGraph(ctx, graphDir);
    expect(suggestedJournalTitleFormat(ctx.driver)).toBeNull();
  });

  it("ignores a title:: override on a journal file — the day already names the page", async () => {
    writeGraphFile("journals/2026_09_10.md", "title:: My Special Thursday\n- entry\n");

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

  it("imports SCHEDULED/DEADLINE dates and hours written without zero padding (B-266)", async () => {
    writeGraphFile(
      "pages/Unpadded.md",
      "- DONE Mirek\n  SCHEDULED: <2023-2-17 Fri>\n- LATER call\n  DEADLINE: <2022-12-8 Thu 9:05>\n",
    );

    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);

    const rows = ctx.driver.all<{
      content: string;
      scheduled_day: number | null;
      deadline_day: number | null;
      deadline_time: string | null;
    }>(
      `SELECT b.content, b.scheduled_day, b.deadline_day, b.deadline_time
       FROM block b JOIN page p ON p.id = b.page_id WHERE p.name = 'Unpadded' ORDER BY b.order_key`,
    );
    expect(rows).toEqual([
      { content: "Mirek", scheduled_day: 20230217, deadline_day: null, deadline_time: null },
      { content: "call", scheduled_day: null, deadline_day: 20221208, deadline_time: "09:05" },
    ]);
  });

  it("imports SCHEDULED/DEADLINE written with one-digit month, day and hour (B-143)", async () => {
    writeGraphFile(
      "journals/2023_02_17.md",
      "- DONE Mirek\n  SCHEDULED: <2023-2-17 Fri>\n- TODO standup\n  DEADLINE: <2023-2-20 Mon 9:30 .+1d>\n",
    );

    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);

    const rows = ctx.driver.all<{
      content: string;
      scheduled_day: number | null;
      deadline_day: number | null;
      deadline_time: string | null;
      repeat: string | null;
    }>(
      "SELECT content, scheduled_day, deadline_day, deadline_time, repeat FROM block ORDER BY content",
    );
    expect(rows).toEqual([
      {
        content: "Mirek",
        scheduled_day: 20230217,
        deadline_day: null,
        deadline_time: null,
        repeat: null,
      },
      {
        content: "standup",
        scheduled_day: null,
        deadline_day: 20230220,
        deadline_time: "09:30",
        repeat: "1d",
      },
    ]);
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

describe("importLogseqGraph: assets", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "nooklet-import-data-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("copies assets/ into the data directory and re-points every link at them", async () => {
    writeGraphFile("assets/photo_1715428076165_0.png", "PNGBYTES");
    writeGraphFile("assets/Cool report.pdf", "PDFBYTES");
    writeGraphFile(
      "pages/Trip.md",
      "- ![photo](../assets/photo_1715428076165_0.png)\n- [the report](../assets/Cool%20report.pdf)\n",
    );
    // Journals write the same `../assets/` prefix; a hand-edited graph may omit the `../`.
    writeGraphFile("journals/2026_09_10.md", "- ![again](assets/photo_1715428076165_0.png)\n");

    const stats = await importLogseqGraph(ctx, graphDir, { dataDir });

    expect(stats.errors).toEqual([]);
    expect(stats.assetsImported).toBe(2);
    expect(stats.danglingAssetLinks).toBe(0);

    const rows = ctx.driver.all<{ id: string; file_name: string; ext: string; mime_type: string }>(
      "SELECT id, file_name, ext, mime_type FROM asset ORDER BY file_name",
    );
    expect(rows.map((r) => [r.file_name, r.ext, r.mime_type])).toEqual([
      ["Cool report.pdf", "pdf", "application/pdf"],
      ["photo_1715428076165_0.png", "png", "image/png"],
    ]);
    for (const r of rows)
      expect(existsSync(join(dataDir, "assets", `${r.id}.${r.ext}`))).toBe(true);

    // The block now carries exactly what asset.upload would have returned, so the client renders
    // it through the same path as an uploaded picture.
    const photo = rows.find((r) => r.ext === "png") as (typeof rows)[number];
    const pdf = rows.find((r) => r.ext === "pdf") as (typeof rows)[number];
    const contents = ctx.driver
      .all<{ content: string }>("SELECT content FROM block ORDER BY content")
      .map((b) => b.content);
    expect(contents).toEqual([
      `![again](assets/${photo.id}.png)`,
      `![photo](assets/${photo.id}.png)`,
      `[the report](assets/${pdf.id}.pdf)`,
    ]);
  });

  it("leaves a link alone and counts it when the file is not in assets/", async () => {
    writeGraphFile("pages/Lost.md", "- ![gone](../assets/never_existed.png)\n");
    const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
    expect(stats.assetsImported).toBe(0);
    expect(stats.danglingAssetLinks).toBe(1);
    expect(ctx.driver.get<{ content: string }>("SELECT content FROM block")?.content).toBe(
      "![gone](../assets/never_existed.png)",
    );
  });

  it("does not copy the same bytes twice across re-runs", async () => {
    writeGraphFile("assets/a.png", "SAME");
    writeGraphFile("pages/One.md", "- ![a](../assets/a.png)\n");
    await importLogseqGraph(ctx, graphDir, { dataDir });
    const again = await importLogseqGraph(ctx, graphDir, { dataDir });
    expect(again.assetsImported).toBe(0);
    expect(ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM asset")?.n).toBe(1);
  });

  it("copies a file larger than the API's 25 MB cap — it is the person's own file", async () => {
    // The two PDFs that stayed dangling on the real graph were 67 MB and 75 MB.
    writeGraphFile("assets/big.pdf", "x".repeat(26 * 1024 * 1024));
    writeGraphFile("pages/Big.md", "- [big](../assets/big.pdf)\n");
    const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
    expect(stats.assetsImported).toBe(1);
    expect(stats.danglingAssetLinks).toBe(0);
    expect(stats.warnings.filter((w) => w.includes("over the"))).toEqual([]);
  });

  it("matches a link to a file whose on-disk name is NFD (macOS) when the link is NFC", async () => {
    const nfc = "Zelený_byznys.pdf";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    writeGraphFile(`assets/${nfd}`, "PDF");
    writeGraphFile("pages/Cz.md", `- [zeleny](../assets/${nfc})\n`);
    const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
    expect(stats.danglingAssetLinks).toBe(0);
    expect(ctx.driver.get<{ content: string }>("SELECT content FROM block")?.content).toMatch(
      /^\[zeleny\]\(assets\/[a-z0-9]+\.pdf\)$/,
    );
  });

  it("does not follow a symlink in assets/ out of the graph (B-127)", async () => {
    // A received graph whose "picture" is a link to the importing user's private key: followed,
    // it became an asset served without authentication at /assets/:id and synced everywhere.
    const outside = mkdtempSync(join(tmpdir(), "nooklet-import-outside-"));
    try {
      const secret = join(outside, "id_ed25519");
      writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY----- test\n");
      writeGraphFile("pages/Photos.md", "- look ![pic](../assets/pic.png)\n");
      mkdirSync(join(graphDir, "assets"));
      symlinkSync(secret, join(graphDir, "assets", "pic.png"));

      const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
      expect(stats.assetsImported).toBe(0);
      expect(ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM asset")?.n).toBe(0);
      expect(stats.warnings).toContain("assets/pic.png: a symbolic link, not followed");
      expect(stats.danglingAssetLinks).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a dangling symlink in assets/ is a warning, not an aborted import (B-127)", async () => {
    writeGraphFile("assets/ok.png", "PNG");
    symlinkSync("/nonexistent/x.png", join(graphDir, "assets", "broken.png"));
    writeGraphFile("pages/One.md", "- ![ok](../assets/ok.png)\n");

    const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
    expect(stats.errors).toEqual([]);
    expect(stats.pagesImported).toBe(1);
    expect(stats.assetsImported).toBe(1);
    expect(stats.warnings).toContain("assets/broken.png: a symbolic link, not followed");
  });

  it("does not follow assets/ itself when it is a symlink (B-127)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nooklet-import-outside-"));
    try {
      writeFileSync(join(outside, "id_ed25519"), "PRIVATE");
      writeGraphFile("pages/One.md", "- [k](../assets/id_ed25519)\n");
      symlinkSync(outside, join(graphDir, "assets"));

      const stats = await importLogseqGraph(ctx, graphDir, { dataDir });
      expect(stats.assetsImported).toBe(0);
      expect(ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM asset")?.n).toBe(0);
      expect(stats.warnings).toContain(
        "assets/ is a symbolic link, not followed: no assets were imported",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("says so, loudly, when there is nowhere to put the assets", async () => {
    writeGraphFile("assets/a.png", "BYTES");
    writeGraphFile("pages/One.md", "- ![a](../assets/a.png)\n");
    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.assetsImported).toBe(0);
    expect(stats.warnings.some((w) => w.includes("assets/ was not imported"))).toBe(true);
  });
});

describe("importLogseqGraph guards", () => {
  it("refuses a graph directory that does not exist (B-110)", async () => {
    const missing = join(tmpdir(), `nooklet-missing-${newId()}`);
    await expect(importLogseqGraph(ctx, missing)).rejects.toThrow(/not a directory/);
  });
});
