/**
 * Task-marker commands (`docs/spec/commands-and-keymap.md` §E.2, R34-R36) needed by the block-
 * level marker pill's click-to-cycle behavior (BUILD item 1) and by `Cmd/Ctrl+Enter`. Pure and
 * DOM-free, same seam as `commands.ts` — see `task.test.ts`.
 */
import { makeOp, type Op, type TaskMarker } from "@nooklet/core";
import type { BlockId, Clock, EditableBlock } from "./types.js";

function op(clock: Clock, entity: BlockId, payload: Parameters<typeof makeOp>[3]): Op {
  return makeOp(clock.next(), clock.device, entity, payload);
}

/** Parse a repeat property (`ADR 011`: `"<n><unit>"` or `"<n><unit> from done"`). */
function parseRepeat(
  repeat: string,
): { n: number; unit: "d" | "w" | "m" | "y"; fromDone: boolean } | null {
  const m = /^(\d+)([dwmy])(?: from done)?$/.exec(repeat.trim());
  if (!m) return null;
  return {
    n: Number(m[1]),
    unit: m[2] as "d" | "w" | "m" | "y",
    fromDone: repeat.includes("from done"),
  };
}

/** Advance a `"YYYY-MM-DD"` or `"YYYY-MM-DD HH:MM"` value by a repeat interval, keeping the time
 * part (if any) unchanged. Month/year use calendar-correct addition (`Date`'s own overflow rules
 * handle short months, e.g. Jan 31 + 1 month lands on the last valid day of March's overflow —
 * acceptable for v1; a dedicated calendar-math spec is out of this file's scope). */
function advanceDate(value: string, n: number, unit: "d" | "w" | "m" | "y"): string {
  const [datePart, timePart] = value.split(" ") as [string, string | undefined];
  const [y, mo, d] = datePart.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (unit === "d") dt.setUTCDate(dt.getUTCDate() + n);
  else if (unit === "w") dt.setUTCDate(dt.getUTCDate() + n * 7);
  else if (unit === "m") dt.setUTCMonth(dt.getUTCMonth() + n);
  else dt.setUTCFullYear(dt.getUTCFullYear() + n);
  const iso = dt.toISOString().slice(0, 10);
  return timePart ? `${iso} ${timePart}` : iso;
}

function doneTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** R35: completing a task (any transition to `DONE`). Always stamps `done`; if the block has a
 * `repeat` property, does NOT set `marker = DONE` — instead advances `scheduled`/`deadline`
 * (whichever is present, both if both) from their original value (or from `done` if the repeater
 * has "from done") and resets `marker = TODO`, leaving the task open for its next occurrence. */
export function completeTask(block: EditableBlock, clock: Clock, now: number = Date.now()): Op[] {
  const ops: Op[] = [
    op(clock, block.id, { kind: "block.prop", key: "done", value: doneTimestamp(now) }),
  ];
  const repeat = block.repeat ? parseRepeat(block.repeat) : null;

  if (!repeat) {
    ops.push(op(clock, block.id, { kind: "block.prop", key: "marker", value: "DONE" }));
    return ops;
  }

  const from = repeat.fromDone ? doneTimestamp(now).slice(0, 16).replace("T", " ") : null;
  if (block.scheduled) {
    const base = from ?? block.scheduled;
    ops.push(
      op(clock, block.id, {
        kind: "block.prop",
        key: "scheduled",
        value: advanceDate(base, repeat.n, repeat.unit),
      }),
    );
  }
  if (block.deadline) {
    const base = from ?? block.deadline;
    ops.push(
      op(clock, block.id, {
        kind: "block.prop",
        key: "deadline",
        value: advanceDate(base, repeat.n, repeat.unit),
      }),
    );
  }
  ops.push(op(clock, block.id, { kind: "block.prop", key: "marker", value: "TODO" }));
  return ops;
}

/** R34: `task.cycle`, `null -> TODO -> DOING -> DONE -> null` (wrapping). `WAITING`/`CANCELED`
 * are never reached by cycling. A transition to `DONE` is routed through `completeTask` (R35). */
export function cycleMarker(block: EditableBlock, clock: Clock, now: number = Date.now()): Op[] {
  const next: Record<string, TaskMarker | null> = { TODO: "DOING", DOING: "DONE" };
  const current = block.marker;
  if (current === null)
    return [op(clock, block.id, { kind: "block.prop", key: "marker", value: "TODO" })];
  if (current === "DOING") return completeTask(block, clock, now);
  if (current === "DONE" || current === "WAITING" || current === "CANCELED") {
    // DONE -> null; per R34 WAITING/CANCELED are not part of the cycle, but task.cycle must still
    // be total over any current state it is invoked from (defensive: falls back to clearing).
    return [op(clock, block.id, { kind: "block.prop", key: "marker", value: null })];
  }
  const n = next[current];
  return n
    ? [op(clock, block.id, { kind: "block.prop", key: "marker", value: n })]
    : [op(clock, block.id, { kind: "block.prop", key: "marker", value: null })];
}

/** R36: the checkbox-click equivalent. `DONE -> TODO` (does not restore prior state); any other
 * non-null marker (`TODO`/`DOING`/`WAITING`) completes via R35. */
export function toggleDone(block: EditableBlock, clock: Clock, now: number = Date.now()): Op[] {
  if (block.marker === "DONE") {
    return [op(clock, block.id, { kind: "block.prop", key: "marker", value: "TODO" })];
  }
  return completeTask(block, clock, now);
}
