/**
 * Test double for the DB worker's Comlink remote, with the one property that matters for the
 * listener tests: like `db.worker.ts`, it keeps exactly ONE change listener and ONE sync-status
 * listener, and each `onChange`/`onSyncStatus` call replaces the previous one. Tests mock
 * `comlink` so `db/client.ts` — the real one — talks to this.
 *
 * Not a `*.test.ts` file, so vitest does not collect it; imported from tests only.
 */
import type { SyncStatus } from "../sync/types.js";
import type { ChangeEvent } from "./worker-api.js";

export interface FakeWorker {
  remote: Record<string, (...args: never[]) => unknown>;
  /** Fire the worker's (single) change listener, as `WorkerDb` does after a write. */
  emitChange(e: ChangeEvent): void;
  emitStatus(s: SyncStatus): void;
  /** How many times something registered with the worker (a replaced slot counts). */
  registrations: { change: number; status: number };
  queryCalls: number;
}

export function createFakeWorker(): FakeWorker {
  let changeListener: ((e: ChangeEvent) => void) | undefined;
  let statusListener: ((s: SyncStatus) => void) | undefined;
  const fake: FakeWorker = {
    registrations: { change: 0, status: 0 },
    queryCalls: 0,
    emitChange: (e) => changeListener?.(e),
    emitStatus: (s) => statusListener?.(s),
    remote: {
      init: async () => ({ deviceId: "test-device", storage: "memory" }),
      // db.worker.ts: `changeListener = cb` — a single slot.
      onChange: async (cb: (e: ChangeEvent) => void) => {
        fake.registrations.change++;
        changeListener = cb;
      },
      onSyncStatus: async (cb: (s: SyncStatus) => void) => {
        fake.registrations.status++;
        statusListener = cb;
      },
      query: async () => {
        fake.queryCalls++;
        return [];
      },
      getSyncStatus: async () => ({ state: "idle", pendingCount: 0, serverCursor: 0 }),
      getPageTree: async () => undefined,
      getJournalStream: async () => [],
      pageBacklinks: async (target: string) => ({
        target,
        linked: [],
        linked_total: 0,
        linked_direct_total: 0,
        unlinked: [],
        unlinked_truncated: false,
        unlinkedAvailable: true,
        tagged_pages: [],
        tagged_total: 0,
      }),
      graphLinks: async () => ({
        nodes: [],
        edges: [],
        total_nodes: 0,
        total_edges: 0,
        truncated: false,
      }),
      notifyLifecycle: async () => {},
      forceSync: async () => {},
      nextHlc: async () => "0000000000000-0000-test",
      getDeviceId: async () => "test-device",
      applyLocalOps: async () => ({ results: [], applied: 0, noop: 0, rejected: 0 }),
      replayLocalOps: async () => ({ replayed: 0, skipped: 0 }),
    },
  };
  return fake;
}
