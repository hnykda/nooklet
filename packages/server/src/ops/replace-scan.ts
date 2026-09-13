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
 * on the owner's graph to answer 413. Now each block's replaced length is computed from its
 * matches BEFORE the string is built, and a block that would pass the content cap is refused
 * unbuilt; held text stops the moment the op is bound to be refused (`too_many_blocks` still
 * counts, for the error's details); and the call stops outright past an output budget.
 *
 * Why not simply cap the worker's heap (`resourceLimits`): tried, and it is worse. A single
 * allocation larger than the cap — one 200,000-character block times a 2,000-character
 * replacement — does not end the worker with `ERR_WORKER_OUT_OF_MEMORY`; V8 aborts the whole
 * process ("Reached heap limit", exit 134). A cap would also abort the server on a graph whose
 * text alone outgrew it. The limits have to be in the algorithm.
 */

import { Worker } from "node:worker_threads";

/** How long a scan may run before the worker is terminated and the op refused. */
export const SCAN_BUDGET_MS = 2000;

/** The same cap `block.update` puts on a block's content. */
export const MAX_BLOCK_CHARS = 100_000;

/** Replaced text the scan will hold for one call: ~7× the text of the owner's whole graph
 * (2.9 M characters), ~40 MB as UTF-16, and cloned once more into the main thread. */
export const MAX_OUTPUT_CHARS = 20_000_000;

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

// `templateParts`/`substitutedLength` follow ECMA-262 GetSubstitution: `$$`, `$&`, `` $` ``,
// `$'`, `$n`/`$nn` (a two-digit index past the capture count is one digit plus a literal digit;
// `$0`, `$00` and indices past the count stay literal), `$<name>` (literal "$<" when the regex
// has no named groups or there is no `>`), anything else literal. The worker checks every built
// string against the computed length and throws on a mismatch, so a gap here fails loudly.
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function isDigit(c) { return c !== undefined && c >= "0" && c <= "9"; }

/** The template as literal lengths (numbers) and references ("&", "\`", "'", "g<n>", "n<name>"). */
function templateParts(t, captureCount, hasNamed) {
  const parts = [];
  let lit = 0;
  const ref = (p) => { parts.push(lit, p); lit = 0; };
  for (let i = 0; i < t.length; ) {
    const c = t[i + 1];
    if (t[i] !== "$" || c === undefined) { lit++; i++; continue; }
    if (c === "$") { lit++; i += 2; continue; }
    if (c === "&" || c === "\`" || c === "'") { ref(c); i += 2; continue; }
    if (isDigit(c)) {
      let digits = isDigit(t[i + 2]) ? 2 : 1;
      let index = Number(t.slice(i + 1, i + 1 + digits));
      if (digits === 2 && index > captureCount) { digits = 1; index = Number(c); }
      if (index >= 1 && index <= captureCount) ref("g" + index);
      else lit += 1 + digits;
      i += 1 + digits;
      continue;
    }
    if (c === "<") {
      const gt = t.indexOf(">", i + 2);
      if (gt === -1 || !hasNamed) { lit += 2; i += 2; continue; }
      ref("n" + t.slice(i + 2, gt));
      i = gt + 1;
      continue;
    }
    lit++;
    i++;
  }
  parts.push(lit);
  return parts;
}

function substitutedLength(parts, m, str) {
  let len = 0;
  for (const p of parts) {
    if (typeof p === "number") len += p;
    else if (p === "&") len += m[0].length;
    else if (p === "\`") len += m.index;
    else if (p === "'") len += Math.max(0, str.length - (m.index + m[0].length));
    else {
      const v = p[0] === "g" ? m[Number(p.slice(1))] : m.groups[p.slice(1)];
      if (v !== undefined) len += String(v).length;
    }
  }
  return len;
}

function scan({ contents, source, flags, replacement, literalReplacement, limits }) {
  const re = new RegExp(source, flags);
  // Capture count and named groups, from a match that always succeeds.
  const probe = new RegExp(source + "|", flags.replace("g", "")).exec("");
  const parts = literalReplacement ? null : templateParts(replacement, probe.length - 1, probe.groups !== undefined);
  const replacer = literalReplacement ? function () { return replacement; } : replacement;
  let hits = [];
  let blocksMatched = 0;
  let occurrences = 0;
  let outputChars = 0;
  for (let index = 0; index < contents.length; index++) {
    const content = contents[index];
    let count = 0;
    let length = content.length;
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      count++;
      length += (parts === null ? replacement.length : substitutedLength(parts, m, content)) - m[0].length;
    }
    if (count === 0) continue;
    // Decided before the string exists. An already-oversized block may still be edited, as long
    // as the edit does not grow it.
    if (length > limits.maxBlockChars && length > content.length) {
      return { kind: "block_too_long", index, length, maxBlockChars: limits.maxBlockChars };
    }
    const after = content.replace(re, replacer);
    if (after.length !== length) {
      throw new Error("replace scan computed " + length + " characters but built " + after.length);
    }
    if (after === content) continue;
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
