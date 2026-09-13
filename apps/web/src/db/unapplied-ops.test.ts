import { makeOp, type Op } from "@nooklet/core";
import { describe, expect, it, vi } from "vitest";
import {
  createUnappliedOpsJournal,
  type JournalStorage,
  liveOwners,
  type OwnerLocks,
  replayOrphanedBatches,
  UNAPPLIED_KEY_PREFIX,
} from "./unapplied-ops.js";

class MemoryStorage implements JournalStorage {
  readonly map = new Map<string, string>();
  failWrites = false;
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

let n = 0;
function textOp(content: string): Op {
  const hlc = `2026-09-13T10:00:00.000Z-${(n++).toString(16).padStart(4, "0")}-dev00001`;
  return makeOp(hlc, "dev00001", "block1", { kind: "block.text", content });
}

function fakeLocks(heldOwners: string[]): OwnerLocks {
  return {
    request: () => new Promise(() => {}),
    query: async () => ({
      held: heldOwners.map((o) => ({ name: `nooklet.unapplied-ops.owner:${o}` })),
      pending: [{ name: "nooklet-db-writer" }],
    }),
  };
}

describe("the unapplied-ops journal (B-247)", () => {
  it("keeps a batch from record until settle", () => {
    const storage = new MemoryStorage();
    const journal = createUnappliedOpsJournal({ storage, owner: "load-a" });
    const key = journal.record([textOp("x queued")]);
    expect(key?.startsWith(UNAPPLIED_KEY_PREFIX)).toBe(true);
    expect(storage.length).toBe(1);
    journal.settle(key);
    expect(storage.length).toBe(0);
  });

  it("hands over only batches of page loads that are gone, oldest load first, in write order", () => {
    const storage = new MemoryStorage();
    let clock = 1_000;
    const now = () => clock;
    const gone = createUnappliedOpsJournal({ storage, owner: "load-gone", now });
    const g1 = textOp("one");
    const g2 = textOp("two");
    gone.record([g1]);
    gone.record([g2]);
    clock = 500; // an even older page load that also died
    const older = createUnappliedOpsJournal({ storage, owner: "load-older", now });
    const o1 = textOp("older");
    older.record([o1]);
    clock = 2_000;
    const alive = createUnappliedOpsJournal({ storage, owner: "load-alive", now });
    alive.record([textOp("still in flight elsewhere")]);

    const me = createUnappliedOpsJournal({ storage, owner: "load-me" });
    const batches = me.orphaned(new Set(["load-me", "load-alive"]));
    expect(batches.map((b) => b.ops[0]?.id)).toEqual([o1.id, g1.id, g2.id]);
  });

  it("writes nothing and says so when storage refuses (quota) or is missing", () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createUnappliedOpsJournal({ storage }).record([textOp("big paste")])).toBeUndefined();
    expect(createUnappliedOpsJournal({ storage: undefined }).record([textOp("x")])).toBeUndefined();
    warn.mockRestore();
  });

  it("drops an entry it cannot read instead of failing every start", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${UNAPPLIED_KEY_PREFIX}load-old:00000000`, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createUnappliedOpsJournal({ storage }).orphaned(new Set())).toEqual([]);
    expect(storage.length).toBe(0);
    warn.mockRestore();
  });
});

describe("liveOwners", () => {
  it("is every owner whose lock is held, plus this load", async () => {
    expect(await liveOwners(fakeLocks(["load-b"]), "load-a")).toEqual(
      new Set(["load-a", "load-b"]),
    );
  });

  it("is only this load without the Locks API", async () => {
    expect(await liveOwners(undefined, "load-a")).toEqual(new Set(["load-a"]));
  });
});

describe("replayOrphanedBatches", () => {
  it("replays each orphaned batch through the worker and removes it once applied", async () => {
    const storage = new MemoryStorage();
    const dead = createUnappliedOpsJournal({ storage, owner: "load-dead" });
    const a = textOp("x queued");
    dead.record([a]);
    const me = createUnappliedOpsJournal({ storage, owner: "load-me" });
    const apply = vi.fn(async (_ops: Op[]) => ({ replayed: 1, skipped: 0 }));

    await expect(replayOrphanedBatches(me, fakeLocks([]), apply)).resolves.toBe(1);
    expect(apply).toHaveBeenCalledWith([a]);
    expect(storage.length).toBe(0);
  });

  it("leaves a live tab's batch alone", async () => {
    const storage = new MemoryStorage();
    createUnappliedOpsJournal({ storage, owner: "load-other-tab" }).record([textOp("typing")]);
    const me = createUnappliedOpsJournal({ storage, owner: "load-me" });
    const apply = vi.fn(async () => ({}));
    await expect(replayOrphanedBatches(me, fakeLocks(["load-other-tab"]), apply)).resolves.toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(storage.length).toBe(1);
  });

  it("keeps a batch whose replay failed, for the next start", async () => {
    const storage = new MemoryStorage();
    createUnappliedOpsJournal({ storage, owner: "load-dead" }).record([textOp("x")]);
    const me = createUnappliedOpsJournal({ storage, owner: "load-me" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const apply = vi.fn(async () => {
      throw new Error("replica did not open");
    });
    await expect(replayOrphanedBatches(me, fakeLocks([]), apply)).resolves.toBe(0);
    expect(storage.length).toBe(1);
    error.mockRestore();
  });
});
