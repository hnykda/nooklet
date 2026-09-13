/**
 * Settled for B-125 (2026-09-13, Node 26.8.1, macOS arm64): does `resourceLimits` on a
 * `worker_threads` Worker contain an out-of-memory to the worker?
 *
 *   node tools/probes/worker-heap-cap-abort.mjs many     -> "error event: ERR_WORKER_OUT_OF_MEMORY",
 *        the parent lives
 *   node tools/probes/worker-heap-cap-abort.mjs one      -> the WHOLE PROCESS aborts, exit 134:
 *        "FATAL ERROR: Reached heap limit Allocation failed" (after the worker had even posted
 *        its result)
 *   node tools/probes/worker-heap-cap-abort.mjs one-replace-only -> completes, exit 0
 *   node tools/probes/worker-heap-cap-abort.mjs length   -> "error event: RangeError Invalid
 *        string length", the parent lives
 *
 * Many small allocations are caught and end only the worker. The sequence graph.replace's scan
 * ran before 3d01f11 — count a 199,000-character block's matches, then replace each with 2,000
 * characters (~400 M characters) — leaves V8 at the cap with a last-resort GC that cannot free
 * enough, and it aborts the process rather than the worker. Whether it aborts depends on what
 * else is on the heap (the replace alone survives), which is exactly why a heap cap is no bound
 * to rely on. `graph.replace` now computes each block's replaced length before building it
 * (`packages/server/src/ops/replace-scan.ts`) and runs the worker without `resourceLimits`.
 */
import { Worker } from "node:worker_threads";

const cases = {
  many: `const keep = []; for (let i = 0; i < 1e6; i++) keep.push("x".repeat(1e5) + i);`,
  // What graph.replace's scan did before 3d01f11: count the matches, then replace through a
  // replacer function (literal text), keeping the result.
  one: `
    const re = /a/giu; const r = "x".repeat(2000); const content = "a".repeat(199000);
    let count = 0; for (const _ of content.matchAll(re)) count++;
    const after = content.replace(re, function () { return r; });
    require("node:worker_threads").parentPort.postMessage({ count, length: after.length });`,
  // The replace alone, without the preceding matchAll garbage.
  "one-replace-only": `"a".repeat(199000).replace(/a/giu, function () { return "x".repeat(2000); });`,
  length: `"a".repeat(300000).replace(/a/g, "x".repeat(2000));`,
};
const which = process.argv[2] ?? "many";
const w = new Worker(cases[which], {
  eval: true,
  resourceLimits: { maxOldGenerationSizeMb: which === "length" ? 4096 : 256 },
});
w.once("error", (e) => console.log("error event:", e?.code ?? e?.name, e?.message));
w.once("message", (m) => console.log("message:", m));
w.once("exit", (c) => console.log("worker exit", c, "- parent still alive"));
