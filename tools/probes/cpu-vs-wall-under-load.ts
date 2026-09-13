/**
 * Probe (2026-09-13, m10/tests-desktop, B-333): does a CPU-time measurement of the tokenizer
 * benchmark stay put when the machine is loaded, where wall-clock time does not?
 *
 * `packages/core/src/tokens.test.ts` "stays far away from quadratic" timed 20,000 `tokenizeContent`
 * calls with `performance.now()` against a 500 ms budget; ~30-40 ms idle, 1,488 ms at load average
 * 62-84 (B-333). This runs the same work, and a deliberately quadratic variant of it (every call
 * also rescans every earlier block — the shape an accidentally growing cache would have), and
 * prints wall and process CPU time (`process.cpuUsage()`, user + system) for each.
 *
 * Run (repo root): pnpm exec tsx tools/probes/cpu-vs-wall-under-load.ts
 * Under load: start busy node loops first (`node -e 'for(;;){}'`, several per core), and run this
 * under `nice -n 20` so the loops win the scheduler, then kill them.
 */
import { tokenizeContent } from "../../packages/core/src/tokens.js";

const templates = [
  "Plain text block with a [[Wikilink Target]] and a #tag mid-sentence.",
  "A **bold** claim, an *em* aside, and a `code span` for good measure.",
  "See ((1k7f3q9xz2hav4)) and {{embed [[Some Page]]}} plus a [link](https://example.com/x).",
  "Price is $5 not math, but $E=mc^2$ genuinely is, #namespace/tag too.",
  "Multi\nline\nparagraph\nwith several hard breaks and a #tag on the third #line.",
  "~~gone~~ and ==kept== and _emphasis_ and normal_snake_case_var untouched.",
  "![alt](assets/1k7f3q9xz2hav9.png) plus checkbox [ ] and [x] done markers.",
];

function measure(fn: () => void): { wallMs: number; cpuMs: number } {
  const wall0 = performance.now();
  const cpu0 = process.cpuUsage();
  fn();
  const cpu = process.cpuUsage(cpu0);
  return {
    wallMs: Math.round(performance.now() - wall0),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  };
}

function linear(n: number): void {
  for (let i = 0; i < n; i++) tokenizeContent(templates[i % templates.length] as string);
}

function quadratic(n: number): void {
  let seen = 0;
  for (let i = 0; i < n; i++) {
    tokenizeContent(templates[i % templates.length] as string);
    // An O(i) step per call: n²/2 string reads in total.
    for (let j = 0; j < i; j++) seen += (templates[j % templates.length] as string).length;
  }
  if (seen < 0) throw new Error("unreachable");
}

/** CPU ms for 4n calls over CPU ms for n calls, each the minimum of three runs: ~4 when the work
 * is linear in the number of calls, ~16 when it is quadratic. */
function scaling(fn: (n: number) => void, n: number): number {
  const best = (k: number) => Math.min(...[0, 1, 2].map(() => measure(() => fn(k)).cpuMs || 1));
  return Math.round((best(4 * n) / best(n)) * 10) / 10;
}

for (let trial = 0; trial < 5; trial++) {
  console.log(
    JSON.stringify({
      trial,
      linear20k: measure(() => linear(20_000)),
      quadratic20k: measure(() => quadratic(20_000)),
      linearScaling: scaling(linear, 20_000),
      quadraticScaling: scaling(quadratic, 5_000),
    }),
  );
}
