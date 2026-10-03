/**
 * `db/client.ts`'s hookup of the unapplied-ops journal (B-247): `applyOps` keeps a copy until the
 * worker answers, and `initDb` hands a dead page load's copies to the worker's `replayLocalOps`.
 * The journal itself is `unapplied-ops.test.ts`; this is only the wiring, against a fake worker.
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
vi.mock("../platform/index.js", () => ({ platform: { lifecycle: { on: () => {} } } }));
vi.stubGlobal(
  "Worker",
  class {
    postMessage(): void {}
  },
);

const PREFIX = "nooklet.unapplied-ops.v1:";
const store = new Map<string, string>();
const orphan: Op = makeOp("2026-09-13T09:00:00.000Z-0000-dev00001", "dev00001", "block1", {
  kind: "block.text",
  content: "typed before the reload",
});
// Written by a page load that died before its worker answered.
store.set(`${PREFIX}load-that-died:00000000`, JSON.stringify({ at: 1, ops: [orphan] }));
vi.stubGlobal("localStorage", {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { applyOps, initDb } = await import("./client.js");
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("db/client.ts keeps every write until the worker has it (B-247)", () => {
  it("replays a dead page load's batch at start and forgets it once the worker applied it", async () => {
    const replay = vi.fn(async (_ops: Op[]) => ({ replayed: 1, skipped: 0 }));
    if (fake.worker) fake.worker.remote.replayLocalOps = replay;
    await initDb();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith([orphan]));
    await settle();
    expect([...store.keys()]).toEqual([]);
  });

  it("holds a copy of a write from before the worker is asked until it answers", async () => {
    let answer!: () => void;
    const apply = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ results: [], applied: 1, noop: 0, rejected: 0 });
        }),
    );
    if (fake.worker) fake.worker.remote.applyLocalOps = apply;
    const op = makeOp("2026-09-13T09:00:01.000Z-0000-dev00001", "dev00001", "block1", {
      kind: "block.text",
      content: "queued",
    });

    const result = applyOps([op]);
    // Synchronously, before the worker has done anything: this is what survives an unload.
    const copies = [...store.values()].map((v) => (JSON.parse(v) as { ops: Op[] }).ops);
    expect(copies).toEqual([[op]]);

    // B-582: `applyOps` now awaits the worker being ready before calling `applyLocalOps` (the fix
    // for a startup race), so unlike the synchronous record above, the worker call itself lands a
    // tick later — wait for it rather than assuming `answer` is already assigned.
    await vi.waitFor(() => expect(apply).toHaveBeenCalled());
    answer();
    await result;
    await settle();
    expect(store.size).toBe(0);
  });
});
