/**
 * Probe for the M7 server/sync review's F8 (docs/review/2026-09-13-m7-rv-server-sync.md): how does
 * one `serverApplyOps` call scale with batch size? `recordChanges` looked each op's result up with
 * `results.find`, once per op — quadratic in the batch — and `graph.replace` allows 20,000 blocks
 * in one call. Times N `block.text` ops in one batch on an in-memory graph, and separately the
 * lookup shape alone (N finds over N results vs one Map), so machine load cannot hide the growth.
 *
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/apply-ops-batch-scaling.ts
 */

import { makeOp, newId } from "../../packages/core/src/index.ts";
import { createServerContext, serverApplyOps } from "../../packages/server/src/apply-ops.ts";
import { openDb } from "../../packages/server/src/db.ts";

const sizes = (process.argv[2] ?? "2000,8000,16000").split(",").map(Number);

for (const n of sizes) {
  const results = Array.from({ length: n }, (_, i) => ({ id: `op${i}`, status: "applied" }));
  let t0 = performance.now();
  for (let i = 0; i < n; i++) results.find((r) => r.id === `op${i}`);
  const findMs = performance.now() - t0;
  t0 = performance.now();
  const byId = new Map(results.map((r) => [r.id, r]));
  for (let i = 0; i < n; i++) byId.get(`op${i}`);
  const mapMs = performance.now() - t0;

  const ctx = createServerContext(openDb({ path: ":memory:" }));
  const page = newId();
  const ids = Array.from({ length: n }, () => newId());
  serverApplyOps(
    ctx,
    [
      makeOp(ctx.hlc.next(), "00000000", page, {
        kind: "page.create",
        name: "P",
        journalDay: null,
        createdAt: 1,
      }),
      ...ids.map((id, i) =>
        makeOp(ctx.hlc.next(), "00000000", id, {
          kind: "block.create",
          place: { pageId: page, parentId: null, order: `a${String(i).padStart(6, "0")}` },
          content: "hello",
          createdAt: 1,
        }),
      ),
    ],
    { origin: "import", actor: "probe" },
  );
  const ops = ids.map((id) =>
    makeOp(ctx.hlc.next(), "00000000", id, { kind: "block.text", content: "world" }),
  );
  t0 = performance.now();
  serverApplyOps(ctx, ops, { origin: "api", actor: "probe" });
  const applyMs = performance.now() - t0;
  console.log(
    `n=${n}: serverApplyOps ${Math.round(applyMs)} ms; lookup alone: find ${Math.round(findMs)} ms, Map ${Math.round(mapMs)} ms`,
  );
}
