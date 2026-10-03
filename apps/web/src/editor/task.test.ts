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

// B-608: the editor's Mod+Enter in a graph whose workflow is Logseq's `:now` (the owner's).
describe("cycleMarker / toggleDone under the `now` workflow (B-608)", () => {
  const markerOf = (ops: ReturnType<typeof cycleMarker>) =>
    ops.find((o) => o.payload.kind === "block.prop" && o.payload.key === "marker")?.payload;

  it("none → LATER → NOW → (DONE via R35) → none", () => {
    const clock = makeFakeClock();
    const at = (marker: Parameters<typeof makeBlock>[0]["marker"]) =>
      markerOf(cycleMarker(makeBlock({ id: "A", marker }), clock, NOW, "now"));
    expect(at(null)).toEqual({ kind: "block.prop", key: "marker", value: "LATER" });
    expect(at("LATER")).toEqual({ kind: "block.prop", key: "marker", value: "NOW" });
    expect(at("NOW")).toEqual({ kind: "block.prop", key: "marker", value: "DONE" });
    expect(at("DONE")).toEqual({ kind: "block.prop", key: "marker", value: null });
    // NOW → DONE is a completion: `done` is stamped first (R35).
    const ops = cycleMarker(makeBlock({ id: "A", marker: "NOW" }), clock, NOW, "now");
    expect(ops[0]?.payload).toEqual({
      kind: "block.prop",
      key: "done",
      value: "2026-01-01T00:00:00Z",
    });
  });

  it("a TODO block still cycles to DOING; a LATER block under `todo` still goes to NOW", () => {
    const clock = makeFakeClock();
    expect(
      markerOf(cycleMarker(makeBlock({ id: "A", marker: "TODO" }), clock, NOW, "now")),
    ).toEqual({ kind: "block.prop", key: "marker", value: "DOING" });
    expect(
      markerOf(cycleMarker(makeBlock({ id: "A", marker: "LATER" }), clock, NOW, "todo")),
    ).toEqual({ kind: "block.prop", key: "marker", value: "NOW" });
  });

  it("un-ticking a DONE checkbox reopens as LATER", () => {
    const ops = toggleDone(makeBlock({ id: "A", marker: "DONE" }), makeFakeClock(), NOW, "now");
    expect(ops.map((o) => o.payload)).toEqual([
      { kind: "block.prop", key: "marker", value: "LATER" },
    ]);
  });

  it("a repeating NOW task reopens as LATER, with its date advanced", () => {
    const block = makeBlock({ id: "A", marker: "NOW", scheduled: "2026-09-10", repeat: "1w" });
    const ops = cycleMarker(block, makeFakeClock(), NOW, "now").map((o) => o.payload);
    expect(ops).toContainEqual({ kind: "block.prop", key: "scheduled", value: "2026-09-17" });
    expect(ops).toContainEqual({ kind: "block.prop", key: "marker", value: "LATER" });
  });
});
