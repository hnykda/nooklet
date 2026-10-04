// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { UNAPPLIED_KEY_PREFIX } from "../db/unapplied-ops.js";
import type { GraphListEntry } from "./bootstrap.js";
import { forgetPendingCount, knownPendingCount, rememberPendingCount } from "./pending-memo.js";

const entry: GraphListEntry = { id: "g1", label: "Work", kind: "remote", baseUrl: "/g/work" };

beforeEach(() => localStorage.clear());

describe("B-712: a graph's unsynced changes, known while it is not open", () => {
  it("is unknown until the sync engine reported a count for it", () => {
    expect(knownPendingCount(entry)).toBeUndefined();
    rememberPendingCount("g1", 0);
    expect(knownPendingCount(entry)).toBe(0);
    rememberPendingCount("g1", 5);
    expect(knownPendingCount(entry)).toBe(5);
    forgetPendingCount("g1");
    expect(knownPendingCount(entry)).toBeUndefined();
  });

  it("adds ops still in the B-247 journal for that replica, and only that replica", () => {
    rememberPendingCount("g1", 2);
    localStorage.setItem(
      `${UNAPPLIED_KEY_PREFIX}g1:owner:1`,
      JSON.stringify({ at: 1, ops: [1, 2, 3] }),
    );
    localStorage.setItem(`${UNAPPLIED_KEY_PREFIX}g2:owner:1`, JSON.stringify({ at: 1, ops: [1] }));
    expect(knownPendingCount(entry)).toBe(5);
    // A journal batch alone is proof of unsynced changes even with no recorded count.
    forgetPendingCount("g1");
    expect(knownPendingCount(entry)).toBe(3);
  });
});
