/**
 * Probe for B-120/B-121 (docs/review/2026-09-13-m7-rv-server-sync.md): does the server's subtree
 * page repair keep a real graph's biggest subtree whole — tombstoned descendants included — when a
 * device moves its root to another page and then a later device op moves it back? And what does
 * the repair cost on that subtree?
 *
 * Run against a COPY of a graph (it writes):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '/tmp/x/graph.sqlite'"
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/subtree-page-repair-real-graph.ts /tmp/x/graph.sqlite
 */

import { Hlc, makeOp } from "../../packages/core/src/index.ts";
import { createServerContext, serverApplyOps } from "../../packages/server/src/apply-ops.ts";
import { openDb } from "../../packages/server/src/db.ts";
import { verifyRebuildParity } from "../../packages/server/src/verify.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: subtree-page-repair-real-graph.ts <copy of graph.sqlite>");
const ctx = createServerContext(openDb({ path }));
const { driver } = ctx;

const mismatched = (): number =>
  driver.get<{ n: number }>(
    "SELECT count(*) AS n FROM block c JOIN block p ON p.id = c.parent_id WHERE c.page_id != p.page_id",
  )?.n ?? 0;

// The live top-level block with the largest subtree.
const root = driver.get<{ id: string; page_id: string; n: number }>(
  `WITH RECURSIVE sub(root, id) AS (
     SELECT b.id, b.id FROM block b JOIN page p ON p.id = b.page_id
      WHERE b.parent_id IS NULL AND b.deleted_at IS NULL AND p.deleted_at IS NULL
     UNION ALL
     SELECT sub.root, c.id FROM block c JOIN sub ON c.parent_id = sub.id
   )
   SELECT sub.root AS id, (SELECT page_id FROM block WHERE id = sub.root) AS page_id, count(*) AS n
     FROM sub GROUP BY sub.root ORDER BY n DESC LIMIT 1`,
);
if (!root) throw new Error("no blocks");
const dst = driver.get<{ id: string }>(
  "SELECT id FROM page WHERE deleted_at IS NULL AND id != ? ORDER BY created_at LIMIT 1",
  [root.page_id],
);
if (!dst) throw new Error("need a second page");
console.log(`root ${root.id}: subtree of ${root.n} blocks; mismatched before: ${mismatched()}`);

// Tombstone one child subtree the way block.delete does (one instant), so the probe covers B-121.
const child = driver.get<{ id: string }>(
  "SELECT id FROM block WHERE parent_id = ? AND deleted_at IS NULL ORDER BY order_key LIMIT 1",
  [root.id],
);
const dev = new Hlc("dddddddd");
dev.receive(ctx.hlc.next());
if (child) {
  const ids: string[] = [];
  const queue = [child.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    ids.push(id);
    for (const c of driver.all<{ id: string }>("SELECT id FROM block WHERE parent_id = ?", [id]))
      queue.push(c.id);
  }
  const now = Date.now();
  serverApplyOps(
    ctx,
    ids.map((id) => makeOp(dev.next(), "dddddddd", id, { kind: "block.delete", deletedAt: now })),
    { origin: "sync", actor: "probe", deviceId: "dddddddd" },
  );
  console.log(`tombstoned a child subtree of ${ids.length} block(s)`);
}

const place = (pageId: string): { ms: number; corrections: number } => {
  const t0 = performance.now();
  const r = serverApplyOps(
    ctx,
    [
      makeOp(dev.next(), "dddddddd", root.id, {
        kind: "block.place",
        place: { pageId, parentId: null, order: "zzzz" },
      }),
    ],
    { origin: "sync", actor: "probe", deviceId: "dddddddd" },
  );
  return { ms: Math.round(performance.now() - t0), corrections: r.corrections.length };
};

const away = place(dst.id);
const onDst = driver.get<{ n: number }>(
  `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM block c JOIN sub ON c.parent_id = sub.id)
   SELECT count(*) AS n FROM block WHERE id IN (SELECT id FROM sub) AND page_id = ?`,
  [root.id, dst.id],
)?.n;
console.log(
  `move to another page: ${away.corrections} repair op(s) in ${away.ms} ms; ${onDst}/${root.n} on the destination; mismatched: ${mismatched()}`,
);
const back = place(root.page_id);
console.log(
  `move back: ${back.corrections} repair op(s) in ${back.ms} ms; mismatched: ${mismatched()}`,
);
const report = verifyRebuildParity(driver);
console.log(`verify: ok=${report.ok}, ${report.divergences.length} divergence(s)`);
