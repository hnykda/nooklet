/**
 * `submitQuickCapture` exercised entirely against a fake `QuickCaptureDeps` seam — no worker, no
 * Comlink, no OPFS. This is the "fake data seam" the M5 task brief asks the quick-capture route's
 * tests to use.
 */
import type { ApplyOpsResult, Op } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { makeFakeClock } from "../editor/test-helpers.js";
import { type QuickCaptureDeps, submitQuickCapture } from "./quickCaptureService.js";

const OK: ApplyOpsResult = { results: [], applied: 0, noop: 0, rejected: 0 };

function fakeDeps(overrides: Partial<QuickCaptureDeps> = {}): {
  deps: QuickCaptureDeps;
  applied: Op[][];
} {
  const applied: Op[][] = [];
  let idSeq = 0;
  const deps: QuickCaptureDeps = {
    today: () => 20260911,
    findTarget: async () => null,
    getClock: async () => makeFakeClock(),
    newId: () => `id-${idSeq++}`,
    applyOps: async (ops) => {
      applied.push(ops);
      return OK;
    },
    now: () => 42,
    ...overrides,
  };
  return { deps, applied };
}

describe("submitQuickCapture", () => {
  it("does nothing for blank text: no target lookup side effect needed, no ops applied", async () => {
    const { deps, applied } = fakeDeps();
    const result = await submitQuickCapture("   ", deps);
    expect(result).toBeNull();
    expect(applied).toHaveLength(0);
  });

  it("creates today's journal page and its first block when no page exists yet", async () => {
    const { deps, applied } = fakeDeps({ findTarget: async () => null });
    const result = await submitQuickCapture("walk the dog", deps);
    expect(result).not.toBeNull();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(2);
    expect(applied[0]?.[0]?.payload).toMatchObject({ kind: "page.create", journalDay: 20260911 });
    expect(applied[0]?.[1]?.payload).toMatchObject({
      kind: "block.create",
      content: "walk the dog",
    });
    expect(result?.pageId).toBe(applied[0]?.[0]?.entity);
  });

  it("appends after the existing last root block when the page already has one", async () => {
    const { deps, applied } = fakeDeps({
      findTarget: async () => ({ pageId: "today-page", lastRootOrder: "a5" }),
    });
    const result = await submitQuickCapture("second thought", deps);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(1);
    expect(applied[0]?.[0]?.payload).toMatchObject({
      kind: "block.create",
      content: "second thought",
      place: { pageId: "today-page", parentId: null },
    });
    expect(result?.pageId).toBe("today-page");
  });

  it("looks up the target for the day `today()` reports, not a hard-coded one", async () => {
    let lookedUpDay: number | undefined;
    const { deps } = fakeDeps({
      today: () => 20991231,
      findTarget: async (day) => {
        lookedUpDay = day;
        return null;
      },
    });
    await submitQuickCapture("new year's eve note", deps);
    expect(lookedUpDay).toBe(20991231);
  });

  it("calls applyOps exactly once even for the two-op (page+block) case (one atomic write)", async () => {
    const { deps, applied } = fakeDeps({ findTarget: async () => null });
    await submitQuickCapture("atomic please", deps);
    expect(applied).toHaveLength(1);
  });

  it("ADR 033: a queued capture lands on the day it was made, with its own time and block id", async () => {
    let lookedUpDay: number | undefined;
    const { deps, applied } = fakeDeps({
      today: () => 20991231,
      findTarget: async (day) => {
        lookedUpDay = day;
        return null;
      },
    });
    // Local noon, so the day is the same in every time zone the suite runs in.
    const at = new Date(2026, 9, 2, 12, 0, 0).getTime();
    const result = await submitQuickCapture("from the queue", deps, {
      at,
      blockId: "0000000000abcd",
    });
    expect(lookedUpDay).toBe(20261002);
    expect(result?.blockId).toBe("0000000000abcd");
    expect(result?.rejected).toBe(0);
    expect(applied[0]?.[1]).toMatchObject({
      entity: "0000000000abcd",
      payload: { kind: "block.create", createdAt: at, content: "from the queue" },
    });
  });
});
