/**
 * B-587 / ADR 026 probe (2026-10-03): the three-device shape against a REAL `nooklet serve` over
 * real HTTP, with the real `SyncClient` + `createHttpTransport`, so `pnpm nooklet verify` can then
 * be run on a graph that actually went through it.
 *
 *   B links [[Ghost Name]] (server mints it), C bootstraps, B unlinks (server deletes it),
 *   A — clock 5 s behind, never pulled — creates "Ghost Name" + a block and pushes,
 *   then A, B, C pull and a fresh D pulls the whole log in one batch.
 *
 * Prints, per replica, whether its state equals the server's `/sync/snapshot` (A on live rows
 * only: B-443). Before ADR 026, C and D lose A's page and block.
 *
 * Usage (server already running on a scratch data dir, a `--sync` token minted for it):
 *   cd packages/server && NOOKLET_PROBE_URL=http://127.0.0.1:6315/g/default \
 *     NOOKLET_PROBE_TOKEN=nk_… pnpm exec tsx ../../tools/probes/b587-three-device-http.ts
 *   pnpm nooklet verify --data <that dir>
 *
 * Output on 0cb4a62 (2026-10-03): A=same B=same C=same D=same, A's create HLC older: true;
 * verify: OK.
 */

import { initClientSchema } from "../../apps/web/src/db/schema-client.js";
import { createHttpTransport } from "../../apps/web/src/sync/http-transport.js";
import { SyncClient } from "../../apps/web/src/sync/sync-client.js";
import { initSchema, makeOp, newId, type SqlDriver } from "../../packages/core/src/index.js";
import {
  createNodeSqliteDriver,
  openNodeSqlite,
} from "../../packages/core/src/sync/node-sqlite-driver.js";

const baseUrl = process.env.NOOKLET_PROBE_URL ?? "http://127.0.0.1:6315/g/default";
const token = process.env.NOOKLET_PROBE_TOKEN;
if (!token) throw new Error("NOOKLET_PROBE_TOKEN is required");
// `createHttpTransport` resolves URLs against the worker's `self.location`; Node has neither.
(globalThis as { self?: unknown }).self = { location: new URL(baseUrl) };

function replica(now?: () => number) {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  initClientSchema(driver);
  const client = new SyncClient({
    driver,
    transport: createHttpTransport({ baseUrl, getToken: () => token }),
    now,
  });
  client.init();
  return { driver, client };
}

const B = replica();
const home = newId();
const line = newId();
B.client.applyLocal([
  makeOp(B.client.nextHlc(), B.client.getDeviceId(), home, {
    kind: "page.create",
    name: `Probe Home ${home}`,
    journalDay: null,
    createdAt: Date.now(),
  }),
  makeOp(B.client.nextHlc(), B.client.getDeviceId(), line, {
    kind: "block.create",
    place: { pageId: home, parentId: null, order: "a0" },
    content: "[[Ghost Name]]",
    createdAt: Date.now(),
  }),
]);
await B.client.flush();

const C = replica();
await C.client.bootstrap();

B.client.applyLocal([
  makeOp(B.client.nextHlc(), B.client.getDeviceId(), line, {
    kind: "block.text",
    content: "no link any more",
  }),
]);
await B.client.flush();

const A = replica(() => Date.now() - 5_000);
const mine = newId();
const create = makeOp(A.client.nextHlc(), A.client.getDeviceId(), mine, {
  kind: "page.create",
  name: "Ghost Name",
  journalDay: null,
  createdAt: Date.now(),
});
A.client.applyLocal([
  create,
  makeOp(A.client.nextHlc(), A.client.getDeviceId(), newId(), {
    kind: "block.create",
    place: { pageId: mine, parentId: null, order: "a0" },
    content: "mine",
    createdAt: Date.now(),
  }),
]);
await A.client.flush();
for (const r of [A, B, C]) await r.client.pull();
const D = replica();
await D.client.pull();

// The server's state, through the same snapshot route a bootstrap uses.
const E = replica();
await E.client.bootstrap();

const rows = (d: SqlDriver, liveOnly = false) =>
  JSON.stringify({
    pages: d.all(`SELECT * FROM page ${liveOnly ? "WHERE deleted_at IS NULL" : ""} ORDER BY id`),
    blocks: d.all("SELECT * FROM block ORDER BY id"),
    blockProps: d.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: d.all("SELECT * FROM page_prop ORDER BY page_id, key"),
  });
const deleteHlc = E.driver.get<{ deleted_hlc: string }>(
  "SELECT deleted_hlc FROM page WHERE key = 'ghost name' AND deleted_at IS NOT NULL",
)?.deleted_hlc;
console.log(`A's create HLC older than the server's delete: ${create.hlc < (deleteHlc ?? "")}`);
console.log(
  [
    `A=${rows(A.driver, true) === rows(E.driver, true) ? "same" : "DIVERGED"}`,
    ...(
      [
        ["B", B],
        ["C", C],
        ["D", D],
      ] as const
    ).map(([n, r]) => `${n}=${rows(r.driver) === rows(E.driver) ? "same" : "DIVERGED"}`),
  ].join(" "),
);
if (process.env.NOOKLET_PROBE_DEBUG) {
  for (const [n, r] of [
    ["A", A],
    ["B", B],
    ["C", C],
    ["D", D],
  ] as const)
    console.log(n, JSON.stringify(r.client.getStatus()));
  console.log("D:", rows(D.driver));
  console.log("E:", rows(E.driver));
}
console.log(
  "server: ghost name ->",
  E.driver.get<{ id: string }>(
    "SELECT id FROM page WHERE key = 'ghost name' AND deleted_at IS NULL",
  )?.id === mine
    ? "A's page"
    : "something else",
);
