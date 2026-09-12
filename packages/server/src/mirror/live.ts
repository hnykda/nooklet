/**
 * The mirror that `nooklet serve` keeps up to date — the "continuous" half of ADR 002 that never
 * existed (B-95). Until now only `nooklet export` wrote `pages/` and `journals/`; the README's
 * "greppable copy you can walk away with" was true only for people who ran a command nobody told
 * them about.
 *
 * Shape: subscribe to commits (`sync/realtime.ts#onCommit`, the same bus that pokes connected
 * clients), and after a short quiet period run `exportAll(…, { onlyChanged: true })` — the tested
 * path that already knows how to write changed pages, move renamed ones and prune deleted ones.
 * Per-page exports keyed off `changes` rows would be cheaper per commit and were considered; they
 * would also have to reproduce `exportAll`'s deletion handling, and the whole-graph "only changed"
 * scan is a single indexed query over `page` joined to `mirror_file`, which on the 952-page real
 * graph is well under the debounce. One sweep on start catches up whatever happened while the
 * server was not running.
 *
 * Failures are logged, never thrown: the mirror is a projection, and a full disk or a permission
 * error on it must not take down the server that owns the source of truth.
 */

import type { ServerContext } from "../apply-ops.js";
import { onCommit } from "../sync/realtime.js";
import { exportAll } from "./export.js";

export interface LiveMirrorOptions {
  /** Quiet period after the last commit before writing. 500 ms matches the editor's own text
   * flush, so a burst of keystrokes becomes one write per page rather than one per op. */
  debounceMs?: number;
  log?: (message: string) => void;
}

export interface LiveMirror {
  /** Write now, ignoring the debounce; resolves when the sweep is done. Tests and shutdown. */
  flush(): void;
  stop(): void;
}

export function startLiveMirror(
  ctx: ServerContext,
  dataDir: string,
  opts: LiveMirrorOptions = {},
): LiveMirror {
  const debounceMs = opts.debounceMs ?? 500;
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sweep = (): void => {
    timer = undefined;
    if (stopped) return;
    try {
      const r = exportAll(ctx.driver, dataDir, { onlyChanged: true });
      if (r.exported + r.deleted > 0) {
        log(`mirror: wrote ${r.exported} page file(s), removed ${r.deleted}`);
      }
    } catch (err) {
      log(`mirror: export failed (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(sweep, debounceMs);
  };

  const unsubscribe = onCommit(ctx, schedule);
  // Catch up on anything written while the server was down (or before this existed).
  schedule();

  return {
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      sweep();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    },
  };
}
