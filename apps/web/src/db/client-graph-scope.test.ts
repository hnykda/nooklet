/**
 * B-611, at `db/client.ts`'s wiring: a write a local-only page load handed to its worker and never
 * saw applied (an unscoped v1 batch, the only kind every build before the fix wrote) must not be
 * replayed into the server graph the next page load opens. Before the fix `initDb` replayed every
 * orphaned batch into whatever replica it had opened, and that graph's next push sent the
 * local-only note to the server (`tools/probes/sweep-devices/local-then-server.probe.ts`).
 */
import { makeOp, type Op } from "@nooklet/core";
import { describe, expect, it, vi } from "vitest";
import type { FakeWorker } from "./fake-worker.js";

const fake = vi.hoisted(() => ({ worker: undefined as FakeWorker | undefined }));

vi.mock("comlink", async () => {
  const { createFakeWorker } = await import("./fake-worker.js");
  fake.worker = createFakeWorker();
  return { wrap: () => fake.worker?.remote, proxy: <T>(v: T) => v, expose: () => {} };
});
vi.mock("../platform/index.js", () => ({
  platform: { name: "capacitor", lifecycle: { on: () => {} } },
}));
vi.mock("./capacitor-checkpoint.js", () => ({
  migrateUnscopedCheckpoint: async () => {},
  readCheckpoint: async () => undefined,
  createCheckpointScheduler: () => ({ onChange() {}, onPause() {}, stop() {} }),
}));
vi.stubGlobal(
  "Worker",
  class {
    postMessage(): void {}
  },
);

const store = new Map<string, string>();
const localNote: Op = makeOp("2026-10-03T09:00:00.000Z-0000-dev00001", "dev00001", "block1", {
  kind: "block.create",
  place: { pageId: "page1", parentId: null, order: "a0" },
  content: "LOCAL ONLY NOTE",
  createdAt: 1,
});
// Written by a "Just this device" page load (no list entry) that died before its worker answered.
store.set(
  "nooklet.unapplied-ops.v1:local-load:00000000",
  JSON.stringify({ at: 1, ops: [localNote] }),
);
// Then "Add a graph": a server entry, now active.
store.set(
  "nooklet.graphs",
  JSON.stringify([
    { id: "srv", label: "Remote graph", kind: "remote", baseUrl: "https://s.example/g/x" },
  ]),
);
store.set("nooklet.activeGraphId", "srv");
vi.stubGlobal("localStorage", {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { initDb } = await import("./client.js");

describe("orphaned writes stay in the graph they were written in (B-611)", () => {
  it("a server graph's page load does not replay a local-only page load's batch", async () => {
    const replay = vi.fn(async (_ops: Op[]) => ({ replayed: 1, skipped: 0 }));
    if (fake.worker) fake.worker.remote.replayLocalOps = replay;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initDb({ graphEntryId: "srv", syncBaseUrl: "https://s.example/g/x" });
    // The first replay pass has run by now; anything it was going to replay, it has.
    await vi.waitFor(() =>
      expect([...store.keys()]).toContain(
        "nooklet.unapplied-ops.quarantine.v1:local-load:00000000",
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(replay).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
