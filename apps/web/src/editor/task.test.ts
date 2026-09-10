import { describe, expect, it } from "vitest";
import { completeTask, cycleMarker, toggleDone } from "./task.js";
import { makeBlock, makeFakeClock } from "./test-helpers.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("cycleMarker (R34)", () => {
  it("null -> TODO -> DOING -> (DONE via R35) -> null, wrapping", () => {
    const clock = makeFakeClock();
    let block = makeBlock({ id: "A", marker: null });

    let ops = cycleMarker(block, clock, NOW);
    expect(ops).toEqual([
      expect.objectContaining({ payload: { kind: "block.prop", key: "marker", value: "TODO" } }),
    ]);

    block = { ...block, marker: "TODO" };
    ops = cycleMarker(block, clock, NOW);
    expect(ops).toEqual([
      expect.objectContaining({ payload: { kind: "block.prop", key: "marker", value: "DOING" } }),
    ]);

    block = { ...block, marker: "DOING" };
    ops = cycleMarker(block, clock, NOW);
    // DOING -> DONE goes through R35: stamps `done`, then sets marker DONE (no repeat).
    expect(ops.map((o) => o.payload)).toEqual([
      { kind: "block.prop", key: "done", value: "2026-01-01T00:00:00Z" },
      { kind: "block.prop", key: "marker", value: "DONE" },
    ]);

    block = { ...block, marker: "DONE" };
    ops = cycleMarker(block, clock, NOW);
    expect(ops).toEqual([
      expect.objectContaining({ payload: { kind: "block.prop", key: "marker", value: null } }),
    ]);
  });

  it("never lands on WAITING or CANCELED", () => {
    const clock = makeFakeClock();
    for (const marker of ["TODO", "DOING", "DONE"] as const) {
      const ops = cycleMarker(makeBlock({ id: "A", marker }), clock, NOW);
      for (const o of ops) {
        if (o.payload.kind === "block.prop" && o.payload.key === "marker") {
          expect(o.payload.value).not.toBe("WAITING");
          expect(o.payload.value).not.toBe("CANCELED");
        }
      }
    }
  });
});

describe("completeTask / R35 repeat-aware completion", () => {
  it("with no repeat: stamps done and sets marker DONE", () => {
    const block = makeBlock({ id: "A", marker: "TODO", scheduled: "2026-09-12" });
    const ops = completeTask(block, makeFakeClock(), NOW).map((o) => o.payload);
    expect(ops).toEqual([
      { kind: "block.prop", key: "done", value: "2026-01-01T00:00:00Z" },
      { kind: "block.prop", key: "marker", value: "DONE" },
    ]);
  });

  it("with a plain repeat: advances scheduled from its ORIGINAL date, resets marker to TODO, still stamps done", () => {
    const block = makeBlock({ id: "A", marker: "TODO", scheduled: "2026-09-12", repeat: "1w" });
    const ops = completeTask(block, makeFakeClock(), NOW).map((o) => o.payload);
    expect(ops).toEqual([
      { kind: "block.prop", key: "done", value: "2026-01-01T00:00:00Z" },
      { kind: "block.prop", key: "scheduled", value: "2026-09-19" },
      { kind: "block.prop", key: "marker", value: "TODO" },
    ]);
  });

  it("with 'from done': advances from the just-stamped done timestamp, not the original date", () => {
    const block = makeBlock({
      id: "A",
      marker: "TODO",
      deadline: "2026-01-01",
      repeat: "2d from done",
    });
    // now = 2026-09-10T00:00:00Z per makeFakeClock's fixed wall time base used for `done`.
    const ops = completeTask(block, makeFakeClock(), Date.parse("2026-09-10T00:00:00.000Z")).map(
      (o) => o.payload,
    );
    expect(ops).toEqual([
      { kind: "block.prop", key: "done", value: "2026-09-10T00:00:00Z" },
      { kind: "block.prop", key: "deadline", value: "2026-09-12" },
      { kind: "block.prop", key: "marker", value: "TODO" },
    ]);
  });

  it("advances both scheduled and deadline when both are present", () => {
    const block = makeBlock({
      id: "A",
      marker: "TODO",
      scheduled: "2026-09-12",
      deadline: "2026-09-14 14:00",
      repeat: "1w",
    });
    const ops = completeTask(block, makeFakeClock(), NOW).map((o) => o.payload);
    expect(ops).toContainEqual({ kind: "block.prop", key: "scheduled", value: "2026-09-19" });
    expect(ops).toContainEqual({ kind: "block.prop", key: "deadline", value: "2026-09-21 14:00" });
  });
});

describe("toggleDone (R36)", () => {
  it("DONE -> TODO (does not restore prior state)", () => {
    const ops = toggleDone(makeBlock({ id: "A", marker: "DONE" }), makeFakeClock(), NOW);
    expect(ops).toEqual([
      expect.objectContaining({ payload: { kind: "block.prop", key: "marker", value: "TODO" } }),
    ]);
  });

  it("any other non-null marker completes via R35", () => {
    const ops = toggleDone(makeBlock({ id: "A", marker: "WAITING" }), makeFakeClock(), NOW).map(
      (o) => o.payload,
    );
    expect(ops).toContainEqual({ kind: "block.prop", key: "marker", value: "DONE" });
  });
});
