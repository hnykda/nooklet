/**
 * B-652 probe (2026-10-04, b652 agent): what `merge3` (core's word-token diff3) does with the
 * texts of the random-schedule seed that still made a spurious conflict copy (merge mode,
 * seed 11 in `apps/web/src/sync/e2e.test.ts`): device C's text is "w0 B1 C0" (it merged B's two
 * edits), and A's merge "A1 B0 w2" arrives — A merged B's FIRST edit, never saw the second.
 *
 * Which base gives the right answer ("A1 B1 C0"), and which one silently reverts B1?
 *
 * Run from packages/core:  pnpm exec tsx ../../tools/probes/b652-merge-base.ts
 */
import { merge3 } from "../../packages/core/src/sync/text-merge.js";

const mine = "w0 B1 C0";
const theirs = "A1 B0 w2";
for (const [label, base] of [
  ["orig (before anyone diverged)", "w0 w1 w2"],
  ["B's second edit", "w0 B1 w2"],
  ["B's first edit (what A actually merged)", "w0 B0 w2"],
] as const) {
  console.log(label.padEnd(42), JSON.stringify(merge3(base, mine, theirs)));
}
