/**
 * What the top bar's sync cloud (`./SyncIndicator.tsx`) shows, kept free of Solid and the DOM so
 * the one rule that matters here is unit-testable: **a routine push or pull changes nothing you
 * can see** (B-540). Every edit is pending for a few hundred milliseconds (the editor's ~500 ms
 * write debounce, then the sync client's 300 ms push debounce, then the round trip); showing that
 * turned the indicator into something that flickered on every keystroke pause.
 *
 * So there are two answers per moment: the TRUE view, which the tooltip and accessible name carry
 * (hovering during a push honestly says "1 change waiting to sync"), and the SHOWN view, which the
 * dot carries and which only moves to an attention state once that state has lasted
 * `ATTENTION_DELAY_MS`. Recovering (back to synced) shows at once — good news never waits.
 */

import type { SyncStatus } from "../sync/types.js";

export type SyncView =
  /** Before the worker has answered, or while a fresh replica is bootstrapping. No dot. */
  | "starting"
  | "synced"
  | "pending"
  | "offline"
  | "error"
  /** No local copy at all: OPFS was unavailable, the replica is in memory (B-43). */
  | "memory"
  /** Another tab of this graph holds the local copy (B-81). */
  | "follower";

/** Roughly how long a routine edit takes to reach the server, with margin. Below this, pending is
 * noise; above it, something is actually slow or stuck. */
export const ATTENTION_DELAY_MS = 2000;

/** The views that must persist for `ATTENTION_DELAY_MS` before the dot shows them. `memory` and
 * `follower` are facts about this session's storage, not transient, so they show at once. */
const WAITS: ReadonlySet<SyncView> = new Set<SyncView>(["pending", "offline", "error"]);

export function deriveSyncView(
  storage: "opfs" | "memory" | "follower" | undefined,
  status: SyncStatus | undefined,
): SyncView {
  // Storage first: "synced" would be true and still the wrong thing to say about a session whose
  // local copy evaporates on reload (B-43).
  if (storage === "memory") return "memory";
  if (storage === "follower") return "follower";
  if (!status || status.state === "bootstrapping") return "starting";
  if (status.state === "offline") return "offline";
  if (status.state === "error") return "error";
  if (status.pendingCount > 0) return "pending";
  return "synced";
}

/** The sentence behind the icon: its tooltip and its accessible name. */
export function syncLabel(view: SyncView, pendingCount: number): string {
  switch (view) {
    case "starting":
      return "Starting sync…";
    case "synced":
      return "Synced";
    case "pending":
      return `${pendingCount} ${pendingCount === 1 ? "change" : "changes"} waiting to sync`;
    case "offline":
      return "Offline — changes are kept and sent when back online";
    case "error":
      return "Sync stopped on an error — click for diagnostics";
    case "memory":
      return "Not saved locally — this browser can't keep a copy on this device";
    case "follower":
      return "Synced via another tab — that tab keeps the local copy";
  }
}

export interface QuietView {
  /** Feed every change of the true view. */
  update(next: SyncView): void;
  dispose(): void;
}

/**
 * The shown view, as a tiny state machine: `show` is called only when what the dot displays should
 * change. An attention state starts a timer rather than showing; any calm state in the meantime
 * cancels it. Once an attention state is showing, moving between attention states (pending →
 * offline) is immediate — the dot is already saying "look here".
 */
export function createQuietView(
  show: (view: SyncView) => void,
  opts: { initial?: SyncView; delayMs?: number } = {},
): QuietView {
  const delayMs = opts.delayMs ?? ATTENTION_DELAY_MS;
  let shown: SyncView = opts.initial ?? "starting";
  let latest: SyncView = shown;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const set = (view: SyncView) => {
    if (view === shown) return;
    shown = view;
    show(view);
  };

  return {
    update(next) {
      latest = next;
      if (!WAITS.has(next) || WAITS.has(shown)) {
        clear();
        set(next);
        return;
      }
      // Not restarted on every update: "pending (1)" becoming "pending (2)" is the same wait.
      timer ??= setTimeout(() => {
        timer = undefined;
        set(latest);
      }, delayMs);
    },
    dispose: clear,
  };
}
