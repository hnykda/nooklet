import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalDayToFileName,
  newId,
  type Priority,
  type Properties,
  pageNameToFileName,
  parseOutline,
  type TaskMarker,
} from "@vrite/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { exportAll, exportPage, isOwnWrite, pageFilePath, renderPageToOutline } from "./export.js";

let ctx: ServerContext;
let dataDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  dataDir = mkdtempSync(join(tmpdir(), "vrite-mirror-test-"));
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

  it("exports a journal page to journals/<file>.md", () => {
    const day = 20260910;
    const pageId = createPage("2026-09-10", { journalDay: day });
    createBlock(pageId, "Journal entry");

    const expectedPath = `journals/${journalDayToFileName(day)}.md`;
    expect(pageFilePath({ name: "2026-09-10", journalDay: day })).toBe(expectedPath);

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

    const p1Path = join(dataDir, pageFilePath({ name: "Page One", journalDay: null }));
    expect(existsSync(p1Path)).toBe(true);

    deletePage(p1);
    const second = exportAll(ctx.driver, dataDir);
    expect(second.deleted).toBe(1);
    expect(existsSync(p1Path)).toBe(false);

    const row = ctx.driver.get("SELECT * FROM mirror_file WHERE page_id = ?", [p1]);
    expect(row).toBeUndefined();
  });
});
