/**
 * B-587 probe (2026-10-03, b585 agent): why `verifyRebuildParity` intermittently reports A's page
 * and block `missing-in-rebuild` in `apps/web/src/sync/e2e.test.ts` "a page of a name whose earlier
 * page the server deleted stays this device's page" (either order — caught on "pull first" too).
 *
 * Replays the op log captured from a failing run (HLCs verbatim, ids shortened). Live, the server
 * applied it batch by batch in `seq` order: the reference rule's `page.delete` of "Ghost Name"
 * (seq 5) lands before device A's own `page.create` of "Ghost Name" (seq 6). But A minted its HLCs
 * before it had heard of seq 5, in the same millisecond, so A's create has the SMALLER HLC
 * (`.838Z-0000-…` < `.838Z-0002-…`). Core's `applyOps` sorts every batch by HLC — which `rebuild`
 * and verify's replay rely on — so a replay applies A's create while the ghost is still live, and
 * rejects it (`page-key-collision`). Unverified: a third device pulling seq 3..7 in one batch may do the same.
 * Not B-585 (no client page minting is involved; the test drives `SyncClient` directly).
 *
 * Run from packages/server:  pnpm exec tsx ../../tools/probes/b587-hlc-order-name-collision.ts
 * Output on 7784d54: live "Ghost Name" = A's page; replay: A's create "rejected", name not live.
 */
import { applyOps, initSchema, type Op, type OpPayload } from "../../packages/core/src/index.js";
import {
  createNodeSqliteDriver,
  openNodeSqlite,
} from "../../packages/core/src/sync/node-sqlite-driver.js";

const op = (hlc: string, device: string, entity: string, payload: OpPayload): Op => ({
  id: hlc,
  hlc,
  device,
  entity,
  payload,
});
const T = "2026-10-03T14:37:09.8";
const log: Op[] = [
  op(`${T}36Z-0000-b279c11a`, "b279c11a", "homeB", {
    kind: "page.create",
    name: "Home B",
    journalDay: null,
    createdAt: 1,
  }),
  op(`${T}37Z-0001-00000000`, "refpages", "ghost", {
    kind: "page.create",
    name: "Ghost Name",
    journalDay: null,
    createdAt: 1,
  }),
  op(`${T}38Z-0002-00000000`, "refpages", "ghost", { kind: "page.delete", deletedAt: 2 }),
  op(`${T}38Z-0000-562db010`, "562db010", "mineA", {
    kind: "page.create",
    name: "Ghost Name",
    journalDay: null,
    createdAt: 3,
  }),
];

function fresh() {
  const d = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(d);
  return d;
}
const livePage = (d: ReturnType<typeof fresh>) =>
  d.get<{ id: string }>("SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL");

// Live server: each push/correction is its own applyOps call, in seq order.
const live = fresh();
for (const o of log) applyOps(live, [o]);
console.log("live (seq order, one op per batch): ghost name ->", livePage(live)?.id ?? "none");

// Rebuild / one big pull: the whole log in one applyOps call, which sorts by HLC.
const replay = fresh();
const res = applyOps(replay, log);
const mine = res.results.find((r) => r.entity === "mineA");
console.log(`replay (one batch, HLC-sorted): A's create ${mine?.status} (${mine?.reason ?? ""})`);
console.log("replay: ghost name ->", livePage(replay)?.id ?? "none");
