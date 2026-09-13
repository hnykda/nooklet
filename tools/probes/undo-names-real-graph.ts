/**
 * Probe for B-366 / B-367 (docs/review/2026-09-13-rv-merge-server.md): on a real graph, does
 * `batch.undo`'s name pre-check (a) refuse a name a real page aliases (`Taxes` has `alias:: daně`),
 * (b) still undo a merge of a real page with Czech name and backlinks, and refuse the kept-alias
 * variant, (c) let a keep_later_edits undo through when a later rename or delete is kept — and does
 * `verify` still pass afterwards?
 *
 * Run against a COPY of a graph (it writes):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '/tmp/x/graph.sqlite'"
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/undo-names-real-graph.ts /tmp/x/graph.sqlite
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../packages/server/src/apply-ops.ts";
import { createToken } from "../../packages/server/src/auth/tokens.ts";
import { openDb } from "../../packages/server/src/db.ts";
import { createApp } from "../../packages/server/src/http/app.ts";
import { buildRegistry } from "../../packages/server/src/ops/index.ts";
import { post } from "../../packages/server/src/test-helpers.ts";
import { verifyRebuildParity } from "../../packages/server/src/verify.ts";

const path = process.argv[2];
if (!path || path.includes(".nooklet/default")) {
  throw new Error("usage: undo-names-real-graph.ts <COPY of graph.sqlite>");
}
const serverCtx = createServerContext(openDb({ path }));
const app = createApp({
  serverCtx,
  registry: buildRegistry(),
  config: {
    dataDir: mkdtempSync(join(tmpdir(), "nooklet-probe-")),
    graphId: "default",
    timezone: "UTC",
    port: 0,
    mirror: { enabled: false },
  },
  version: "probe",
});
const token = createToken(serverCtx.driver, { label: "probe", scope: "write" }).token;
// biome-ignore lint/suspicious/noExplicitAny: probe output is printed, not typed
const call = async (name: string, body: unknown): Promise<{ status: number; json: any }> =>
  post(app, `/api/v1/${name}`, token, body);
const short = (r: { status: number; json: unknown }) =>
  `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`;
const tick = () => new Promise((r) => setTimeout(r, 2));

// (a) A real alias: Taxes answers to "daně". While it does, a page name "Daně" resolves to Taxes
// (page.delete {page: "Daně"} would delete Taxes), so take the alias off first, make and delete a
// page "Daně", put the alias back, then undo that delete.
console.log("(a) alias of a real page");
const taxesAliasBefore = (await call("page.read", { page: "Taxes" })).json.page.properties?.alias;
await call("page.update", { page: "Taxes", properties: { alias: null } });
console.log(
  "  create Daně:",
  short(await call("page.create", { name: "Daně", markdown: "- probe" })),
);
const del = await call("page.delete", { page: "Daně" });
console.log("  delete Daně:", short(del));
await call("page.update", { page: "Taxes", properties: { alias: taxesAliasBefore } });
console.log(
  "  undo delete of Daně:",
  short(await call("batch.undo", { batch_id: del.json.batch_id })),
);
console.log(
  "  trash.restore Daně:",
  short(await call("trash.restore", { page: "Daně", dry_run: true })),
);
console.log("  page.read daně ->", (await call("page.read", { page: "daně" })).json.page.name);

// (b) Merge a real Czech page with backlinks into Taxes, undo it; then the kept-alias variant.
console.log("(b) merge Balení into Taxes");
const links = async () =>
  (await call("page.backlinks", { target: "Balení" })).json.linked_total as number;
const linksBefore = await links();
const merge = await call("page.merge", { source: "Balení", target: "Taxes" });
console.log("  merge:", short(merge));
const undoMerge = await call("batch.undo", { batch_id: merge.json.batch_id });
console.log("  undo merge:", short(undoMerge));
console.log("  Balení links before/after:", linksBefore, await links());
await tick();
const merge2 = await call("page.merge", { source: "Balení", target: "Taxes" });
const taxesAlias = (await call("page.read", { page: "Taxes" })).json.page.properties?.alias;
await call("page.update", { page: "Taxes", properties: { alias: `${taxesAlias}, Probe` } });
const kept = await call("batch.undo", { batch_id: merge2.json.batch_id, keep_later_edits: true });
console.log("  undo merge, later alias edit kept:", short(kept));
const lww = await call("batch.undo", { batch_id: merge2.json.batch_id });
console.log("  undo merge, LWW:", short(lww));
console.log("  Balení links now:", await links());

// (c) keep_later_edits with a later rename / delete on real pages.
console.log("(c) kept rename and kept delete");
const prop = await call("page.update", {
  page: "Plánování zahradních úprav",
  properties: { probe: "x" },
});
await call("page.update", {
  page: "Plánování zahradních úprav",
  new_name: "Plánování (přejmenováno)",
  keep_alias: false,
});
await call("page.create", { name: "Plánování zahradních úprav", markdown: "- nová" });
console.log(
  "  keep:",
  short(await call("batch.undo", { batch_id: prop.json.batch_id, keep_later_edits: true })),
);
console.log(
  "  LWW:",
  short(await call("batch.undo", { batch_id: prop.json.batch_id, dry_run: true })),
);

const prop2 = await call("page.update", { page: "Garden", properties: { probe: "y" } });
await call("page.delete", { page: "Garden" });
await call("page.create", { name: "Garden", markdown: "- new garden" });
console.log(
  "  keep, deleted since:",
  short(await call("batch.undo", { batch_id: prop2.json.batch_id, keep_later_edits: true })),
);

const report = verifyRebuildParity(serverCtx.driver);
console.log("verify divergences:", report.divergences.length);
