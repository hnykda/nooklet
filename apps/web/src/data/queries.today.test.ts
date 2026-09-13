/**
 * B-94: a ```query fence that says `today` re-runs when the local day changes, with nothing else
 * changing — under a fake clock, at midnight and after a page wakes up. The SQL runner is a spy:
 * the day the prefilter binds is the day the query was evaluated for.
 */

import { parseQuery, type Query } from "@nooklet/core";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryAs = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock("../db/client.js", () => ({
  queryAs: (sql: string, params?: unknown[]) => queryAs(sql, params),
}));
vi.mock("./store.js", () => ({
  stampedFor: <T>(value: T) => ({ value, version: 0 }),
}));

import { resetSharedDayClock } from "./day-clock.js";
import { useQueryResults } from "./queries.js";

function q(text: string): Query {
  const r = parseQuery(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.query;
}

/** Every day number the candidate query was bound with, in call order. */
function evaluatedDays(): unknown[] {
  return queryAs.mock.calls
    .filter(([sql]) => sql.includes("LIMIT ?"))
    .map(([, params]) => (params ?? []).find((p) => typeof p === "number" && p > 19000000));
}

describe("useQueryResults and the local day (B-94)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryAs.mockClear();
  });
  afterEach(() => {
    resetSharedDayClock();
    vi.useRealTimers();
  });

  it("re-evaluates `today` at local midnight without any table changing", async () => {
    vi.setSystemTime(new Date(2026, 8, 12, 23, 59, 50));
    resetSharedDayClock();

    const dispose = createRoot((d) => {
      useQueryResults(() => q("marker:open scheduled:<=today"));
      return d;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluatedDays()).toEqual([20260912]);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(evaluatedDays()).toEqual([20260912, 20260913]);

    // A capped re-check on the same day evaluates nothing again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(evaluatedDays()).toEqual([20260912, 20260913]);
    dispose();
  });

  it("re-evaluates when the page becomes visible after sleeping through midnight", async () => {
    vi.setSystemTime(new Date(2026, 8, 12, 21, 0, 0));
    resetSharedDayClock();
    // The shared clock listens on the real `document`; this suite runs in node, so give it one.
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    vi.stubGlobal("document", doc);
    try {
      resetSharedDayClock();
      const dispose = createRoot((d) => {
        useQueryResults(() => q("scheduled:today"));
        return d;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(evaluatedDays()).toEqual([20260912]);

      // Suspended: the wall clock moves, no timer fires.
      vi.setSystemTime(new Date(2026, 8, 13, 7, 0, 0));
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(evaluatedDays()).toEqual([20260912, 20260913]);
      dispose();
    } finally {
      resetSharedDayClock();
      vi.unstubAllGlobals();
    }
  });
});
