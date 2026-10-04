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
import { openGraphMenu } from "../helpers/index.js";

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
  await openGraphMenu(page);
  await page.getByText("Add a graph").click();
  await page.getByLabel("Server address").fill(`${base}/g/gs-second`);
  await page.getByLabel("Device token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page).toHaveURL(/\/g\/gs-second\//, { timeout: 15_000 });
  // The graph's own address: a bare path redirects to `/g/default`, and the address bar's graph
  // now wins over the active entry (`bootstrap.ts#adoptAddressBarGraph`), so it would open default.
  await page.goto("/g/gs-second/page/GS%20Only%20On%20Second");
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

  // B-612: an active local-only entry IS the "Just this device" choice, remembered, so `App.tsx`
  // shows the journal straight away — no set-up screen, despite the `token: null` above.
  await expect(page.locator(".connect")).toHaveCount(0);

  // Real content, through the editor — a local-only replica has no server to seed through the API.
  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill(probeText);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".vr-outliner").first()).toContainText(probeText);

  await page.unroute("**/api/session");
  await openGraphMenu(page);
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

test("B-618: rows carry the server's graph names, a bare address is not added twice, and a root token lists graphs", async ({
  page,
  baseURL,
}) => {
  const base = baseURL as string;
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken()}` },
    body: JSON.stringify({ id: "gs-labelled", label: "Labelled Second" }),
  });
  expect(res.status).toBe(201);
  const secondToken = ((await res.json()) as { token: string }).token;

  await page.goto("/journals");
  const switcher = page.getByRole("dialog", { name: "Switch graph" });
  await openGraphMenu(page);
  // Named after the server's graph (the default graph's label is its slug), with its address —
  // not the old placeholder "This graph".
  const rows = switcher.locator(".graph-switcher-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".graph-switcher-label")).toHaveText("default");
  await expect(rows.first().locator(".graph-switcher-address")).toHaveText(
    `${new URL(base).host}/g/default`,
  );

  // The bare server address IS the default graph, which is the one already shown here.
  await switcher.getByText("Add a graph").click();
  await expect(switcher).toContainText("/g/<graph>");
  await switcher.getByLabel("Server address").fill(base);
  await switcher.getByLabel("Device token").fill(await loopbackToken(base, "default"));
  await switcher.getByRole("button", { name: "Connect" }).click();
  await expect(switcher.locator(".graph-switcher-error")).toContainText("already this graph");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]").length),
  ).toBe(1);

  // A device token cannot list the server's graphs, and says what can.
  await switcher.getByRole("button", { name: /Show graphs on this server/ }).click();
  await expect(switcher.locator(".graph-switcher-error")).toContainText("root token");
  // The root token can; picking one fills in its address and asks for that graph's own token.
  await switcher.getByLabel("Device token").fill(rootToken());
  await switcher.getByRole("button", { name: /Show graphs on this server/ }).click();
  const listed = switcher.getByRole("list", { name: "Graphs on this server" });
  await expect(listed).toContainText("Labelled Second");
  await expect(listed.getByRole("button", { name: /default/ })).toContainText(
    "already on this device",
  );
  await listed.getByRole("button", { name: /Labelled Second/ }).click();
  await expect(switcher.getByLabel("Server address")).toHaveValue(`${base}/g/gs-labelled`);
  await expect(switcher).toContainText("nooklet token create --graph gs-labelled");
  await switcher.getByLabel("Device token").fill(secondToken);
  await switcher.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/g\/gs-labelled\//, { timeout: 15_000 });

  // Two graphs on one server, told apart by name.
  await openGraphMenu(page);
  await expect(switcher.locator(".graph-switcher-label")).toHaveText([
    "default",
    "Labelled Second",
  ]);
});

test("B-709: the open graph's name heads the sidebar and opens the graph menu; the top bar has no switcher", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/g/default/journals");
  await expect(page.locator(".app-topbar")).toBeVisible();
  // Nothing in the top bar switches graphs any more.
  await expect(
    page.locator(".app-topbar").getByRole("button", { name: /switch graph/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const title = sidebar.getByRole("button", { name: "default, switch graph" });
  await expect(title).toBeVisible();
  // The title is the first thing in the sidebar, above the nav.
  const [titleBox, navBox] = await Promise.all([
    title.boundingBox(),
    sidebar.locator(".sidebar-nav").boundingBox(),
  ]);
  expect((titleBox?.y ?? 0) + (titleBox?.height ?? 0)).toBeLessThanOrEqual(navBox?.y ?? 0);

  await title.click();
  const menu = page.getByRole("dialog", { name: "Switch graph" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("list", { name: "On a server" })).toContainText("default");
  await expect(menu.locator("[aria-current='true']")).toContainText("default");
  // Wider than the sidebar it hangs from, and not clipped by it: fully on screen.
  const box = await menu.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280);
  await expect(menu.getByRole("button", { name: /Add a graph/ })).toBeInViewport();
  // An outside click closes it.
  await page.locator(".page-scroll").click({ position: { x: 400, y: 400 } });
  await expect(menu).toHaveCount(0);
});

test("B-704: a browser tab says a server on another origin opens in its own tab, and contacts nothing", async ({
  page,
}) => {
  const elsewhere = "http://127.0.0.1:6549";
  const contacted: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(elsewhere)) contacted.push(r.url());
  });
  await page.goto("/journals");
  await openGraphMenu(page);
  await page.getByText("Add a graph").click();
  await page.getByLabel("Server address").fill(`${elsewhere}/g/work`);
  const note = page.getByRole("note");
  await expect(note).toContainText("can only add graphs on");
  const link = note.getByRole("link", { name: /Open 127\.0\.0\.1:6549 in a new tab/ });
  await expect(link).toHaveAttribute("href", `${elsewhere}/g/work`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByLabel("Device token")).toBeHidden();
  await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  // Enter in the address field submits nothing either.
  await page.getByLabel("Server address").press("Enter");
  await expect(note).toBeVisible();
  expect(contacted).toEqual([]);
  // Back to this server's own address: the token field and Connect come back.
  await page.getByLabel("Server address").fill(`${new URL(page.url()).origin}/g/default`);
  await expect(page.getByLabel("Device token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
});
