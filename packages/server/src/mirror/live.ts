/**
 * The mirror that `nooklet serve` keeps up to date — the "continuous" half of ADR 002 that never
 * existed (B-95). Until now only `nooklet export` wrote `pages/` and `journals/`; the README's
 * "greppable copy you can walk away with" was true only for people who ran a command nobody told
 * them about.
 *
 * Shape: subscribe to commits (`sync/realtime.ts#onCommit`, the same bus that pokes connected
 * clients), and after a short quiet period export the pages that the `changes` rows since the
 * previous sweep touched (`exportAll(…, { sinceSeq })`), pruning deleted ones on the way.
 *
 * The first sweep after start renders every live page instead. It catches up whatever happened
 * while the server was not running (`mcp --stdio` and `import` write the database directly), and
 * it repairs a mirror that an older build left stale (B-260). Measured on a copy of the real graph
 * (952 pages): ~200 ms cold, ~85 ms warm when nothing needs writing — once per start.
 *
 * The cursor is a `changes.seq`, not a timestamp. The first version compared `updated_at` with
 * `mirror_file.written_at`, and only `block.text` moves `updated_at`, so renames, properties,
 * markers, indents and moves never reached the file (B-260). A seq also cannot lose a commit that
 * lands in the same millisecond as the sweep before it. Reading the head and exporting happen in
 * one synchronous turn, so no commit can slip between them.
 *
 * Failures are logged, never thrown: the mirror is a projection, and a full disk or a permission
 * error on it must not take down the server that owns the source of truth.
 */

import type { ServerContext } from "../apply-ops.js";
import { onCommit } from "../sync/realtime.js";
import { changesHead, exportAll } from "./export.js";

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
  /** `changes.seq` the last successful sweep covered; `undefined` until the full first sweep ran. */
  let cursor: number | undefined;

  const sweep = (): void => {
    timer = undefined;
    if (stopped) return;
    try {
      const head = changesHead(ctx.driver);
      const r = exportAll(ctx.driver, dataDir, cursor === undefined ? {} : { sinceSeq: cursor });
      // Only after success: a sweep that threw part-way (full disk) is retried from the same
      // cursor on the next commit rather than forgetting the pages it did not get to.
      cursor = head;
      if (r.exported + r.deleted > 0) {
        log(`mirror: wrote ${r.exported} page file(s), removed ${r.deleted}`);
      }
      if (r.failed.length > 0) {
        const first = r.failed[0] as { pageId: string; error: string };
        log(
          `mirror: could not write ${r.failed.length} page file(s), will retry after the next ` +
            `commit (page ${first.pageId}: ${first.error})`,
        );
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
