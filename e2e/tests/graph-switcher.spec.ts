/**
 * ADR 025's three legal moves, against a real multi-graph `nooklet serve` (M1-M3) — the one thing
 * no component/unit test can prove, since it needs a REAL worker/OPFS replica and a REAL second
 * sync round trip, not a mocked `fetch`. Move 1 ("new local-only graph") is Capacitor-only and
 * already covered by `apps/web/src/shell/GraphSwitcher.test.tsx`'s platform-mocked tests; nothing
 * here re-proves it against a real iOS shell this suite cannot run.
 *
 * Uses real Node `fetch` for server-side verification (never `page.request`, which resolves a bare
 * path against `baseURL`/`default` — the wrong graph as soon as a second one is involved) and
 * `root.token`, read straight off the e2e server's own data dir, the same way
 * `mirror-live.spec.ts`/`page-export.spec.ts` already read that dir for their own verification.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

function dataDir(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return state.dataDir;
}

function rootToken(): string {
  return readFileSync(join(dataDir(), "root.token"), "utf8").trim();
}

async function createGraph(base: string, id: string): Promise<string> {
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id, label: id }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** The e2e server's own loopback-injected token, for a specific graph — `e2e/helpers/api.ts`'s
 * own `token()` always resolves the bare `/api/session` against `default`, so it cannot answer for
 * any other graph id, which is exactly what these tests need. */
async function loopbackToken(base: string, graphId: string): Promise<string> {
  const res = await fetch(`${base}/g/${graphId}/api/session`);
  const body = (await res.json()) as { token: string | null };
  if (!body.token) throw new Error(`no loopback token for graph "${graphId}"`);
  return body.token;
}

async function pageNames(base: string, graphId: string, token: string): Promise<string[]> {
  const res = await fetch(`${base}/g/${graphId}/api/v1/page.list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ name: string }> };
  return body.items.map((p) => p.name);
}

async function keywordHitCount(
  base: string,
  graphId: string,
  token: string,
  query: string,
): Promise<number> {
  const res = await fetch(`${base}/g/${graphId}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, mode: "keyword" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hits: unknown[] };
  return body.hits.length;
}

test("adding an existing remote graph never mixes its content with the one already active", async ({
  page,
  baseURL,
}) => {
  const base = baseURL as string;
  const token = await createGraph(base, "gs-second");
  await fetch(`${base}/g/gs-second/api/v1/page.create`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "GS Only On Second", markdown: "- only on the second graph" }),
  });

  await page.goto("/journals");
  await page.getByRole("button", { name: "Switch graph" }).click();
  await page.getByText("Add a graph").click();
  await page.getByLabel("Server address").fill(`${base}/g/gs-second`);
  await page.getByLabel("Device token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page).toHaveURL(/\/g\/gs-second\//, { timeout: 15_000 });
  await page.goto("/page/GS%20Only%20On%20Second");
  await expect(page.locator(".vr-outliner").first()).toContainText("only on the second graph");

  // Never combined into "default"'s own history — queried straight off the server, not the UI,
  // since that is the actual claim ADR 025 makes ("never a fourth [move]: attaching content to an
  // existing, already-populated different graph").
  const defaultToken = await loopbackToken(base, "default");
  const defaultPages = await pageNames(base, "default", defaultToken);
  expect(defaultPages).not.toContain("GS Only On Second");
  const secondPages = await pageNames(base, "gs-second", token);
  expect(secondPages).toContain("GS Only On Second");
});

test("promoting a local-only graph pushes its full pre-existing local history to the new graph", async ({
  page,
  baseURL,
}) => {
  const base = baseURL as string;
  const probeText = `GS promote probe ${Date.now()}`;

  // ADR 025: seeds a genuinely local-only entry (no baseUrl at all — the state Capacitor's "Just
  // this device" reaches, which this Chromium suite cannot run for real) directly into the graph
  // list, the same technique `remote-device.spec.ts` already uses for the equivalent remote case.
  // Real Capacitor never resolves `/api/session` at all for such an entry (its own origin is
  // `capacitor://localhost`, with no server behind it — `apiBaseUrl()`'s own doc comment) — mocked
  // here the same way, rather than left to fall through to THIS origin's `/api/session`
  // (`apiBaseUrl()`'s fallback chain lands on `samePathGraphPrefix()`, i.e. `/g/default`, purely
  // because a web browser, unlike Capacitor, is always serving from some `/g/<slug>` origin): an
  // unmocked fallback would silently answer for graph "default" and stamp ITS `graphInstanceId`
  // onto this entry, which then reads as a genuine mismatch once promote points the same entry at
  // the real, different-identity "gs-promoted" graph. Unrouted below before promoting, so that real
  // exchange goes through normally.
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "no_token_available" }),
    }),
  );
  await page.goto("/journals");
  await page.evaluate(() => {
    localStorage.setItem(
      "nooklet.graphs",
      JSON.stringify([{ id: "gs-local", label: "GS Local Only", kind: "local" }]),
    );
    localStorage.setItem("nooklet.activeGraphId", "gs-local");
  });
  await page.goto("/journals");

  // A `token: null` response makes `App.tsx` show `ConnectView` rather than the journal (same as a
  // genuine remote/Capacitor device with nothing paired yet) — its own "Just this device" is the
  // SAME real mechanism `local-page-creation.spec.ts` already uses to reach this state, a plain
  // in-memory skip (`App.tsx`'s `onSkip`) that touches no storage, so it cannot disturb the entry
  // just seeded above.
  await page.getByRole("button", { name: /Just this device/s }).click();

  // Real content, through the editor — a local-only replica has no server to seed through the API.
  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill(probeText);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".vr-outliner").first()).toContainText(probeText);

  await page.unroute("**/api/session");
  await page.getByRole("button", { name: "Switch graph" }).click();
  await page.getByRole("button", { name: "Add a server for GS Local Only" }).click();
  await page.getByLabel("Server address").fill(base);
  await page.getByLabel("New graph id").fill("gs-promoted");
  await page.getByLabel("Root token").fill(rootToken());
  await page.getByRole("button", { name: "Add server" }).click();

  await expect(page).toHaveURL(/\/g\/gs-promoted\//, { timeout: 15_000 });
  // On screen, in the SAME replica (same worker, same OPFS pool — the whole point of "the SAME
  // entry, not a new one").
  await expect(page.locator(".vr-outliner").first()).toContainText(probeText, { timeout: 15_000 });

  // And the real proof: readable from the SERVER, with a token this test never minted for it —
  // only a genuine push (not just a client-side illusion of one) makes this true.
  const newGraphToken = await loopbackToken(base, "gs-promoted");
  await expect
    .poll(() => keywordHitCount(base, "gs-promoted", newGraphToken, probeText), { timeout: 15_000 })
    .toBeGreaterThan(0);
});
