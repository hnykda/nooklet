import { makeOp } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { serverApplyOps } from "../apply-ops.js";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

function counts(): { ops: number; changes: number } {
  const d = s.serverCtx.driver;
  return {
    ops: d.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n ?? 0,
    changes: d.get<{ n: number }>("SELECT count(*) AS n FROM changes")?.n ?? 0,
  };
}

function rowsOf(pageId: string): { page: unknown; blocks: unknown[] } {
  const d = s.serverCtx.driver;
  return {
    page: d.get("SELECT deleted_at FROM page WHERE id = ?", [pageId]),
    blocks: d.all("SELECT content, deleted_at FROM block WHERE page_id = ? ORDER BY order_key", [
      pageId,
    ]),
  };
}

/** One delete action = one tombstone instant; keep separate actions in separate milliseconds. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 2));
}

describe("an un-delete whose page name is taken writes nothing and says so (B-90 follow-up)", () => {
  it("batch.undo of a page delete, after a new page took the name, is conflict", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dup",
      markdown: "- one\n- two",
    });
    const oldId = s.serverCtx.driver.get<{ id: string }>("SELECT id FROM page WHERE key = 'dup'")
      ?.id as string;
    const del = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Dup" });
    expect(del.status).toBe(200);
    await tick();
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dup",
      markdown: "- new",
    });
    const before = { counts: counts(), rows: rowsOf(oldId) };

    const u = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: del.json.batch_id,
    });
    expect(u.status).toBe(409);
    expect(u.json.error.code).toBe("conflict");
    const live = s.serverCtx.driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = 'dup' AND deleted_at IS NULL",
    );
    expect(u.json.error.details?.live_page_id).toBe(live?.id);
    expect({ counts: counts(), rows: rowsOf(oldId) }).toEqual(before);
    const trash = await post(s.app, "/api/v1/trash.list", s.writeToken, {});
    expect(trash.json.items.map((i: JsonAny) => [i.kind, i.title])).toEqual([["page", "Dup"]]);
  });

  it("trash.restore refuses new_name for a journal day, whose name is its date", async () => {
    await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "2026-09-07",
      markdown: "- old day",
    });
    const oldId = s.serverCtx.driver.get<{ id: string }>(
      "SELECT id FROM page WHERE journal_day = 20260907",
    )?.id as string;
    // page.delete refuses journal days; a device deletes one with raw ops, one instant for all.
    const blocks = s.serverCtx.driver.all<{ id: string }>(
      "SELECT id FROM block WHERE page_id = ?",
      [oldId],
    );
    const now = Date.now();
    serverApplyOps(
      s.serverCtx,
      [
        makeOp(s.serverCtx.hlc.next(), "aaaaaaaa", oldId, { kind: "page.delete", deletedAt: now }),
        ...blocks.map((b) =>
          makeOp(s.serverCtx.hlc.next(), "aaaaaaaa", b.id, {
            kind: "block.delete",
            deletedAt: now,
          }),
        ),
      ],
      { origin: "sync", actor: "device", deviceId: "aaaaaaaa" },
    );
    await tick();
    await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "2026-09-07",
      markdown: "- new day",
    });
    const before = { counts: counts(), rows: rowsOf(oldId) };

    const plain = await post(s.app, "/api/v1/trash.restore", s.writeToken, { id: oldId });
    expect(plain.status).toBe(409);
    const renamed = await post(s.app, "/api/v1/trash.restore", s.writeToken, {
      id: oldId,
      new_name: "Old day",
    });
    expect(renamed.status).toBe(400);
    expect(renamed.json.error.message).toMatch(/journal/);
    expect({ counts: counts(), rows: rowsOf(oldId) }).toEqual(before);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });
});
