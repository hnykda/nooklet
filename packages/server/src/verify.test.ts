import { newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { formatVerifyReport, verifyRebuildParity } from "./verify.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

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

function createBlock(pageId: string, content: string, parentId: string | null = null): string {
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
          place: { pageId, parentId, order: "a0" },
          content,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

describe("verifyRebuildParity", () => {
  it("reports ok on an empty database", () => {
    const report = verifyRebuildParity(ctx.driver);
    expect(report.ok).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.opCount).toBe(0);
    expect(report.minSeq).toBeNull();
  });

  it("reports ok on a real graph built entirely through the op log", () => {
    const home = createPage("Home");
    const parent = createBlock(home, "Parent [[Projects]]");
    createBlock(home, "Child", parent);
    createPage("Projects");

    const report = verifyRebuildParity(ctx.driver);
    expect(report.ok).toBe(true);
    expect(report.logTrimmed).toBe(false);
    expect(report.opCount).toBeGreaterThan(0);
  });

  it("names the exact table, key, and column when live state drifts from the op log (a bare SQL write that bypasses applyOps)", () => {
    const home = createPage("Home");
    const blockId = createBlock(home, "original content");

    // Simulate exactly the kind of regression this check exists to catch: something wrote to a
    // state table without going through applyOps/the op log.
    ctx.driver.run("UPDATE block SET content = ? WHERE id = ?", ["drifted content", blockId]);

    const report = verifyRebuildParity(ctx.driver);
    expect(report.ok).toBe(false);
    const mismatch = report.divergences.find((d) => d.table === "block" && d.column === "content");
    expect(mismatch).toBeDefined();
    expect(mismatch?.key).toEqual({ id: blockId });
    expect(mismatch?.live).toBe("drifted content");
    expect(mismatch?.rebuilt).toBe("original content");

    const text = formatVerifyReport(report);
    expect(text).toContain("DIVERGENCE");
    expect(text).toContain(blockId);
    expect(text).toContain("content");
  });

  it("flags a row present live but entirely absent from the op log", () => {
    const home = createPage("Home");
    createBlock(home, "in the log");
    // A row inserted directly, with no corresponding op at all.
    const ghostId = newId();
    ctx.driver.run(
      `INSERT INTO block(id, page_id, parent_id, order_key, content, created_at, updated_at, place_hlc, content_hlc)
       VALUES (?, ?, NULL, 'zz', 'ghost', 0, 0, '0', '0')`,
      [ghostId, home],
    );

    const report = verifyRebuildParity(ctx.driver);
    expect(report.ok).toBe(false);
    const missing = report.divergences.find(
      (d) => d.table === "block" && d.kind === "missing-in-rebuild",
    );
    expect(missing?.key).toEqual({ id: ghostId });
  });

  it("flags a trimmed op log (simulating a prior GC) and says so in the formatted report", () => {
    createPage("Home");
    createPage("Projects");
    createPage("Third");
    // Simulate `nooklet gc` having already deleted the oldest op(s).
    ctx.driver.run("DELETE FROM op WHERE seq = (SELECT MIN(seq) FROM op)");

    const report = verifyRebuildParity(ctx.driver);
    expect(report.logTrimmed).toBe(true);
    expect(report.ok).toBe(false); // the page created by the deleted op is now missing from rebuild
    expect(formatVerifyReport(report)).toContain("op-log GC has run");
  });
});
