/**
 * Probe (2026-09-13, server-ops, B-310): does a TASK block whose content opens with a code fence
 * survive `serializeOutline` → `parseOutline`, with and without ids?
 *
 * Run from packages/server (for its tsx and module resolution):
 *   pnpm exec tsx ../../tools/probes/fence-first-task-roundtrip.ts
 *
 * Before the fix: ids=present came back with marker null; ids=none with content "```js" and two
 * children. After (core-ops, 2026-09-13): both come back as written — marker TODO, the whole fence,
 * properties {foo: bar}, one child.
 */
import type { OutlineNode } from "../../packages/core/src/model.js";
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";

const node: OutlineNode = {
  id: "1k7f3q9xz2hav4",
  content: "```js\n- not a bullet\n```",
  marker: "TODO",
  priority: null,
  properties: { foo: "bar" },
  collapsed: false,
  children: [
    {
      id: "1k7f3q9xz2hav5",
      content: "child",
      marker: null,
      priority: null,
      properties: {},
      collapsed: false,
      children: [],
    },
  ],
};
for (const ids of ["present", "none"] as const) {
  const out = serializeOutline({ properties: {}, blocks: [node] }, { ids });
  const back = parseOutline(out).blocks;
  console.log(`ids=${ids}: ${JSON.stringify(out)}`);
  console.log(
    `  -> ${back.length} top block(s); marker ${back[0]?.marker}; content ${JSON.stringify(back[0]?.content)}; properties ${JSON.stringify(back[0]?.properties)}; children ${back[0]?.children.length}`,
  );
}
