/**
 * `graph.replace`'s scan — match and replace over every candidate block — run in a
 * `worker_threads` Worker with a time budget, never on the event loop (B-125).
 *
 * Why a worker: the server is one Node process on one thread. A user regex with nested
 * quantifiers (`(a+)+$`, `(\w+\s?)+:`) backtracks exponentially on ordinary text, and V8 cannot
 * interrupt a running match from the same thread, so a scan on the event loop froze `/healthz`,
 * `/sync`, the web client and MCP until the process was killed. A worker can be terminated.
 *
 * Why literal queries go through it too: it costs ~20 ms on the owner's 18.6k-block graph (16 ms
 * of that is spawning the worker; inline was ~2.5 ms), and one implementation keeps "the preview
 * IS the op" true without a second copy of the loop to keep in step.
 *
 * Why the worker body is a JavaScript string rather than a TS function's `toString()`: tsx's
 * esbuild transform injects `__name(...)` helpers into inner functions and classes, which would
 * be a ReferenceError inside the worker in dev only; and a separate worker FILE would not survive
 * the desktop sidecar, which esbuild-bundles the whole server into one `server.mjs`. An eval'd
 * string runs the same everywhere. Keep it small and self-contained.
 */

import { Worker } from "node:worker_threads";

/** How long a scan may run before the worker is terminated and the op refused. */
export const SCAN_BUDGET_MS = 2000;

export interface ScanRequest {
  /** Block texts, in the order the caller wants hits reported in. */
  contents: string[];
  /** `RegExp` source and flags, already validated by `compileQuery`. */
  source: string;
  flags: string;
  replacement: string;
  /** Use `replacement` verbatim: `String.replace` would read `$&`/`$1` in a replacement string,
   * which someone typing "$5" as new text does not mean. */
  literalReplacement: boolean;
}

export interface ScanHit {
  /** Index into `ScanRequest.contents`. */
  index: number;
  after: string;
  /** Occurrences in this block. */
  count: number;
}

export interface ScanResult {
  hits: ScanHit[];
  occurrences: number;
}

/** The scan did not finish inside its budget; the worker was terminated. */
export class ScanTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`scan exceeded ${budgetMs} ms`);
  }
}

const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { contents, source, flags, replacement, literalReplacement } = workerData;
const re = new RegExp(source, flags);
const replacer = literalReplacement ? function () { return replacement; } : replacement;
const hits = [];
let occurrences = 0;
for (let index = 0; index < contents.length; index++) {
  const content = contents[index];
  let count = 0;
  re.lastIndex = 0;
  for (const _ of content.matchAll(re)) count++;
  if (count === 0) continue;
  const after = content.replace(re, replacer);
  if (after === content) continue;
  hits.push({ index, after, count });
  occurrences += count;
}
parentPort.postMessage({ hits, occurrences });
`;

/**
 * Runs the scan in a fresh worker. Rejects with `ScanTimeoutError` when it takes longer than
 * `budgetMs` (the worker is terminated, which stops a backtracking match mid-run), or with the
 * worker's own error.
 */
export function runScan(req: ScanRequest, budgetMs: number = SCAN_BUDGET_MS): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: req });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new ScanTimeoutError(budgetMs))), budgetMs);
    worker.once("message", (result: ScanResult) => settle(() => resolve(result)));
    worker.once("error", (err) => settle(() => reject(err)));
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`replace scan worker exited early (code ${code})`))),
    );
  });
}
