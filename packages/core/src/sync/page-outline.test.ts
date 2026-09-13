import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "../hlc.js";
import type { OpPayload } from "../ops.js";
import { makeOp } from "../ops.js";
import { parseOutline, serializeOutline } from "../outline.js";
import { applyOps } from "./apply-ops.js";
import type { SqlDriver } from "./driver.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";
import {
  buildPageOutline,
  PAGE_OUTLINE_SQL,
  pageMirrorPath,
  readPageOutline,
} from "./page-outline.js";
import { initSchema } from "./schema.js";

const DEV = "aaaaaaaa";
const BASE = Date.UTC(2026, 8, 13, 9, 0, 0);

let driver: SqlDriver;
let tick = 0;

function apply(entity: string, payload: OpPayload): void {
  tick++;
  applyOps(driver, [
    makeOp(formatHlc({ wall: BASE + tick, counter: 0, device: DEV }), DEV, entity, payload),
  ]);
}

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  driver = createNodeSqliteDriver(db);
  initSchema(driver);
  tick = 0;
});

const PAGE = "pg00000000000a";

function block(
  id: string,
  content: string,
  opts: { parentId?: string | null; order?: string; props?: Record<string, string> } = {},
): void {
  apply(id, {
    kind: "block.create",
    place: { pageId: PAGE, parentId: opts.parentId ?? null, order: opts.order ?? "a0" },
    content,
    properties: opts.props,
    createdAt: BASE,
  });
}

describe("readPageOutline", () => {
  it("renders the mirror's text: page props, nesting, markers, reserved columns as property lines", () => {
    apply(PAGE, {
      kind: "page.create",
      name: "Projects/Aurora",
      journalDay: null,
      properties: { type: "project" },
      createdAt: BASE,
    });
    block("b0000000000001", "Plan", { props: { status: "active" } });
    apply("b0000000000002", {
      kind: "block.create",
      place: { pageId: PAGE, parentId: "b0000000000001", order: "a0" },
      content: "Ship it",
      marker: "TODO",
      priority: "A",
      collapsed: true,
      properties: { scheduled: "2026-09-14 10:30", deadline: "2026-09-20", repeat: ".+1w" },
      createdAt: BASE,
    });
    block("b0000000000003", "hidden child", { parentId: "b0000000000002" });
    block("b0000000000004", "Second\nline two", { order: "a1" });

    const rendered = readPageOutline(driver, PAGE);
    expect(rendered).toBeDefined();
    if (!rendered) return;
    expect(rendered.name).toBe("Projects/Aurora");
    expect(serializeOutline(rendered.parsed)).toBe(
      [
        "type:: project",
        "- Plan ^b0000000000001",
        "  status:: active",
        "  - TODO [#A] Ship it ^b0000000000002",
        "    collapsed:: true",
        "    scheduled:: 2026-09-14 10:30",
        "    deadline:: 2026-09-20",
        "    repeat:: .+1w",
        "    - hidden child ^b0000000000003",
        "- Second ^b0000000000004",
        "  line two",
        "",
      ].join("\n"),
    );
    // And the text is the lossless mirror: it parses back to the same tree.
    expect(parseOutline(serializeOutline(rendered.parsed))).toEqual(rendered.parsed);
  });

  it("drops a soft-deleted block together with its whole subtree", () => {
    apply(PAGE, { kind: "page.create", name: "Del", journalDay: null, createdAt: BASE });
    block("b0000000000001", "keep");
    block("b0000000000002", "gone", { order: "a1" });
    block("b0000000000003", "child of gone", { parentId: "b0000000000002" });
    apply("b0000000000002", { kind: "block.delete", deletedAt: BASE });

    const rendered = readPageOutline(driver, PAGE);
    expect(rendered && serializeOutline(rendered.parsed, { ids: "none" })).toBe("- keep\n");
  });

  it("is undefined for a missing or soft-deleted page", () => {
    expect(readPageOutline(driver, PAGE)).toBeUndefined();
    apply(PAGE, { kind: "page.create", name: "Soon gone", journalDay: null, createdAt: BASE });
    expect(readPageOutline(driver, PAGE)).toBeDefined();
    apply(PAGE, { kind: "page.delete", deletedAt: BASE });
    expect(readPageOutline(driver, PAGE)).toBeUndefined();
  });

  // B-223: two devices inserting at the same spot mint the same order key. The editor breaks the
  // tie by id; the mirror used to take SQLite's rowid (insertion) order, which is different on the
  // server and on each replica.
  it("orders siblings with the same order key by id, whatever order they were inserted in", () => {
    apply(PAGE, { kind: "page.create", name: "Tie", journalDay: null, createdAt: BASE });
    block("zzzzzzzzzzzzzz", "inserted first, larger id");
    block("aaaaaaaaaaaaaa", "inserted second, smaller id");

    const rendered = readPageOutline(driver, PAGE);
    expect(rendered?.parsed.blocks.map((b) => b.id)).toEqual(["aaaaaaaaaaaaaa", "zzzzzzzzzzzzzz"]);
  });

  it("builds from rows fetched by any means — the path the web client takes", () => {
    apply(PAGE, { kind: "page.create", name: "Rows", journalDay: null, createdAt: BASE });
    block("b0000000000001", "one");
    const viaRows = buildPageOutline(PAGE, {
      page: driver.get(PAGE_OUTLINE_SQL.page, [PAGE]),
      pageProps: driver.all(PAGE_OUTLINE_SQL.pageProps, [PAGE]),
      blocks: driver.all(PAGE_OUTLINE_SQL.blocks, [PAGE]),
      blockProps: driver.all(PAGE_OUTLINE_SQL.blockProps, [PAGE]),
    });
    expect(viaRows).toEqual(readPageOutline(driver, PAGE));
  });
});

describe("pageMirrorPath", () => {
  it("puts journals under journals/ by date and pages under pages/ with the file-name encoding", () => {
    expect(pageMirrorPath({ name: "2026-09-13", journalDay: 20260913 })).toBe(
      "journals/2026_09_13.md",
    );
    expect(pageMirrorPath({ name: "Projects/Aurora", journalDay: null })).toBe(
      "pages/Projects___Aurora.md",
    );
  });
});
