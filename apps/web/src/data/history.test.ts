/**
 * `data/history.ts` (Trash and page History) at the reactive level, over the REAL `db/client.ts`
 * and `data/store.ts` — only the worker (a single-listener fake, `../db/fake-worker.ts`) and the
 * HTTP call are replaced. The listener test is the shape of B-130: opening Trash used to take over
 * the worker's only change listener, and every `store.ts` view stopped refreshing.
 */
import { createRoot, getOwner, runWithOwner } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeWorker } from "../db/fake-worker.js";

const fake = vi.hoisted(() => ({
  worker: undefined as FakeWorker | undefined,
  callOp: undefined as ((name: string, body: unknown) => Promise<unknown>) | undefined,
}));

vi.mock("comlink", async () => {
  const { createFakeWorker } = await import("../db/fake-worker.js");
  fake.worker = createFakeWorker();
  return {
    wrap: () => fake.worker?.remote,
    proxy: <T>(v: T) => v,
    expose: () => {},
  };
});
vi.mock("../platform/index.js", () => ({ platform: { lifecycle: { on: () => {} } } }));
vi.stubGlobal(
  "Worker",
  class {
    postMessage(): void {}
  },
);
vi.mock("./api-client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callOp: (name: string, body: unknown) =>
    fake.callOp ? fake.callOp(name, body) : Promise.resolve({ items: [], has_more: false }),
}));

import { usePageHistory, useTrash } from "./history.js";
import { usePageIcons, useSyncStatus } from "./store.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  fake.callOp = undefined;
});

describe("Trash and History share the change bus with store.ts (B-130)", () => {
  it("a store.ts resource still refetches on a change after Trash has subscribed", async () => {
    await createRoot(async (dispose) => {
      disposers.push(dispose);
      const owner = getOwner();
      const icons = usePageIcons();
      await tick();
      const worker = fake.worker as FakeWorker;

      const before = worker.queryCalls;
      worker.emitChange({ tables: ["page_prop"], pageIds: [] });
      await tick();
      expect(worker.queryCalls - before).toBe(1);

      // What TrashView does on mount. Under the root's owner, so the resource is disposed with it
      // (an `await` above has already left the synchronous owner scope).
      runWithOwner(owner, () => useTrash());
      await tick();

      const after = worker.queryCalls;
      worker.emitChange({ tables: ["page_prop"], pageIds: [] });
      await tick();
      expect(worker.queryCalls - after).toBe(1);
      void icons;
    });
  });

  it("Trash itself refetches on a page/block change", async () => {
    let trashCalls = 0;
    fake.callOp = async (name) => {
      if (name === "trash.list") trashCalls++;
      return { items: [], has_more: false };
    };
    await createRoot(async (dispose) => {
      disposers.push(dispose);
      const [items] = useTrash();
      await tick();
      const before = trashCalls;
      fake.worker?.emitChange({ tables: ["block"], pageIds: [] });
      await tick();
      expect(trashCalls - before).toBe(1);
      void items;
    });
  });

  it("two useSyncStatus() callers (the shell and the diagnostics panel) both see a status", async () => {
    await createRoot(async (dispose) => {
      disposers.push(dispose);
      const shell = useSyncStatus();
      const diagnostics = useSyncStatus();
      await tick();
      fake.worker?.emitStatus({ state: "error", pendingCount: 3, serverCursor: 7 });
      expect(shell()?.pendingCount).toBe(3);
      expect(diagnostics()?.pendingCount).toBe(3);
    });
  });
});

/**
 * `page.history` as the server answers it: batches seq 1..top, newest first, `PAGE` per request,
 * the cursor meaning "older than seq X" (`packages/server/src/ops/page-history.ts`). Every request
 * is held until the test resolves it, so the order responses land in is the test's to choose.
 */
function historyServer(initialTop: number) {
  const PAGE = 5;
  const state = { top: initialTop };
  const pending: Array<{ cursor?: string; resolve: () => void }> = [];
  const callOp = (name: string, body: unknown): Promise<unknown> => {
    if (name !== "page.history") return Promise.resolve({ items: [], has_more: false });
    const { cursor } = body as { cursor?: string };
    const top = state.top; // what the server's log holds when the request arrives
    return new Promise((resolve) => {
      pending.push({
        cursor,
        resolve: () => {
          const below = cursor === undefined ? top + 1 : Number(cursor);
          const seqs: number[] = [];
          for (let s = below - 1; s >= 1 && seqs.length < PAGE; s--) seqs.push(s);
          const last = seqs[seqs.length - 1] ?? 1;
          resolve({
            page: "P",
            page_id: "p",
            has_more: last > 1,
            cursor: last > 1 ? String(last) : undefined,
            batches: seqs.map((seq) => ({
              batch_id: `b${seq}`,
              seq,
              at: "2026-09-13T08:00:00.000Z",
              origin: "api",
              actor: "agent",
              summary: "",
              entries: [],
            })),
          });
        },
      });
    });
  };
  return { state, pending, callOp };
}

/** Seqs missing between the newest and the oldest batch listed. */
function gaps(seqs: number[]): number[] {
  const missing: number[] = [];
  const first = seqs[0];
  const last = seqs[seqs.length - 1];
  if (first === undefined || last === undefined) return missing;
  for (let s = first; s >= last; s--) if (!seqs.includes(s)) missing.push(s);
  return missing;
}

describe("History 'Older changes' racing a first-page refresh (B-132)", () => {
  it("a refresh that lands while an older page is in flight leaves no hole in the timeline", async () => {
    const server = historyServer(30);
    fake.callOp = server.callOp;
    await createRoot(async (dispose) => {
      disposers.push(dispose);
      const history = usePageHistory(() => "P");
      await tick();
      server.pending.shift()?.resolve();
      await tick();
      expect(history.batches().map((b) => b.seq)).toEqual([30, 29, 28, 27, 26]);

      // "Older changes" clicked; its request is in flight.
      const more = history.loadMore();
      await tick();
      const older = server.pending.shift();
      expect(older?.cursor).toBe("26");

      // Meanwhile two batches land (an agent writes) and the first page refetches…
      server.state.top = 32;
      fake.worker?.emitChange({ tables: ["block"], pageIds: [] });
      await tick();
      const refresh = server.pending.shift();
      expect(refresh?.cursor).toBeUndefined();

      // …and the refresh answers before the older page does.
      refresh?.resolve();
      await tick();
      older?.resolve();
      await more;
      await tick();

      const seqs = history.batches().map((b) => b.seq);
      expect(seqs[0]).toBe(32);
      expect(gaps(seqs)).toEqual([]);

      // And paging on from there continues without a hole either.
      const next = history.loadMore();
      await tick();
      server.pending.shift()?.resolve();
      await next;
      await tick();
      const after = history.batches().map((b) => b.seq);
      expect(after.length).toBeGreaterThan(seqs.length);
      expect(gaps(after)).toEqual([]);
    });
  });
});
