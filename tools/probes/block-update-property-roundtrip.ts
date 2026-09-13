/**
 * B-172 probe: does `block.update`'s old_str/new_str path survive a block that carries a property
 * line? It renders the block's raw text with `renderSingleBlockText` and re-parses the edited text
 * with `parseSingleBlockGrammar` — the exact round trip `ops/block-update.ts` does.
 *
 * Run from packages/server (for its tsx and module resolution):
 *   pnpm exec tsx ../../tools/probes/block-update-property-roundtrip.ts
 *
 * Output on da85cfb: "ok" for a plain task; "FAIL ... content must describe exactly one block" for
 * a task with `scheduled::` and for two-line content. After the B-172 fix (2026-09-13, server-ops):
 * "ok" for all three.
 *
 * Found 2026-09-13 (impl-journal) when an e2e spec flipped `TODO` to `DONE` on a task with
 * `scheduled::` through the API and got 400 "content must describe exactly one block".
 */

import {
  parseSingleBlockGrammar,
  renderSingleBlockText,
} from "../../packages/server/src/ops/outline-bridge.js";

const cases = [
  { name: "plain task", content: "buy milk", properties: {} },
  { name: "task with scheduled::", content: "buy milk", properties: { scheduled: "2026-09-13" } },
  { name: "multi-line content", content: "buy milk\nand bread", properties: {} },
];

for (const c of cases) {
  const raw = renderSingleBlockText({
    content: c.content,
    marker: "TODO",
    priority: null,
    properties: c.properties,
    collapsed: false,
  });
  const edited = raw.replace("TODO", "DONE");
  try {
    const node = parseSingleBlockGrammar(edited, "flush");
    console.log(`ok    ${c.name}: ${JSON.stringify(raw)} -> marker ${node.marker}`);
  } catch (e) {
    console.log(`FAIL  ${c.name}: ${JSON.stringify(raw)} -> ${(e as Error).message}`);
  }
}
