/**
 * Multi-window resolution (ADR 015 §2), exactly as the research/ADR specify: 0 live windows is a
 * normal non-error state everywhere; exactly 1 is used automatically; >1 is resolved differently
 * for reads (best-effort, always disclosing the alternatives) vs. writes (refuse to guess).
 */

import type { SqlDriver } from "@nooklet/core";
import {
  findWindowById,
  type LiveWindowRecord,
  listWindows,
  mostRecentlyActive,
} from "./registry.js";

export type ResolvedBy = "only_window" | "most_recently_active" | "requested";

export type ReadResolution =
  | { kind: "none" }
  | { kind: "not_found" }
  | {
      kind: "resolved";
      window: LiveWindowRecord;
      resolvedBy: ResolvedBy;
      others: LiveWindowRecord[];
    };

/**
 * `ui_state`/`ui_windows`' policy: default to the most-recently-active window and always
 * return the other candidates alongside — a read has no cost to guessing wrong once, so it is
 * never blocked on disambiguation.
 */
export function resolveForRead(driver: SqlDriver, windowId?: string): ReadResolution {
  if (windowId !== undefined) {
    const w = findWindowById(driver, windowId);
    return w
      ? { kind: "resolved", window: w, resolvedBy: "requested", others: [] }
      : { kind: "not_found" };
  }
  const all = listWindows(driver);
  if (all.length === 0) return { kind: "none" };
  if (all.length === 1) {
    const only = all[0] as LiveWindowRecord;
    return { kind: "resolved", window: only, resolvedBy: "only_window", others: [] };
  }
  const recent = mostRecentlyActive(driver) as LiveWindowRecord;
  return {
    kind: "resolved",
    window: recent,
    resolvedBy: "most_recently_active",
    others: all.filter((w) => w !== recent),
  };
}

export type WriteResolution =
  | { kind: "none" }
  | { kind: "not_found" }
  | { kind: "ambiguous"; windows: LiveWindowRecord[] }
  | { kind: "resolved"; window: LiveWindowRecord };

/**
 * `ui_run`/`ui_navigate`/`ui_highlight`'s stricter policy: with `window_id` omitted and
 * more than one live window, refuse to guess (`ambiguous_window`-shaped result, see
 * `../live/run-remote-command.ts`) rather than acting on the wrong screen.
 */
export function resolveForWrite(driver: SqlDriver, windowId?: string): WriteResolution {
  if (windowId !== undefined) {
    const w = findWindowById(driver, windowId);
    return w ? { kind: "resolved", window: w } : { kind: "not_found" };
  }
  const all = listWindows(driver);
  if (all.length === 0) return { kind: "none" };
  if (all.length === 1) return { kind: "resolved", window: all[0] as LiveWindowRecord };
  return { kind: "ambiguous", windows: all };
}
