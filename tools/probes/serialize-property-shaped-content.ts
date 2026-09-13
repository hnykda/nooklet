/**
 * Probe (2026-09-13, qafix-m8-editor, B-342): does a block whose CONTENT has a line shaped like a
 * property survive `serializeOutline` → `parseOutline` (the markdown mirror, `page.read` text, a
 * re-import) as content?
 *
 * Run: `pnpm exec tsx tools/probes/serialize-property-shaped-content.ts` from the repo root.
 *
 * Result when written: NO, for every shape tried. The serializer writes content lines verbatim and
 * the parser reads them back by line shape, so `scheduled:: 2026-09-20` (typed into the buffer,
 * kept as text by OUT-22a) comes back as a real scheduled date, `SCHEDULED: <…>` too (OUT-23 rule
 * 5), and a generic `foo:: bar` line as a property.
 *
 * Result after the fix (2026-09-13, mirror-escape, OUT-23a: a backslash before the colon that makes
 * the shape, one fewer on read): lossless=true for every line below, after line 1 of a task and as
 * line 1 of a plain block, with and without an id. "lossless" now compares the whole block
 * (content, marker, properties, id), not only the content. Run against the base code (52e5d20,
 * `git show` of `outline.ts` into a temp file) the added shapes were lossless=false too — a
 * `:LOGBOOK:` line also took the line after it — except the two lines that already carry a
 * backslash (no shape to the old parser) and, by luck, a `SCHEDULED:`/`DEADLINE:`/`:LOGBOOK:` line
 * 1 with an id suffix after it, which the parser's `$`-anchored regexes do not match:
 * lossless=false (27 of 36) before, 0 of 36 after.
 */
import type { OutlineNode } from "../../packages/core/src/model.js";
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";

const lines = [
  "scheduled:: 2026-09-20",
  "deadline:: 2026-10-01",
  "SCHEDULED: <2026-09-20 Sun>",
  "foo:: bar",
  "marker:: DONE",
  // added by mirror-escape
  "  DEADLINE: <2026-10-01 Thu 14:00 +1w>",
  "collapsed:: true",
  "id:: 64f1a2b3-0000-4000-8000-000000000001",
  "heading:: 2",
  ":LOGBOOK:",
  "foo\\:: already escaped once",
  "SCHEDULED\\\\: <2026-09-20>",
];
const block = (over: Partial<OutlineNode>): OutlineNode => ({
  content: "",
  marker: null,
  priority: null,
  properties: {},
  collapsed: false,
  children: [],
  ...over,
});
const check = (label: string, node: OutlineNode, ids: boolean) => {
  const page = { properties: {}, blocks: [node] };
  const text = serializeOutline(page, ids ? {} : { ids: "none" });
  const back = parseOutline(text).blocks;
  const lossless = JSON.stringify(back) === JSON.stringify([node]);
  console.log(
    `${label}: serialized ${JSON.stringify(text)} -> content ${JSON.stringify(back[0]?.content)}, properties ${JSON.stringify(back[0]?.properties)}, lossless=${lossless}`,
  );
};
for (const line of lines) {
  check(
    JSON.stringify(line),
    block({ content: `call mom\n${line}\nafter`, marker: "TODO" }),
    false,
  );
}
for (const line of lines) {
  check(`line 1 ${JSON.stringify(line)}`, block({ content: line }), false);
  check(
    `line 1 + id ${JSON.stringify(line)}`,
    block({ content: line, id: "1k7f3q9xz2hav4" }),
    true,
  );
}
