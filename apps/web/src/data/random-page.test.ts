/**
 * `nav.randomPage`'s candidate query against the real client schema (`WorkerDb` over Node's
 * SQLite, as `db/worker-core.test.ts` does): journal days, empty pages, deleted pages and pages
 * whose only blocks were deleted are never candidates.
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { describe, expect, it } from "vitest";
import { WorkerDb } from "../db/worker-core.js";
import type { SyncTransport } from "../sync/types.js";
import { RANDOM_PAGE_CANDIDATES_SQL } from "./random-page.js";

const noopTransport: SyncTransport = {
  push: async () => ({ accepted: [], rejected: [], corrections: [], server_seq: 0 }),
  pull: async () => ({ ops: [], cursor: 0, has_more: false }),
  snapshot: async () => ({ cursor: 0, pages: [], blocks: [], block_props: [], page_props: [] }),
  connectLive: () => () => {},
};

describe("RANDOM_PAGE_CANDIDATES_SQL", () => {
  it("lists live non-journal pages that have at least one live block", () => {
    const db = new WorkerDb({
      driver: createNodeSqliteDriver(new DatabaseSync(":memory:")),
      transport: noopTransport,
    });
    const op = (entity: string, payload: Parameters<typeof makeOp>[3]): Op =>
      makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload);
    const page = (name: string, journalDay: number | null = null): string => {
      const id = newId();
      db.applyLocalOps([op(id, { kind: "page.create", name, journalDay, createdAt: 1 })]);
      return id;
    };
    const block = (pageId: string, content: string): string => {
      const id = newId();
      db.applyLocalOps([
        op(id, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content,
          createdAt: 1,
        }),
      ]);
      return id;
    };

    const withContent = page("Zahrada");
    block(withContent, "something to rediscover");
    page("Linked but empty");
    block(page("2026-09-12", 20260912), "a journal day");
    const deletedPage = page("Deleted page");
    block(deletedPage, "gone");
    db.applyLocalOps([op(deletedPage, { kind: "page.delete", deletedAt: 2 })]);
    const emptied = page("Emptied");
    db.applyLocalOps([op(block(emptied, "deleted block"), { kind: "block.delete", deletedAt: 2 })]);

    expect(db.query<{ id: string; name: string }>(RANDOM_PAGE_CANDIDATES_SQL)).toEqual([
      { id: withContent, name: "Zahrada" },
    ]);
  });
});
