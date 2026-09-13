import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalDayToFileName,
  newId,
  type Priority,
  type Properties,
  pageMirrorOutline,
  pageMirrorPath,
  pageNameToFileName,
  parseOutline,
  readPageOutline,
  serializeOutline,
  type TaskMarker,
} from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import {
  changesHead,
  exportAll,
  exportPage,
  isOwnWrite,
  pagesTouchedSince,
  renderPageToOutline,
} from "./export.js";

let ctx: ServerContext;
let dataDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-mirror-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createPage(
  name: string,
  opts: { journalDay?: number | null; properties?: Properties } = {},
): string {
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
        payload: {
          kind: "page.create",
          name,
          journalDay: opts.journalDay ?? null,
          properties: opts.properties,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function createBlock(
  pageId: string,
  content: string,
  opts: {
    parentId?: string | null;
    order?: string;
    marker?: TaskMarker | null;
    priority?: Priority | null;
    collapsed?: boolean;
    properties?: Properties;
  } = {},
): string {
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
        payload: {
          kind: "block.create",
          place: { pageId, parentId: opts.parentId ?? null, order: opts.order ?? "a0" },
          content,
          marker: opts.marker ?? null,
          priority: opts.priority ?? null,
          collapsed: opts.collapsed ?? false,
          properties: opts.properties,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function setBlockProp(blockId: string, key: string, value: string | null): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: blockId,
        payload: { kind: "block.prop", key, value },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

function renamePage(pageId: string, name: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [{ id: hlc, hlc, device: "aaaaaaaa", entity: pageId, payload: { kind: "page.rename", name } }],
    { origin: "user", actor: "test" },
  );
}

function deletePage(pageId: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: pageId,
        payload: { kind: "page.delete", deletedAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

function deleteBlock(blockId: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: blockId,
        payload: { kind: "block.delete", deletedAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

describe("renderPageToOutline / exportPage: basic round trip", () => {
  it("round-trips a page with nested blocks and page/block properties through parseOutline", () => {
    const pageId = createPage("Round Trip Page", { properties: { type: "project" } });
    const parentId = createBlock(pageId, "Parent block", { properties: { status: "active" } });
    const childId = createBlock(pageId, "Child block", {
      parentId,
      marker: "TODO",
      priority: "A",
    });

    const rendered = renderPageToOutline(ctx.driver, pageId);
    expect(rendered.name).toBe("Round Trip Page");
    expect(rendered.journalDay).toBeNull();
    expect(rendered.parsed.properties).toEqual({ type: "project" });

    const result = exportPage(ctx.driver, dataDir, pageId);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(`pages/${pageNameToFileName("Round Trip Page")}.md`);

    const text = readFileSync(join(dataDir, result.path), "utf8");
    const parsed = parseOutline(text);

    expect(parsed.properties).toEqual({ type: "project" });
    expect(parsed.blocks).toHaveLength(1);
    const parentNode = parsed.blocks[0] as (typeof parsed.blocks)[number];
    expect(parentNode.id).toBe(parentId);
    expect(parentNode.content).toBe("Parent block");
    expect(parentNode.properties).toEqual({ status: "active" });
    expect(parentNode.children).toHaveLength(1);
    const childNode = parentNode.children[0] as (typeof parentNode.children)[number];
    expect(childNode.id).toBe(childId);
    expect(childNode.content).toBe("Child block");
    expect(childNode.marker).toBe("TODO");
    expect(childNode.priority).toBe("A");
  });

  // B-390: 441 of the owner's 952 mirror files read back differently — every empty block (`- ^id`)
  // came back as the text `^id` with no id. B-310: a task opening with a code fence lost its marker.
  it("reads back empty blocks, a fence-first task and a blank-line-first task as written", () => {
    const pageId = createPage("Mirror Shapes");
    createBlock(pageId, "", { order: "a0" });
    const task = createBlock(pageId, "```js\n- not a bullet\n```", {
      order: "a1",
      marker: "TODO",
      priority: "B",
      properties: { foo: "bar" },
    });
    createBlock(pageId, "", { order: "a0", parentId: task, marker: "LATER" });
    createBlock(pageId, "\n> quoted after an empty line 1", { order: "a2", marker: "LATER" });

    const result = exportPage(ctx.driver, dataDir, pageId);
    const text = readFileSync(join(dataDir, result.path), "utf8");
    expect(text).toContain(`- TODO [#B] ^${task}\n  foo:: bar\n  \`\`\`js\n`);
    const written = renderPageToOutline(ctx.driver, pageId).parsed;
    expect(written.blocks).toHaveLength(3);
    expect(parseOutline(text)).toEqual(written);
  });

  it("exports a journal page to journals/<file>.md", () => {
    const day = 20260910;
    const pageId = createPage("2026-09-10", { journalDay: day });
    createBlock(pageId, "Journal entry");

    const expectedPath = `journals/${journalDayToFileName(day)}.md`;
    expect(pageMirrorPath({ name: "2026-09-10", journalDay: day })).toBe(expectedPath);

    const result = exportPage(ctx.driver, dataDir, pageId);
    expect(result.path).toBe(expectedPath);
    expect(existsSync(join(dataDir, result.path))).toBe(true);
  });
});

describe("ADR 011 reserved property re-expansion", () => {
  it("re-expands scheduled/deadline/repeat/done into property lines and round-trips via parseOutline", () => {
    const pageId = createPage("Tasks");
    const blockId = createBlock(pageId, "Do the thing", { marker: "DONE" });
    setBlockProp(blockId, "scheduled", "2026-09-12");
    setBlockProp(blockId, "deadline", "2026-09-14 14:00");
    setBlockProp(blockId, "repeat", "1w");
    setBlockProp(blockId, "done", "2026-09-10T08:30:00Z");

    const result = exportPage(ctx.driver, dataDir, pageId);
    const text = readFileSync(join(dataDir, result.path), "utf8");

    expect(text).toContain("scheduled:: 2026-09-12");
    expect(text).toContain("deadline:: 2026-09-14 14:00");
    expect(text).toContain("repeat:: 1w");
    expect(text).toContain("done:: 2026-09-10T08:30:00Z");

    const parsed = parseOutline(text);
    const node = parsed.blocks[0] as (typeof parsed.blocks)[number];
    expect(node.properties.scheduled).toBe("2026-09-12");
    expect(node.properties.deadline).toBe("2026-09-14 14:00");
    expect(node.properties.repeat).toBe("1w");
    expect(node.properties.done).toBe("2026-09-10T08:30:00Z");
  });

  it("omits scheduled/deadline time-of-day when none was set", () => {
    const pageId = createPage("Tasks 2");
    const blockId = createBlock(pageId, "No time set");
    setBlockProp(blockId, "scheduled", "2026-12-25");

    const result = exportPage(ctx.driver, dataDir, pageId);
    const text = readFileSync(join(dataDir, result.path), "utf8");
    expect(text).toContain("scheduled:: 2026-12-25");
    expect(text).not.toContain("scheduled:: 2026-12-25 ");
  });
});

describe("exportPage: echo suppression / no-op writes", () => {
  it("skips the write and returns changed:false when nothing changed since the last export", () => {
    const pageId = createPage("Stable Page");
    createBlock(pageId, "content");
    const first = exportPage(ctx.driver, dataDir, pageId);
    expect(first.changed).toBe(true);

    const rowBefore = ctx.driver.get<{ written_at: number }>(
      "SELECT written_at FROM mirror_file WHERE page_id = ?",
      [pageId],
    );

    const second = exportPage(ctx.driver, dataDir, pageId);
    expect(second.changed).toBe(false);
    expect(second.contentHash).toBe(first.contentHash);

    const rowAfter = ctx.driver.get<{ written_at: number }>(
      "SELECT written_at FROM mirror_file WHERE page_id = ?",
      [pageId],
    );
    expect(rowAfter?.written_at).toBe(rowBefore?.written_at);

    const countRow = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM mirror_file WHERE page_id = ?",
      [pageId],
    );
    expect(countRow?.n).toBe(1);
  });
});

describe("exportPage: soft-deleted blocks", () => {
  it("omits a soft-deleted block and its subtree while keeping live siblings", () => {
    const pageId = createPage("Deletion Page");
    const keepId = createBlock(pageId, "keep me", { order: "a0" });
    const deleteMeId = createBlock(pageId, "delete me", { order: "a1" });
    const childOfDeletedId = createBlock(pageId, "child of deleted", { parentId: deleteMeId });

    deleteBlock(deleteMeId);

    const result = exportPage(ctx.driver, dataDir, pageId);
    const parsed = parseOutline(readFileSync(join(dataDir, result.path), "utf8"));

    const ids = parsed.blocks.map((b) => b.id);
    expect(ids).toEqual([keepId]);
    expect(ids).not.toContain(deleteMeId);
    expect(ids).not.toContain(childOfDeletedId);
  });
});

describe("exportPage: page rename changes the export path", () => {
  it("deletes the old mirror file when a page rename changes its export path", () => {
    const pageId = createPage("Old Name");
    createBlock(pageId, "content");
    const first = exportPage(ctx.driver, dataDir, pageId);
    const oldAbsPath = join(dataDir, first.path);
    expect(existsSync(oldAbsPath)).toBe(true);

    renamePage(pageId, "New Name");
    const second = exportPage(ctx.driver, dataDir, pageId);

    expect(second.path).not.toBe(first.path);
    expect(second.path).toBe(`pages/${pageNameToFileName("New Name")}.md`);
    expect(existsSync(oldAbsPath)).toBe(false);
    expect(existsSync(join(dataDir, second.path))).toBe(true);

    const rows = ctx.driver.all<{ path: string }>(
      "SELECT path FROM mirror_file WHERE page_id = ?",
      [pageId],
    );
    expect(rows).toEqual([{ path: second.path }]);
  });
});

describe("isOwnWrite", () => {
  it("identifies a matching buffer as our own write and rejects a non-matching one", () => {
    const pageId = createPage("Echo Page");
    createBlock(pageId, "content");
    const result = exportPage(ctx.driver, dataDir, pageId);
    const buf = readFileSync(join(dataDir, result.path));

    expect(isOwnWrite(ctx.driver, result.path, buf)).toBe(true);
    expect(isOwnWrite(ctx.driver, result.path, Buffer.from("something completely different"))).toBe(
      false,
    );
    expect(isOwnWrite(ctx.driver, "pages/does-not-exist.md", buf)).toBe(false);
  });
});

describe("exportAll", () => {
  it("exports every live page and cleans up the mirror file once a page is soft-deleted", () => {
    const p1 = createPage("Page One");
    createBlock(p1, "one");
    const p2 = createPage("Page Two");
    createBlock(p2, "two");

    const first = exportAll(ctx.driver, dataDir);
    expect(first.exported).toBe(2);
    expect(first.deleted).toBe(0);

    const p1Path = join(dataDir, pageMirrorPath({ name: "Page One", journalDay: null }));
    expect(existsSync(p1Path)).toBe(true);

    deletePage(p1);
    const second = exportAll(ctx.driver, dataDir);
    expect(second.deleted).toBe(1);
    expect(existsSync(p1Path)).toBe(false);

    const row = ctx.driver.get("SELECT * FROM mirror_file WHERE page_id = ?", [p1]);
    expect(row).toBeUndefined();
  });
});

describe("exportAll with sinceSeq (B-260)", () => {
  it("renders only the pages a change after the cursor touched, whatever the op kind", () => {
    const quiet = createPage("Quiet Page");
    createBlock(quiet, "untouched");
    const renamed = createPage("Before Rename");
    createBlock(renamed, "body");
    const from = createPage("Move From");
    const moving = createBlock(from, "travels");
    const to = createPage("Move To");
    createBlock(to, "here");
    expect(exportAll(ctx.driver, dataDir).exported).toBe(4);

    const cursor = changesHead(ctx.driver);
    expect(pagesTouchedSince(ctx.driver, cursor)).toEqual([]);

    renamePage(renamed, "After Rename");
    const hlc = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: moving,
          payload: { kind: "block.place", place: { pageId: to, parentId: null, order: "a1" } },
        },
      ],
      { origin: "user", actor: "test" },
    );

    // The page it left and the page it joined both count; the quiet page does not.
    expect(new Set(pagesTouchedSince(ctx.driver, cursor))).toEqual(new Set([renamed, from, to]));
    const r = exportAll(ctx.driver, dataDir, { sinceSeq: cursor });
    expect(r).toEqual({ exported: 3, skipped: 1, deleted: 0, failed: [] });
    expect(existsSync(join(dataDir, "pages", "After Rename.md"))).toBe(true);
    expect(existsSync(join(dataDir, "pages", "Before Rename.md"))).toBe(false);
    expect(readFileSync(join(dataDir, "pages", "Move From.md"), "utf8")).not.toContain("travels");
    expect(readFileSync(join(dataDir, "pages", "Move To.md"), "utf8")).toContain("travels");
  });
});

describe("exportAll rebuilds missing files (B-262)", () => {
  it("rewrites a page whose file is gone even though mirror_file says it is up to date", () => {
    const pageId = createPage("Vanished File");
    createBlock(pageId, "still in the database");
    createPage("Still There");
    expect(exportAll(ctx.driver, dataDir).exported).toBe(2);

    // A database copied without its pages/, or a file deleted by hand: the row stays, the file
    // does not.
    const file = join(dataDir, pageMirrorPath({ name: "Vanished File", journalDay: null }));
    rmSync(file);

    expect(exportAll(ctx.driver, dataDir)).toEqual({
      exported: 1,
      skipped: 1,
      deleted: 0,
      failed: [],
    });
    expect(readFileSync(file, "utf8")).toContain("still in the database");
  });
});

describe("pages whose file cannot be written as named (B-126)", () => {
  // 300 characters of Czech: ~350 UTF-8 bytes, past the 255-byte file-name limit of APFS/ext4,
  // and well inside the 512 characters a page name may have.
  const longName = "Poznámky z porady o rozpočtu na příští čtvrtletí ".repeat(8).slice(0, 300);

  function pagesDir(): string[] {
    return readdirSync(join(dataDir, "pages")).sort();
  }

  it("a name past NAME_MAX gets a shortened, hash-suffixed file that keeps the full name as title::", () => {
    const alpha = createPage("Alpha");
    createBlock(alpha, "a");
    exportAll(ctx.driver, dataDir);

    const long = createPage(longName);
    createBlock(long, "long");
    const zeta = createPage("Zeta");
    createBlock(zeta, "z");
    deletePage(alpha);

    const result = exportAll(ctx.driver, dataDir);
    expect(result.failed).toEqual([]);
    const files = pagesDir();
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files).toContain("Zeta.md");
    expect(files).not.toContain("Alpha.md");

    const longFile = files.find((f) => f.startsWith("Pozn")) as string;
    expect(Buffer.byteLength(longFile, "utf8")).toBeLessThanOrEqual(255);
    expect(longFile).toMatch(/~[0-9a-f]{8}\.md$/);
    expect(pageMirrorPath({ name: longName, journalDay: null })).toBe(`pages/${longFile}`);
    const text = readFileSync(join(dataDir, "pages", longFile), "utf8");
    expect(parseOutline(text).properties.title).toBe(longName);

    // Stable across sweeps: nothing is rewritten, nothing accumulates.
    expect(exportAll(ctx.driver, dataDir).exported).toBe(0);
    expect(pagesDir()).toEqual(files);
  });

  it("a short name is untouched, and two long names sharing a prefix get different files", () => {
    expect(pageMirrorPath({ name: "Alpha", journalDay: null })).toBe("pages/Alpha.md");
    const a = pageMirrorPath({ name: `${longName}A`, journalDay: null });
    const b = pageMirrorPath({ name: `${longName}B`, journalDay: null });
    expect(a).not.toBe(b);
    // Never cut inside a %XX escape: 100 `#`s encode to 300 bytes of `%23`.
    const hashes = pageMirrorPath({ name: "#".repeat(100), journalDay: null });
    expect(hashes).toMatch(/^pages\/(%23)+~[0-9a-f]{8}\.md$/);
  });

  it("the web export's file name and text are the mirror's, long names included (B-368)", () => {
    // What `apps/web/src/data/page-export.ts` computes for "Export page as markdown", from the
    // same core functions over the same rows.
    const webExport = (pageId: string) => {
      const rendered = readPageOutline(ctx.driver, pageId);
      if (!rendered) throw new Error("no page");
      const path = pageMirrorPath(rendered);
      return { path, text: serializeOutline(pageMirrorOutline(rendered), { ids: "present" }) };
    };
    const long = createPage(longName, { properties: { type: "notes" } });
    createBlock(long, "long");
    const short = createPage("Krátká stránka", { properties: { type: "notes" } });
    createBlock(short, "short");
    const day = createPage("2026-09-13", { journalDay: 20260913 });
    createBlock(day, "day");
    expect(exportAll(ctx.driver, dataDir).failed).toEqual([]);

    for (const id of [long, short, day]) {
      const row = ctx.driver.get<{ path: string }>(
        "SELECT path FROM mirror_file WHERE page_id = ?",
        [id],
      );
      const web = webExport(id);
      expect(web.path).toBe(row?.path);
      expect(web.text).toBe(readFileSync(join(dataDir, web.path), "utf8"));
    }
    expect(webExport(long).text.startsWith(`title:: ${longName}\ntype:: notes\n`)).toBe(true);
  });

  it("one page that fails to write does not stop the others or the prune, and leaves no temp file", () => {
    const gone = createPage("Gone");
    createBlock(gone, "g");
    exportAll(ctx.driver, dataDir);
    deletePage(gone);

    const blocked = createPage("Blocked");
    createBlock(blocked, "b");
    // A non-empty directory where the file should go: the rename fails whatever the name.
    mkdirSync(join(dataDir, "pages", "Blocked.md", "inside"), { recursive: true });
    const fine = createPage("Fine");
    createBlock(fine, "f");

    const result = exportAll(ctx.driver, dataDir);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.pageId).toBe(blocked);
    expect(result.deleted).toBe(1);
    const files = pagesDir();
    expect(files).toContain("Fine.md");
    expect(files).not.toContain("Gone.md");
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
