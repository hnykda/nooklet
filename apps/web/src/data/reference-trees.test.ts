/**
 * `loadReferenceTrees` against a real `WorkerDb` over the Node SQLite driver — the SQL the browser
 * worker runs, minus Comlink. The panel that renders the result is `e2e/tests/references-render.spec.ts`.
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ queryAs: vi.fn() }));
vi.mock("./store.js", () => ({
  stampedFor: <T>(value: T) => ({ value, version: 0 }),
}));

import { WorkerDb } from "../db/worker-core.js";
import type { SyncTransport } from "../sync/types.js";
import { loadReferenceTrees, type ReferenceTrees, type SqlRunner } from "./reference-trees.js";

const noTransport: SyncTransport = {
  push: async () => ({ accepted: [], rejected: [], corrections: [], server_seq: 0 }),
  pull: async () => ({ ops: [], cursor: 0, has_more: false }),
  snapshot: async () => ({ cursor: 0, pages: [], blocks: [], block_props: [], page_props: [] }),
  connectLive: () => () => {},
};

function ok(t: ReferenceTrees): Extract<ReferenceTrees, { status: "ok" }> {
  if (t.status !== "ok") throw new Error(`read failed: ${t.message}`);
  return t;
}

describe("loadReferenceTrees", () => {
  let db: WorkerDb;
  let sql: SqlRunner;
  let pageId: string;

  const op = (entity: string, payload: Op["payload"]): Op =>
    makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload);

  function block(parentId: string | null, order: string, content: string): string {
    const id = newId();
    db.applyLocalOps([
      op(id, { kind: "block.create", place: { pageId, parentId, order }, content, createdAt: 1 }),
    ]);
    return id;
  }

  const prop = (id: string, key: string, value: string | null): void => {
    db.applyLocalOps([op(id, { kind: "block.prop", key, value })]);
  };

  beforeEach(() => {
    db = new WorkerDb({
      driver: createNodeSqliteDriver(new DatabaseSync(":memory:")),
      transport: noTransport,
    });
    sql = async <T>(q: string, params: unknown[] = []) => db.query<T>(q, params);
    pageId = newId();
    db.applyLocalOps([
      op(pageId, { kind: "page.create", name: "Journal Day", journalDay: null, createdAt: 1 }),
    ]);
  });

  it("reads each outermost reference with its subtree in page order, and every ancestor chain", async () => {
    const context = block(null, "a", "Project notes");
    const ref = block(context, "a", "call about [[Target]]");
    const second = block(ref, "b", "second child");
    const first = block(ref, "a", "first child");
    const grand = block(first, "a", "grandchild");
    block(null, "b", "unrelated");

    // As `path_ref` lists them: the linking block and every descendant.
    const t = ok(await loadReferenceTrees([ref, first, second, grand], sql));

    const node = t.nodes.get(ref);
    expect(node?.content).toBe("call about [[Target]]");
    expect(node?.children.map((c) => c.content)).toEqual(["first child", "second child"]);
    expect(node?.children[0]?.children.map((c) => c.content)).toEqual(["grandchild"]);
    // The nested references are reachable by id too — a filter can make any of them a row.
    expect(t.nodes.get(grand)?.content).toBe("grandchild");
    // Nearest ancestor first.
    expect(t.ancestors.get(ref)).toEqual([context]);
    expect(t.ancestors.get(grand)).toEqual([first, ref, context]);
    // Breadcrumb text for the ancestor that is not itself read as a node.
    expect(t.ancestorText.get(context)).toBe("Project notes");
    expect(t.nodes.has(context)).toBe(false);
  });

  it("carries properties, marker, dates and collapsed; leaves deleted children out", async () => {
    const ref = block(null, "a", "TODO task for [[Target]]");
    const kept = block(ref, "a", "kept");
    const gone = block(ref, "b", "deleted");
    prop(ref, "marker", "TODO");
    prop(ref, "collapsed", "true");
    prop(ref, "scheduled", "2026-09-20");
    prop(kept, "author", "Dan");
    prop(kept, "removed", "x");
    prop(kept, "removed", null);
    db.applyLocalOps([op(gone, { kind: "block.delete", deletedAt: 5 })]);

    const t = ok(await loadReferenceTrees([ref, kept], sql));
    const node = t.nodes.get(ref);
    expect(node?.marker).toBe("TODO");
    expect(node?.collapsed).toBe(true);
    expect(node?.scheduledDay).toBe(20260920);
    expect(node?.children.map((c) => c.content)).toEqual(["kept"]);
    expect(node?.children[0]?.properties).toEqual({ author: "Dan" });
    expect(t.ancestors.get(ref)).toEqual([]);
  });

  it("an id the replica does not have is asked about but has no node and no chain", async () => {
    const ref = block(null, "a", "here");
    const t = ok(await loadReferenceTrees([ref, "1nothere00000"], sql));
    expect(t.requested.has("1nothere00000")).toBe(true);
    expect(t.ancestors.has("1nothere00000")).toBe(false);
    expect(t.nodes.has("1nothere00000")).toBe(false);
    expect(t.nodes.get(ref)?.content).toBe("here");
  });

  it("a failing read comes back as a value, not a rejection", async () => {
    const broken: SqlRunner = async () => {
      throw new Error("worker gone");
    };
    expect(await loadReferenceTrees(["x"], broken)).toEqual({
      status: "failed",
      message: "worker gone",
    });
  });
});
