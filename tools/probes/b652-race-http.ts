/**
 * B-652 probe (2026-10-04, b652 agent): the push/pull race against a REAL `nooklet serve` over
 * real HTTP, with the real `SyncClient` + `createHttpTransport`, so `pnpm nooklet verify` can then
 * run on a graph that went through it.
 *
 * Three devices pull a page with two blocks, go "offline" and each edit both: block 1 rewritten
 * whole (a true conflict), block 2 one word each (mergeable). Then each reconnects the way
 * `worker-core.ts` does — push and pull at once — with its pull responses held back 300 ms, so the
 * push response is applied first (the order that lost a text before the fix). Then everyone syncs
 * until quiet, and a fresh replica pulls the whole log.
 *
 * Prints each replica's page and whether it equals the fresh replica's. Expected after the fix:
 * block 1 the LWW winner plus two `sync-conflict` copies (all three texts present), block 2
 * "ONE TWO THREE", every replica the same.
 *
 * Usage (server already running on a scratch data dir, a `--sync` token minted for it):
 *   cd packages/server && NOOKLET_PROBE_URL=http://127.0.0.1:6462/g/default \
 *     NOOKLET_PROBE_TOKEN=nk_… pnpm exec tsx ../../tools/probes/b652-race-http.ts
 *   pnpm nooklet verify --data <that dir>
 *
 * Output 2026-10-04, scratch server on port 6462:
 *   with the fix (d7d6586):  [ 'Gamma', 'Beta  [sync conflict]', 'Alpha  [sync conflict]',
 *                              'ONE TWO THREE' ], A/B/C same; verify OK (21 ops).
 *   client from 59aa77b:     [ 'Gamma', 'one two THREE' ], A/B/C same — "Alpha", "Beta", "ONE"
 *                            and "TWO" gone with no copy, every replica agreeing on the loss;
 *                            verify still OK (the log replays to the same lossy state: the loss
 *                            is LWW doing what it was told, invisible to verify).
 */

import { initClientSchema } from "../../apps/web/src/db/schema-client.js";
import { createHttpTransport } from "../../apps/web/src/sync/http-transport.js";
import { SyncClient } from "../../apps/web/src/sync/sync-client.js";
import { initSchema, makeOp, newId, type SqlDriver } from "../../packages/core/src/index.js";
import {
  createNodeSqliteDriver,
  openNodeSqlite,
} from "../../packages/core/src/sync/node-sqlite-driver.js";

const baseUrl = process.env.NOOKLET_PROBE_URL ?? "http://127.0.0.1:6462/g/default";
const token = process.env.NOOKLET_PROBE_TOKEN;
if (!token) throw new Error("NOOKLET_PROBE_TOKEN is required");
// `createHttpTransport` resolves URLs against the worker's `self.location`; Node has neither.
(globalThis as { self?: unknown }).self = { location: new URL(baseUrl) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function replica(offsetMs = 0) {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  initClientSchema(driver);
  const real = createHttpTransport({ baseUrl, getToken: () => token });
  const state = { slowPull: false };
  const client = new SyncClient({
    driver,
    now: () => Date.now() + offsetMs,
    transport: {
      ...real,
      // The request goes out at once (the server answers it); the device sees the answer later.
      pull: async (...args) => {
        const res = await real.pull(...args);
        if (state.slowPull) await sleep(300);
        return res;
      },
    },
  });
  client.init();
  return { driver, client, state };
}

function page(driver: SqlDriver, pageId: string) {
  return driver
    .all<{ id: string; content: string }>(
      "SELECT id, content FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY order_key, id",
      [pageId],
    )
    .map((b) => {
      const tag = driver.get(
        "SELECT 1 FROM block_prop WHERE block_id = ? AND key = 'sync-conflict'",
        [b.id],
      );
      return tag ? `${b.content}  [sync conflict]` : b.content;
    });
}

const A = replica(0);
const B = replica(1000);
const C = replica(2000);
const pageId = newId();
const b1 = newId();
const b2 = newId();
A.client.applyLocal([
  makeOp(A.client.nextHlc(), A.client.getDeviceId(), pageId, {
    kind: "page.create",
    name: `B652 Race ${pageId}`,
    journalDay: null,
    createdAt: Date.now(),
  }),
  makeOp(A.client.nextHlc(), A.client.getDeviceId(), b1, {
    kind: "block.create",
    place: { pageId, parentId: null, order: "a0" },
    content: "Something",
    createdAt: Date.now(),
  }),
  makeOp(A.client.nextHlc(), A.client.getDeviceId(), b2, {
    kind: "block.create",
    place: { pageId, parentId: null, order: "a1" },
    content: "one two three",
    createdAt: Date.now(),
  }),
]);
await A.client.flush();
for (const d of [A, B, C]) await d.client.pull();

const edits: Array<[typeof A, string, string]> = [
  [A, "Alpha", "ONE two three"],
  [B, "Beta", "one TWO three"],
  [C, "Gamma", "one two THREE"],
];
for (const [d, t1, t2] of edits) {
  d.client.applyLocal([
    makeOp(d.client.nextHlc(), d.client.getDeviceId(), b1, { kind: "block.text", content: t1 }),
    makeOp(d.client.nextHlc(), d.client.getDeviceId(), b2, { kind: "block.text", content: t2 }),
  ]);
}

for (const d of [A, B, C]) {
  d.state.slowPull = true;
  await Promise.all([d.client.flush(), d.client.pull()]);
  d.state.slowPull = false;
}
for (let round = 0; round < 4; round++) {
  for (const d of [A, B, C]) {
    await d.client.flush();
    await d.client.pull();
  }
}

const fresh = replica();
await fresh.client.pull();
const want = JSON.stringify(page(fresh.driver, pageId));
console.log("fresh replica:", page(fresh.driver, pageId));
for (const [name, d] of [
  ["A", A],
  ["B", B],
  ["C", C],
] as const) {
  console.log(name, JSON.stringify(page(d.driver, pageId)) === want ? "same" : "DIFFERENT");
}
for (const d of [A, B, C, fresh]) d.client.dispose();
