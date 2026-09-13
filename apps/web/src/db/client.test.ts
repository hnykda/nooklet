/**
 * `db/client.ts` against a worker that — like the real `db.worker.ts` — holds one change listener
 * and one sync-status listener. Several modules subscribe (`data/store.ts`, `data/history.ts`,
 * every `useSyncStatus()` caller), so the client must fan out rather than forward each
 * subscription to the worker's single slot (B-130).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../sync/types.js";
import type { FakeWorker } from "./fake-worker.js";
import type { ChangeEvent } from "./worker-api.js";

const fake = vi.hoisted(() => ({ worker: undefined as FakeWorker | undefined }));

vi.mock("comlink", async () => {
  const { createFakeWorker } = await import("./fake-worker.js");
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

import { onChange, onSyncStatus } from "./client.js";

const settle = () => new Promise((r) => setTimeout(r, 0));
const event: ChangeEvent = { tables: ["block"], pageIds: ["p1"] };
const status = (pendingCount: number): SyncStatus => ({
  state: "idle",
  pendingCount,
  serverCursor: 0,
});

const unsubscribers: Array<() => void> = [];
afterEach(() => {
  for (const u of unsubscribers.splice(0)) u();
});

describe("change listeners fan out over the worker's single slot (B-130)", () => {
  it("two onChange subscribers both receive a ChangeEvent", async () => {
    const a = vi.fn();
    const b = vi.fn();
    unsubscribers.push(onChange(a), onChange(b));
    await settle();
    fake.worker?.emitChange(event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("registers with the worker once, however many subscribe", async () => {
    unsubscribers.push(
      onChange(() => {}),
      onChange(() => {}),
      onChange(() => {}),
    );
    await settle();
    expect(fake.worker?.registrations.change).toBe(1);
  });

  it("an unsubscribed callback stops receiving events; the others keep theirs", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onChange(a);
    unsubscribers.push(onChange(b));
    offA();
    await settle();
    fake.worker?.emitChange(event);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a subscriber that throws does not starve the ones after it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = vi.fn();
    unsubscribers.push(
      onChange(() => {
        throw new Error("boom");
      }),
      onChange(b),
    );
    await settle();
    fake.worker?.emitChange(event);
    expect(b).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("two onSyncStatus subscribers both receive a status", async () => {
    const a = vi.fn();
    const b = vi.fn();
    unsubscribers.push(onSyncStatus(a), onSyncStatus(b));
    await settle();
    fake.worker?.emitStatus(status(0));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(fake.worker?.registrations.status).toBe(1);
  });
});
