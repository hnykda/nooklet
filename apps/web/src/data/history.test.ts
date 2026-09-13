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

import { useTrash } from "./history.js";
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
