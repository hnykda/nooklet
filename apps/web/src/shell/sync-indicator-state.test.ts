import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../sync/types.js";
import {
  ATTENTION_DELAY_MS,
  createQuietView,
  deriveSyncView,
  type SyncView,
  syncLabel,
} from "./sync-indicator-state.js";

const status = (s: Partial<SyncStatus>): SyncStatus => ({
  state: "idle",
  pendingCount: 0,
  serverCursor: 0,
  ...s,
});

describe("deriveSyncView", () => {
  it("says where the replica lives before anything about sync (B-43, B-81)", () => {
    expect(deriveSyncView("memory", status({ pendingCount: 3 }))).toBe("memory");
    expect(deriveSyncView("follower", status({ state: "offline" }))).toBe("follower");
  });

  it("maps the sync client's states", () => {
    expect(deriveSyncView("opfs", undefined)).toBe("starting");
    expect(deriveSyncView("opfs", status({ state: "bootstrapping" }))).toBe("starting");
    expect(deriveSyncView("opfs", status({ state: "offline", pendingCount: 2 }))).toBe("offline");
    expect(deriveSyncView("opfs", status({ state: "error" }))).toBe("error");
    expect(deriveSyncView("opfs", status({ state: "pushing", pendingCount: 1 }))).toBe("pending");
    expect(deriveSyncView("opfs", status({ state: "pulling" }))).toBe("synced");
    expect(deriveSyncView(undefined, status({}))).toBe("synced");
  });
});

describe("syncLabel", () => {
  it("counts pending changes in words", () => {
    expect(syncLabel("pending", 1)).toBe("1 change waiting to sync");
    expect(syncLabel("pending", 3)).toBe("3 changes waiting to sync");
    expect(syncLabel("synced", 0)).toBe("Synced");
    expect(syncLabel("offline", 2)).toBe("Offline — changes are kept and sent when back online");
  });
});

describe("createQuietView (B-540: a routine push never blinks)", () => {
  let shown: SyncView[];
  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
  });
  afterEach(() => vi.useRealTimers());

  const quiet = (initial: SyncView = "synced") =>
    createQuietView((v) => shown.push(v), { initial });

  it("a push that lands inside the delay shows nothing at all", () => {
    const q = quiet();
    q.update("pending");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS - 1);
    q.update("synced");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS * 2);
    expect(shown).toEqual([]);
  });

  it("pending that outlasts the delay shows, and recovery shows at once", () => {
    const q = quiet();
    q.update("pending");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS);
    expect(shown).toEqual(["pending"]);
    q.update("synced");
    expect(shown).toEqual(["pending", "synced"]);
  });

  it("a count change does not restart the wait, and the state shown is the latest one", () => {
    const q = quiet();
    q.update("pending");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS / 2);
    q.update("pending");
    q.update("offline");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS / 2);
    expect(shown).toEqual(["offline"]);
  });

  it("moves between attention states immediately once one is showing", () => {
    const q = quiet();
    q.update("offline");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS);
    q.update("pending");
    q.update("error");
    expect(shown).toEqual(["offline", "pending", "error"]);
  });

  it("storage facts and the first answer show without waiting", () => {
    const q = quiet("starting");
    q.update("synced");
    q.update("follower");
    expect(shown).toEqual(["synced", "follower"]);
  });

  it("the start-up 'offline' before the first pull never shows if the pull succeeds", () => {
    const q = quiet("starting");
    q.update("offline");
    vi.advanceTimersByTime(300);
    q.update("synced");
    vi.advanceTimersByTime(ATTENTION_DELAY_MS);
    expect(shown).toEqual(["synced"]);
  });

  it("dispose cancels a pending wait", () => {
    const q = quiet();
    q.update("error");
    q.dispose();
    vi.advanceTimersByTime(ATTENTION_DELAY_MS * 2);
    expect(shown).toEqual([]);
  });
});
