/**
 * ADR 024 for graphs that predate it (`migrateReferencedPages`) and for imports
 * (`importLogseqGraph` minting what no file defined). Both must leave `verify` exact.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type Op } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { openDb } from "./db.js";
import { importLogseqGraph } from "./importer/logseq.js";
import { REFERENCE_DEVICE_ID } from "./ref-pages.js";
import { migrateReferencedPages } from "./ref-pages-migration.js";
import { verifyRebuildParity } from "./verify.js";

let ctx: ServerContext;
let graphDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  graphDir = mkdtempSync(join(tmpdir(), "nooklet-refpages-graph-"));
});

afterEach(() => {
  rmSync(graphDir, { recursive: true, force: true });
});

function op(entity: string, payload: Op["payload"]): Op {
  const hlc = ctx.hlc.next();
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

/** A write the way it happened before ADR 024: nothing minted. */
function legacy(ops: Op[]): void {
  serverApplyOps(ctx, ops, { origin: "user", actor: "test", referencedPages: "skip" });
}

function legacyPage(name: string, journalDay: number | null = null): string {
  const id = newId();
  legacy([op(id, { kind: "page.create", name, journalDay, createdAt: Date.now() })]);
  return id;
}

function legacyBlock(pageId: string, content: string, createdAt: number, marker?: "TODO"): void {
  legacy([
    op(newId(), {
      kind: "block.create",
      place: { pageId, parentId: null, order: "a0" },
      content,
      marker,
      createdAt,
    }),
  ]);
}

function livePages(): string[] {
  return ctx.driver
    .all<{ name: string }>("SELECT name FROM page WHERE deleted_at IS NULL ORDER BY key")
    .map((r) => r.name);
}

function writeGraphFile(relPath: string, content: string): void {
  const full = join(graphDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("migrateReferencedPages", () => {
  it("creates every dangling page once, named by its earliest reference, and verify stays exact", () => {
    const home = legacyPage("Home");
    legacyPage("coaching/sessions");
    const day = legacyPage("2026-09-07", 20260907);
    legacyBlock(home, "later spelling [[quick capture]]", 2_000);
    legacyBlock(home, "first spelling [[Quick Capture]] and #idea", 1_000);
    legacyBlock(day, "call [[@eva svobodová]] about [[Sprouts/Growing/Sixth Try]]", 3_000);
    legacyBlock(day, "a task on [[2026-09-08]]", 4_000, "TODO");
    const unresolvedBefore = ctx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ref WHERE dst_page_id IS NULL AND dst_page_key IS NOT NULL",
    )?.n;
    expect(unresolvedBefore).toBe(7);

    const result = migrateReferencedPages(ctx);

    expect(result.alreadyDone).toBe(false);
    expect(livePages()).toEqual([
      "2026-09-07",
      "@eva svobodová",
      "coaching",
      "coaching/sessions",
      "Home",
      "idea",
      "Quick Capture",
      "Sprouts",
      "Sprouts/Growing",
      "Sprouts/Growing/Sixth Try",
      "Task",
    ]);
    expect(result.created).toBe(8);
    // Only the journal-day reference is left pointing at nothing — by design.
    expect(
      ctx.driver
        .all<{ k: string }>(
          "SELECT DISTINCT dst_page_key AS k FROM ref WHERE dst_page_id IS NULL AND dst_page_key IS NOT NULL",
        )
        .map((r) => r.k),
    ).toEqual(["2026-09-08"]);
    const minted = ctx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM op WHERE device_id = ? AND kind = 'page.create'",
      [REFERENCE_DEVICE_ID],
    )?.n;
    expect(minted).toBe(8);
    expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);

    // Once only.
    const again = migrateReferencedPages(ctx);
    expect(again).toMatchObject({ alreadyDone: true, created: 0 });
  });

  it("dates each page by its earliest reference, so they do not top 'Recently edited' (B-446)", () => {
    const home = newId();
    const coaching = newId();
    legacy([
      op(home, { kind: "page.create", name: "Home", journalDay: null, createdAt: 10_000 }),
      op(coaching, {
        kind: "page.create",
        name: "coaching/sessions",
        journalDay: null,
        createdAt: 9_000,
      }),
    ]);
    legacyBlock(home, "later [[quick capture]]", 2_000);
    legacyBlock(home, "earlier [[Quick Capture]] #idea", 1_000);
    legacyBlock(home, "[[Sprouts/Growing/Sixth Try]]", 3_000);
    legacyBlock(home, "a task", 5_000, "TODO");
    migrateReferencedPages(ctx);

    const dated = Object.fromEntries(
      ctx.driver
        .all<{ name: string; created_at: number; updated_at: number }>(
          "SELECT name, created_at, updated_at FROM page p WHERE EXISTS (SELECT 1 FROM op o WHERE o.entity = p.id AND o.device_id = ? AND o.kind = 'page.create')",
          [REFERENCE_DEVICE_ID],
        )
        .map((r) => [r.name, [r.created_at, r.updated_at]]),
    );
    expect(dated).toEqual({
      "Quick Capture": [1_000, 1_000],
      idea: [1_000, 1_000],
      Sprouts: [3_000, 3_000],
      "Sprouts/Growing": [3_000, 3_000],
      "Sprouts/Growing/Sixth Try": [3_000, 3_000],
      Task: [5_000, 5_000],
      coaching: [9_000, 9_000],
    });
    // All pages' default sort ("Recently edited", `updated_at` descending): Home, written last,
    // comes first — not the pages the sweep made.
    const recent = ctx.driver.get<{ name: string }>(
      "SELECT name FROM page WHERE deleted_at IS NULL AND journal_day IS NULL ORDER BY updated_at DESC LIMIT 1",
    );
    expect(recent?.name).toBe("Home");
    expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);
  });
});

describe("importLogseqGraph and referenced pages", () => {
  it("imports pages whose names other files reference first, then creates the ones no file defines", async () => {
    // `Alpha` sorts first and links to `Beta` before Beta's own file is read.
    writeGraphFile("pages/Alpha.md", "- see [[Beta]] and [[Gamma]] and [[Topics/Fungi]]\n");
    writeGraphFile("pages/Beta.md", "- beta's own content\n");
    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);
    expect(stats.pagesImported).toBe(2);
    expect(stats.referencedPagesCreated).toBe(3);
    expect(livePages()).toEqual(["Alpha", "Beta", "Gamma", "Topics", "Topics/Fungi"]);
    expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);
  });

  it("imports a file into a graph where a link already made an empty page of that name", async () => {
    const home = newId();
    serverApplyOps(
      ctx,
      [
        op(home, { kind: "page.create", name: "Home", journalDay: null, createdAt: Date.now() }),
        op(newId(), {
          kind: "block.create",
          place: { pageId: home, parentId: null, order: "a0" },
          content: "[[Beta]]",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "test" },
    );
    expect(livePages()).toEqual(["Beta", "Home"]);
    writeGraphFile("pages/Beta.md", "- beta's own content\n");
    const stats = await importLogseqGraph(ctx, graphDir);
    expect(stats.errors).toEqual([]);
    expect(stats.pagesImported).toBe(1);
    const beta = ctx.driver.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM block b JOIN page p ON p.id = b.page_id WHERE p.key = 'beta' AND p.deleted_at IS NULL",
    );
    expect(beta[0]?.n).toBe(1);
    expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);
  });
});
