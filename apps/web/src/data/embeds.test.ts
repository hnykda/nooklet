/**
 * `loadEmbed` against a real `WorkerDb` over the Node SQLite driver — the same tree builder and the
 * same SQL the browser worker runs, minus Comlink. The reactive wrapper (`useEmbed`) is covered
 * end-to-end by `e2e/tests/embeds.spec.ts`'s "an embed follows edits to its target".
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ queryAs: vi.fn(), getPageTree: vi.fn() }));
vi.mock("./store.js", () => ({
  stampedFor: <T>(value: T) => ({ value, version: 0 }),
}));

import { WorkerDb } from "../db/worker-core.js";
import type { SyncTransport } from "../sync/types.js";
import { type EmbedDeps, loadEmbed } from "./embeds.js";

const noTransport: SyncTransport = {
  push: async () => ({ accepted: [], rejected: [], corrections: [], server_seq: 0 }),
  pull: async () => ({ ops: [], cursor: 0, has_more: false }),
  snapshot: async () => ({ cursor: 0, pages: [], blocks: [], block_props: [], page_props: [] }),
  connectLive: () => () => {},
};

describe("loadEmbed", () => {
  let db: WorkerDb;
  let deps: EmbedDeps;

  const op = (entity: string, payload: Op["payload"]): Op =>
    makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload);

  function page(name: string, journalDay: number | null = null): string {
    const id = newId();
    db.applyLocalOps([op(id, { kind: "page.create", name, journalDay, createdAt: 1 })]);
    return id;
  }

  function block(pageId: string, parentId: string | null, order: string, content: string): string {
    const id = newId();
    db.applyLocalOps([
      op(id, { kind: "block.create", place: { pageId, parentId, order }, content, createdAt: 1 }),
    ]);
    return id;
  }

  beforeEach(() => {
    db = new WorkerDb({
      driver: createNodeSqliteDriver(new DatabaseSync(":memory:")),
      transport: noTransport,
    });
    deps = {
      sql: async <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params),
      pageTree: async (id) => db.getPageTree(id),
    };
  });

  it("a block embed returns that block with its children in page order, from any depth", async () => {
    const p = page("2024-09-26", 20240926);
    const top = block(p, null, "a", "todo");
    const list = block(p, top, "a", "shopping");
    block(p, list, "b", "second");
    block(p, list, "a", "first");
    block(p, null, "b", "unrelated sibling");

    const got = await loadEmbed({ kind: "block", id: list }, deps);
    expect(got.status).toBe("block");
    if (got.status !== "block") return;
    expect(got.page.name).toBe("2024-09-26");
    expect(got.node.content).toBe("shopping");
    expect(got.node.children.map((c) => c.content)).toEqual(["first", "second"]);
  });

  it("a page embed returns the page's top-level blocks, by name case-insensitively", async () => {
    const p = page("Reading List");
    const a = block(p, null, "a", "Books");
    block(p, a, "a", "Dune");
    block(p, null, "b", "Articles");

    const got = await loadEmbed({ kind: "page", name: "reading list" }, deps);
    expect(got.status).toBe("page");
    if (got.status !== "page") return;
    expect(got.page.name).toBe("Reading List");
    expect(got.blocks.map((b) => b.content)).toEqual(["Books", "Articles"]);
    expect(got.blocks[0]?.children[0]?.content).toBe("Dune");
  });

  it("a journal embedded by another title format resolves through its day", async () => {
    const p = page("2026-09-07", 20260907);
    block(p, null, "a", "did a thing");
    const got = await loadEmbed({ kind: "page", name: "Sep 7th, 2026" }, deps);
    expect(got.status).toBe("page");
  });

  it("an empty page embeds as a page with no blocks, not as missing", async () => {
    page("Empty Page");
    const got = await loadEmbed({ kind: "page", name: "Empty Page" }, deps);
    expect(got).toMatchObject({ status: "page", blocks: [] });
  });

  it("missing: no such page, no such block, a deleted block, a block on a deleted page", async () => {
    const p = page("Doomed");
    const gone = block(p, null, "a", "deleted block");
    const onDeletedPage = block(p, null, "b", "lives on a deleted page");
    const kept = page("Kept");
    const alive = block(kept, null, "a", "still here");

    db.applyLocalOps([op(gone, { kind: "block.delete", deletedAt: 5 })]);
    expect(await loadEmbed({ kind: "block", id: gone }, deps)).toEqual({ status: "missing" });

    db.applyLocalOps([op(p, { kind: "page.delete", deletedAt: 5 })]);
    expect(await loadEmbed({ kind: "block", id: onDeletedPage }, deps)).toEqual({
      status: "missing",
    });
    expect(await loadEmbed({ kind: "page", name: "Doomed" }, deps)).toEqual({ status: "missing" });
    expect(await loadEmbed({ kind: "page", name: "Never Was" }, deps)).toEqual({
      status: "missing",
    });
    expect(await loadEmbed({ kind: "block", id: "1nosuchblock00" }, deps)).toEqual({
      status: "missing",
    });
    expect((await loadEmbed({ kind: "block", id: alive }, deps)).status).toBe("block");
  });

  it("a failing read comes back as failed rather than a rejected promise", async () => {
    const broken: EmbedDeps = {
      sql: async () => {
        throw new Error("worker gone");
      },
      pageTree: async () => undefined,
    };
    expect(await loadEmbed({ kind: "block", id: "x" }, broken)).toEqual({
      status: "failed",
      message: "worker gone",
    });
  });
});
