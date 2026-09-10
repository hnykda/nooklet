import { describe, expect, it } from "vitest";
import type { LoggedOp } from "../ops.js";
import { planOpLogGc } from "./gc.js";

function op(seq: number, status: LoggedOp["status"] = "applied"): LoggedOp {
  return {
    seq,
    id: `op-${seq}`,
    hlc: `2026-09-10T00:00:00.000Z-0000-aaaaaaa${seq % 10}`,
    device: "aaaaaaaa",
    entity: "blk1",
    payload: { kind: "block.text", content: `v${seq}` },
    status,
  };
}

describe("planOpLogGc", () => {
  it("partitions strictly on seq < floorSeq", () => {
    const log = [op(1), op(2), op(3), op(4), op(5)];
    const plan = planOpLogGc(log, 3);
    expect(plan.drop.map((o) => o.seq)).toEqual([1, 2]);
    expect(plan.retain.map((o) => o.seq)).toEqual([3, 4, 5]);
  });

  it("drops nothing when floorSeq is at or before the first op", () => {
    const log = [op(1), op(2)];
    expect(planOpLogGc(log, 0).drop).toEqual([]);
    expect(planOpLogGc(log, 1).drop).toEqual([]);
  });

  it("drops everything when floorSeq is past the last op", () => {
    const log = [op(1), op(2)];
    const plan = planOpLogGc(log, 100);
    expect(plan.retain).toEqual([]);
    expect(plan.drop.map((o) => o.seq)).toEqual([1, 2]);
  });

  it("is indifferent to op status: rejected/noop ops are ordinary log rows", () => {
    const log = [op(1, "rejected"), op(2, "noop"), op(3, "applied")];
    const plan = planOpLogGc(log, 2);
    expect(plan.drop.map((o) => o.seq)).toEqual([1]);
    expect(plan.retain.map((o) => o.seq)).toEqual([2, 3]);
  });

  it("handles an empty log", () => {
    expect(planOpLogGc([], 10)).toEqual({ drop: [], retain: [] });
  });

  it("never reorders ops within a partition", () => {
    const log = [op(5), op(1), op(9), op(2)];
    const plan = planOpLogGc(log, 5);
    expect(plan.drop.map((o) => o.seq)).toEqual([1, 2]);
    expect(plan.retain.map((o) => o.seq)).toEqual([5, 9]);
  });
});
