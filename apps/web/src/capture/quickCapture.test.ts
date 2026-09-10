import { orderBetween } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { makeFakeClock } from "../editor/test-helpers.js";
import { buildQuickCaptureOps, type QuickCaptureOpsResult } from "./quickCapture.js";

const DAY = 20260911;

function fakeIds(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

/** Non-null, non-chained access to the first op's `place.order` — avoids `(result?.ops[0]?.payload)`
 * style unsafe optional chaining while keeping the assertions below readable. */
function firstOpOrder(result: QuickCaptureOpsResult | null): string {
  if (!result) throw new Error("expected a result");
  const op = result.ops[0];
  if (!op) throw new Error("expected at least one op");
  return (op.payload as { place: { order: string } }).place.order;
}

describe("buildQuickCaptureOps", () => {
  it("returns null for blank text (nothing to capture)", () => {
    expect(
      buildQuickCaptureOps({
        target: { pageId: "p1", lastRootOrder: null },
        day: DAY,
        text: "   ",
        clock: makeFakeClock(),
        newId: fakeIds(),
      }),
    ).toBeNull();
  });

  it("trims surrounding whitespace before writing", () => {
    const result = buildQuickCaptureOps({
      target: { pageId: "p1", lastRootOrder: null },
      day: DAY,
      text: "  buy milk  ",
      clock: makeFakeClock(),
      newId: fakeIds(),
      now: 1000,
    });
    expect(result?.ops[0]?.payload).toMatchObject({ kind: "block.create", content: "buy milk" });
  });

  it("creates the journal page first when it does not exist yet", () => {
    const result = buildQuickCaptureOps({
      target: null,
      day: DAY,
      text: "first capture of the day",
      clock: makeFakeClock(),
      newId: fakeIds(),
      now: 1234,
    });
    expect(result).not.toBeNull();
    expect(result?.ops).toHaveLength(2);
    expect(result?.ops[0]?.payload).toMatchObject({
      kind: "page.create",
      journalDay: DAY,
      createdAt: 1234,
    });
    expect(result?.ops[1]?.payload).toMatchObject({
      kind: "block.create",
      content: "first capture of the day",
      createdAt: 1234,
    });
    // The block's page must be the SAME id the page.create op targets (`op.entity`), not a fresh one.
    const pageOpEntity = result?.ops[0]?.entity;
    expect(result?.ops[1]?.payload).toMatchObject({
      place: { pageId: pageOpEntity, parentId: null },
    });
    expect(result?.pageId).toBe(pageOpEntity);
  });

  it("appends one block.create after the last root block when the page already exists", () => {
    const result = buildQuickCaptureOps({
      target: { pageId: "existing-page", lastRootOrder: "a1" },
      day: DAY,
      text: "second capture",
      clock: makeFakeClock(),
      newId: fakeIds(),
    });
    expect(result?.ops).toHaveLength(1);
    expect(result?.ops[0]?.payload).toMatchObject({
      kind: "block.create",
      content: "second capture",
      place: { pageId: "existing-page", parentId: null },
    });
    expect(result?.pageId).toBe("existing-page");
    // The new order must sort after the existing last root block.
    expect(firstOpOrder(result) > "a1").toBe(true);
  });

  it("places the first block with an order valid as an orderBetween(null, null) bound", () => {
    const result = buildQuickCaptureOps({
      target: { pageId: "p1", lastRootOrder: null },
      day: DAY,
      text: "only capture",
      clock: makeFakeClock(),
      newId: fakeIds(),
    });
    const order = firstOpOrder(result);
    // Should not throw: a fresh order key is always a valid bound for a subsequent orderBetween call.
    expect(() => orderBetween(order, null)).not.toThrow();
  });

  it("mints every id via the injected newId (never reuses target.pageId as a fresh id)", () => {
    const ids = fakeIds();
    const result = buildQuickCaptureOps({
      target: { pageId: "existing-page", lastRootOrder: null },
      day: DAY,
      text: "capture",
      clock: makeFakeClock(),
      newId: ids,
    });
    expect(result?.ops).toHaveLength(1);
    expect(result?.ops[0]?.entity).toBe("id-0");
  });

  it("mints two distinct HLCs (op ids) for the page+block case, both from the injected clock", () => {
    const result = buildQuickCaptureOps({
      target: null,
      day: DAY,
      text: "capture",
      clock: makeFakeClock(),
      newId: fakeIds(),
    });
    expect(result?.ops[0]?.id).not.toBe(result?.ops[1]?.id);
  });
});
