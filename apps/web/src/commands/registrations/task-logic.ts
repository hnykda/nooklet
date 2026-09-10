/**
 * R34-R39: pure task-state transition logic, kept independent of `Store`/`EditorHost` so it's
 * exhaustively unit-testable. `registrations/task.ts` wires these to the actual read/write seam.
 */
import type { TaskMarker } from "@nooklet/core";

export interface TaskSnapshot {
  marker: TaskMarker | null;
  scheduled?: string;
  deadline?: string;
  /** ADR 011: `"<n><unit>"` or `"<n><unit> from done"`, unit in `d|w|m|y`. */
  repeat?: string;
}

export interface CompletionResult {
  marker: TaskMarker;
  /** ISO 8601 UTC, e.g. "2026-09-10T12:34:56Z". */
  done: string;
  scheduled?: string;
  deadline?: string;
}

const REPEAT_RE = /^(\d+)([dwmy])(?: from done)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/** Format an epoch-ms instant as ADR 011's `done` shape: ISO 8601 UTC, seconds precision. */
export function formatDoneTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}Z`;
}

/** Add `n` of `unit` to a `scheduled`/`deadline`-shaped date string (R38's `YYYY-MM-DD[ HH:MM]`),
 * preserving whether it carries a time-of-day component. Month/year use calendar arithmetic (not
 * a fixed day count), matching everyday "repeat monthly" expectations (the 10th, not +30 days). */
function addInterval(dateStr: string, n: number, unit: "d" | "w" | "m" | "y"): string {
  const m = DATE_RE.exec(dateStr);
  if (!m) return dateStr; // defensive: malformed input passes through unchanged.
  const [, y, mo, d, hh, mm] = m as unknown as [string, string, string, string, string?, string?];
  const hasTime = hh !== undefined;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), hh ? Number(hh) : 0, mm ? Number(mm) : 0),
  );
  switch (unit) {
    case "d":
      date.setUTCDate(date.getUTCDate() + n);
      break;
    case "w":
      date.setUTCDate(date.getUTCDate() + n * 7);
      break;
    case "m":
      date.setUTCMonth(date.getUTCMonth() + n);
      break;
    case "y":
      date.setUTCFullYear(date.getUTCFullYear() + n);
      break;
  }
  const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return hasTime ? `${datePart} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : datePart;
}

/** The done timestamp reformatted as a `scheduled`/`deadline`-shaped basis for "from done" repeat
 * math, matching `targetHadTime` (the field being advanced keeps its own time-or-not shape). */
function doneAsBasis(doneIso: string, targetHadTime: boolean): string {
  const d = new Date(doneIso);
  const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return targetHadTime ? `${datePart} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : datePart;
}

/**
 * R35: the repeat-aware completion rule, shared by `task.cycle`'s DOING->DONE step,
 * `task.toggleDone`, and `task.setMarkerDone`. `nowMs` is injectable for tests.
 */
export function completeTask(snapshot: TaskSnapshot, nowMs: number = Date.now()): CompletionResult {
  const done = formatDoneTimestamp(nowMs);

  if (!snapshot.repeat) {
    return { marker: "DONE", done };
  }

  const m = REPEAT_RE.exec(snapshot.repeat);
  if (!m) {
    // Malformed `repeat` value: fail safe to the plain (non-repeating) completion rather than
    // silently dropping the task's due dates.
    return { marker: "DONE", done };
  }
  const n = Number(m[1]);
  const unit = m[2] as "d" | "w" | "m" | "y";
  const fromDone = snapshot.repeat.endsWith("from done");

  const result: CompletionResult = { marker: "TODO", done };
  if (snapshot.scheduled !== undefined) {
    const basis = fromDone
      ? doneAsBasis(done, snapshot.scheduled.includes(":"))
      : snapshot.scheduled;
    result.scheduled = addInterval(basis, n, unit);
  }
  if (snapshot.deadline !== undefined) {
    const basis = fromDone ? doneAsBasis(done, snapshot.deadline.includes(":")) : snapshot.deadline;
    result.deadline = addInterval(basis, n, unit);
  }
  return result;
}

/** R34: `null -> TODO -> DOING -> DONE -> null`, wrapping. Completion (the `DOING -> DONE` step)
 * is handled by the caller via `completeTask` — this function only returns the plain marker for
 * every other transition. */
export function nextCycleMarker(current: TaskMarker | null): TaskMarker | null {
  switch (current) {
    case null:
      return "TODO";
    case "TODO":
      return "DOING";
    case "DOING":
      return "DONE"; // caller must route this through completeTask() instead (R34).
    default:
      return null; // DONE, WAITING, CANCELED, LATER, NOW all wrap/exit to null on cycle.
  }
}
