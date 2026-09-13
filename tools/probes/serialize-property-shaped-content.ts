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
 */
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";

const lines = [
  "scheduled:: 2026-09-20",
  "deadline:: 2026-10-01",
  "SCHEDULED: <2026-09-20 Sun>",
  "foo:: bar",
  "marker:: DONE",
];
for (const line of lines) {
  const content = `call mom\n${line}`;
  const page = parseOutline("- call mom\n");
  const block = page.blocks[0];
  if (!block) throw new Error("no block");
  const edited = { ...page, blocks: [{ ...block, content, marker: "TODO" as const }] };
  const text = serializeOutline(edited, { ids: "none" });
  const back = parseOutline(text).blocks[0];
  console.log(
    `${JSON.stringify(line)}: serialized ${JSON.stringify(text)} -> content ${JSON.stringify(back?.content)}, properties ${JSON.stringify(back?.properties)}, lossless=${back?.content === content}`,
  );
}
