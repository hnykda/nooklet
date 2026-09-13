/**
 * Probe (2026-09-13, impl-render, B-151): does a block whose content OPENS with a code fence keep
 * its properties through `serializeOutline(…, { ids: "none" })` → `parseOutline`?
 *
 * Run: `pnpm exec tsx tools/probes/serialize-fence-props.ts` from the repo root.
 *
 * Result when written: NO. Without an id the serializer writes the property lines right after
 * line 1 — which is the fence opener — so they land inside the fence and re-parse as code. With an
 * id (the mirror's default) OUT-14 puts `^id` alone on line 1 and the round trip holds, which is
 * why the mirror never showed it. `ids: "none"` callers: `block.copySelection` (Cmd+C on selected
 * blocks) and the server's `renderSingleBlockText` (`block.update`'s before-text).
 *
 * After the B-151 fix (2026-09-13, server-ops): YES for both — `ids=none` now writes
 * `- ```js\n  code\n  ```\n  foo:: bar\n`.
 */
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";

const page = parseOutline("- ```js\n  code\n  ```\n  foo:: bar\n");
for (const ids of ["none", "present"] as const) {
  const withId = { ...page, blocks: page.blocks.map((b) => ({ ...b, id: "1k7f3q9xz2hav4" })) };
  const out = serializeOutline(ids === "none" ? page : withId, { ids });
  const again = parseOutline(out).blocks[0];
  console.log(
    `ids=${ids}: serialized ${JSON.stringify(out)} -> properties ${JSON.stringify(again?.properties)}`,
  );
}
