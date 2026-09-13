/**
 * `graph.replace`'s scan — match and replace over every candidate block — run in a
 * `worker_threads` Worker with a time budget and memory limits, never on the event loop (B-125).
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
 *
 * Memory: the scan used to build the replaced text of EVERY matching block and only then compare
 * the count with `max_blocks` — a one-letter query with a 2,000-character replacement built ~1 GB
 * on the owner's graph to answer 413. Now it stops holding text the moment the op is bound to be
 * refused (`too_many_blocks` still counts, for the error's details), stops outright past an output
 * budget, and the worker's heap is capped so a single block's explosion kills the worker, not the
 * server.
 */

import { Worker } from "node:worker_threads";

/** How long a scan may run before the worker is terminated and the op refused. */
export const SCAN_BUDGET_MS = 2000;

/** The same cap `block.update` puts on a block's content. */
export const MAX_BLOCK_CHARS = 100_000;

/** Replaced text the scan will hold for one call: ~7× the text of the owner's whole graph
 * (2.9 M characters), ~40 MB as UTF-16, and cloned once more into the main thread. */
export const MAX_OUTPUT_CHARS = 20_000_000;

/** Old-generation heap for the worker. Large strings count against it, so a replacement that
 * multiplies one block into hundreds of megabytes ends the worker (`ERR_WORKER_OUT_OF_MEMORY`). */
const WORKER_HEAP_MB = 256;

export interface ScanLimits {
  /** Past this many changed blocks the op will be refused; stop holding replaced text. */
  maxBlocks: number;
  /** Refuse a block whose text the replacement grows past this. */
  maxBlockChars: number;
  /** Refuse once the replaced text held for the whole call passes this. */
  maxOutputChars: number;
}

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
  limits: ScanLimits;
}

export interface ScanHit {
  /** Index into `ScanRequest.contents`. */
  index: number;
  after: string;
  /** Occurrences in this block. */
  count: number;
}

export type ScanResult =
  | { kind: "ok"; hits: ScanHit[]; occurrences: number }
  | { kind: "too_many_blocks"; blocksMatched: number; occurrences: number }
  | { kind: "block_too_long"; index: number; length: number; maxBlockChars: number }
  | { kind: "output_too_large"; maxOutputChars: number };

/** The scan did not finish inside its budget; the worker was terminated. */
export class ScanTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`scan exceeded ${budgetMs} ms`);
  }
}

/** The replacement produced a string past V8's length limit or the worker's heap. */
export class ScanMemoryError extends Error {}

const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function scan({ contents, source, flags, replacement, literalReplacement, limits }) {
  const re = new RegExp(source, flags);
  const replacer = literalReplacement ? function () { return replacement; } : replacement;
  let hits = [];
  let blocksMatched = 0;
  let occurrences = 0;
  let outputChars = 0;
  for (let index = 0; index < contents.length; index++) {
    const content = contents[index];
    let count = 0;
    re.lastIndex = 0;
    for (const _ of content.matchAll(re)) count++;
    if (count === 0) continue;
    const after = content.replace(re, replacer);
    if (after === content) continue;
    // An already-oversized block may still be edited, as long as the edit does not grow it.
    if (after.length > limits.maxBlockChars && after.length > content.length) {
      return { kind: "block_too_long", index, length: after.length, maxBlockChars: limits.maxBlockChars };
    }
    blocksMatched++;
    occurrences += count;
    if (blocksMatched > limits.maxBlocks) {
      hits = null;
      continue;
    }
    outputChars += after.length;
    if (outputChars > limits.maxOutputChars) {
      return { kind: "output_too_large", maxOutputChars: limits.maxOutputChars };
    }
    hits.push({ index, after, count });
  }
  return hits === null
    ? { kind: "too_many_blocks", blocksMatched, occurrences }
    : { kind: "ok", hits, occurrences };
}

parentPort.postMessage(scan(workerData));
`;

/**
 * Runs the scan in a fresh worker. Rejects with `ScanTimeoutError` when it takes longer than
 * `budgetMs` (the worker is terminated, which stops a backtracking match mid-run), with
 * `ScanMemoryError` when a replacement is too big to build, or with the worker's own error.
 */
export function runScan(req: ScanRequest, budgetMs: number = SCAN_BUDGET_MS): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: req,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
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
    worker.once("error", (err: Error & { code?: string }) =>
      settle(() =>
        reject(
          err.code === "ERR_WORKER_OUT_OF_MEMORY" ||
            (err.name === "RangeError" && err.message.includes("Invalid string length"))
            ? new ScanMemoryError(err.message)
            : err,
        ),
      ),
    );
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`replace scan worker exited early (code ${code})`))),
    );
  });
}
