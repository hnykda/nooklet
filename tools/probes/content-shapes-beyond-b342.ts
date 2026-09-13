/**
 * Probe (2026-09-13, mirror-escape): after B-342's escape (OUT-23a), which OTHER block texts still
 * do not survive being written as outline text and read back — the markdown mirror, `page_read`,
 * copy and paste — or being edited in the app?
 *
 * Run: `pnpm exec tsx tools/probes/content-shapes-beyond-b342.ts` from the repo root.
 *
 * Result when written (outline.ts at 49431ac):
 *  - B-470: a later line of text shaped like a bullet (`- x`, `* x`, `+ x`, `1. x`, a bare `-`)
 *    comes back as a CHILD BLOCK (a `1. ` one with `list:: number`), its text gone from the block.
 *  - B-471: a text whose line 1 starts with a task-marker word or a priority (`TODO x`, `LATER x`,
 *    `[#A] x`) on a block with no marker comes back as a task / with a priority.
 *  - B-472: a text line `foo:: bar` (a non-reserved key) — which OUT-23a now writes as text, and
 *    which an agent can write escaped — becomes a real property the first time the block is edited
 *    in the app: `blockTextPayloads` splits it out of the buffer (OUT-22a), on any keystroke.
 * Every other shape tried is lossless. Owner's graph copy: 0 blocks of the B-470/B-471 shapes
 * (`mirror-roundtrip-graph.ts` reads all 953 pages back exactly), so these are about new text.
 */
import { blockTextPayloads, joinBlockText } from "../../packages/core/src/block-text.js";
import type { OutlineNode } from "../../packages/core/src/model.js";
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";

const block = (content: string): OutlineNode => ({
  content,
  marker: null,
  priority: null,
  properties: {},
  collapsed: false,
  children: [],
});

const outlineShapes = [
  "a\n- dash",
  "a\n-",
  "a\n* star",
  "a\n+ plus",
  "a\n1. first\n2. second",
  "TODO not a task",
  "LATER not a task",
  "[#A] not a priority",
  // controls: not expected to lose anything
  "a\n-- double dash",
  "a\n1.5 kg",
  "TODOS are words",
  "a\nfoo:: bar",
];
for (const content of outlineShapes) {
  const page = { properties: {}, blocks: [block("before"), block(content)] };
  for (const ids of ["none", "present"] as const) {
    const withIds =
      ids === "none"
        ? page
        : { ...page, blocks: page.blocks.map((b, i) => ({ ...b, id: `1k7f3q9xz2hav${i}` })) };
    const text = serializeOutline(withIds, { ids });
    const back = parseOutline(text).blocks;
    const lossless = JSON.stringify(back) === JSON.stringify(withIds.blocks);
    console.log(
      `outline ids=${ids} ${JSON.stringify(content)}: ${JSON.stringify(text)} -> lossless=${lossless}${lossless ? "" : ` got ${JSON.stringify(back.slice(1))}`}`,
    );
  }
}

// B-472: the editor's buffer for a block whose TEXT has a `foo:: bar` line, after one keystroke.
for (const content of ["note\nfoo:: bar", "note\nscheduled:: 2026-09-20"]) {
  const before = { content, properties: {} };
  const buffer = joinBlockText(content, {});
  const typed = buffer.replace("note", "notes");
  console.log(
    `editor ${JSON.stringify(content)}: buffer ${JSON.stringify(buffer)}, one keystroke writes ${JSON.stringify(blockTextPayloads(before, typed))}`,
  );
}
