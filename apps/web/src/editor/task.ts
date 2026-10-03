/**
 * Task-marker commands (`docs/spec/commands-and-keymap.md` §E.2, R34-R36) needed by the block-
 * level marker pill's click-to-cycle behavior (BUILD item 1) and by `Cmd/Ctrl+Enter`. Pure and
 * DOM-free, same seam as `commands.ts` — see `task.test.ts`.
 */
import {
  cycleTaskMarker,
  formatDoneIso,
  makeOp,
  type Op,
  repeatReopenMarker,
  type TaskWorkflow,
  workflowStartMarker,
} from "@nooklet/core";
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

/** Advance a bare `"YYYY-MM-DD"` date by a repeat interval. Month/year use calendar-correct
 * addition (`Date`'s own overflow rules handle short months, e.g. Jan 31 + 1 month lands on the
 * last valid day of March's overflow — acceptable for v1; a dedicated calendar-math spec is out
 * of this file's scope). */
function advanceDateOnly(dateOnly: string, n: number, unit: "d" | "w" | "m" | "y"): string {
  const [y, mo, d] = dateOnly.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (unit === "d") dt.setUTCDate(dt.getUTCDate() + n);
  else if (unit === "w") dt.setUTCDate(dt.getUTCDate() + n * 7);
  else if (unit === "m") dt.setUTCMonth(dt.getUTCMonth() + n);
  else dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return dt.toISOString().slice(0, 10);
}

/** Advance one `scheduled`/`deadline` field: the DATE anchor is either the field's own original
 * date or (for a "from done" repeater) `doneDateOnly`, but the OUTPUT's time-of-day always comes
 * from the field's own original value (date-only stays date-only) — never from the `done`
 * timestamp's incidental time-of-day, which would otherwise leak a spurious "00:00" onto a
 * previously date-only field. */
function advanceField(
  value: string,
  n: number,
  unit: "d" | "w" | "m" | "y",
  doneDateOnly: string | null,
): string {
  const [datePart, timePart] = value.split(" ") as [string, string | undefined];
  const anchor = doneDateOnly ?? datePart;
  const advanced = advanceDateOnly(anchor, n, unit);
  return timePart ? `${advanced} ${timePart}` : advanced;
}

/** R35: completing a task (any transition to `DONE`). Always stamps `done`; if the block has a
 * `repeat` property, does NOT set `marker = DONE` — instead advances `scheduled`/`deadline`
 * (whichever is present, both if both) from their original value (or from `done` if the repeater
 * has "from done") and reopens it — `LATER` for a LATER/NOW task, else `TODO` (B-608) — leaving it
 * open for its next occurrence. */
export function completeTask(block: EditableBlock, clock: Clock, now: number = Date.now()): Op[] {
  const ops: Op[] = [
    op(clock, block.id, { kind: "block.prop", key: "done", value: formatDoneIso(now) }),
  ];
  const repeat = block.repeat ? parseRepeat(block.repeat) : null;

  if (!repeat) {
    ops.push(op(clock, block.id, { kind: "block.prop", key: "marker", value: "DONE" }));
    return ops;
  }

  const doneDateOnly = repeat.fromDone ? formatDoneIso(now).slice(0, 10) : null;
  if (block.scheduled) {
    ops.push(
      op(clock, block.id, {
        kind: "block.prop",
        key: "scheduled",
        value: advanceField(block.scheduled, repeat.n, repeat.unit, doneDateOnly),
      }),
    );
  }
  if (block.deadline) {
    ops.push(
      op(clock, block.id, {
        kind: "block.prop",
        key: "deadline",
        value: advanceField(block.deadline, repeat.n, repeat.unit, doneDateOnly),
      }),
    );
  }
  ops.push(
    op(clock, block.id, {
      kind: "block.prop",
      key: "marker",
      value: repeatReopenMarker(block.marker),
    }),
  );
  return ops;
}

/** R34 as amended by B-608, Logseq's `cycle-marker-state`: `TODO→DOING→DONE`,
 * `LATER→NOW→DONE`, `DONE→none`; none, WAITING and CANCELED start the graph's workflow (`LATER`
 * under `now`, `TODO` under `todo`). A transition to `DONE` is routed through `completeTask` (R35).
 * `workflow` is a parameter, not a read of the signal, to keep this module pure. */
export function cycleMarker(
  block: EditableBlock,
  clock: Clock,
  now: number = Date.now(),
  workflow: TaskWorkflow = "todo",
): Op[] {
  const next = cycleTaskMarker(block.marker, workflow);
  if (next === "DONE") return completeTask(block, clock, now);
  return [op(clock, block.id, { kind: "block.prop", key: "marker", value: next })];
}

/** R36: the checkbox-click equivalent. `DONE →` the workflow's start marker (does not restore the
 * prior state; Logseq's `uncheck` writes LATER under `now`, B-608); any other non-null marker
 * completes via R35. */
export function toggleDone(
  block: EditableBlock,
  clock: Clock,
  now: number = Date.now(),
  workflow: TaskWorkflow = "todo",
): Op[] {
  if (block.marker === "DONE") {
    return [
      op(clock, block.id, {
        kind: "block.prop",
        key: "marker",
        value: workflowStartMarker(workflow),
      }),
    ];
  }
  return completeTask(block, clock, now);
}
