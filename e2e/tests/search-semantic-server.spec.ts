/**
 * server-search: search is local first, then enriched by the server's semantic matches.
 *
 * The owner: "we obv can't ship embedding on the phone, so could we — if connected to a remote
 * server — use embedding server search instead with fallback to local search". What this proves,
 * in a real browser against a real server whose semantic search really runs:
 *
 * - the device's own keyword hits are on screen before the server has answered, and the server's
 *   semantic matches are then added, marked "semantic", with one line saying both answered;
 * - a server that hangs never delays the device's hits, and is given up on (the time bound);
 * - offline, or with the server gone, the device still answers, at once;
 * - a server hit the replica does not have is shown but does not open;
 * - local-only (no server at all) searches the device.
 *
 * Semantic search needs an embedding model; this spec runs its OWN server (port E2E+1) with the
 * test-only deterministic provider (`NOOKLET_TEST_FAKE_EMBEDDINGS=1 nooklet embed model … --provider
 * fake`), so the shared e2e server stays in the owner's "not set up" state that
 * `search-fallback.spec.ts` asserts.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env.NOOKLET_E2E_PORT ?? 6188) + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;
let dataDir = "";
let token = "";

function cli(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn("pnpm", ["--filter", "@nooklet/server", "exec", "tsx", "src/cli.ts", ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function finished(p: ChildProcess, label: string): Promise<void> {
  let out = "";
  p.stdout?.on("data", (d) => {
    out += d;
  });
  p.stderr?.on("data", (d) => {
    out += d;
  });
  return new Promise((resolve, reject) =>
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label}: ${code}\n${out}`)),
    ),
  );
}

async function api<T>(op: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/g/default/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-e2e-semantic-"));
  server = cli(["serve", "--data", dataDir, "--port", String(PORT)]);
  server.stdout?.resume();
  server.stderr?.resume();
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`second server never answered on ${BASE}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  // Registers the model, backfills the (empty) graph and activates it; the server's own indexer
  // embeds everything seeded after this.
  await finished(
    cli(["embed", "model", "fake-model", "--provider", "fake", "--data", dataDir], {
      NOOKLET_TEST_FAKE_EMBEDDINGS: "1",
    }),
    "embed model",
  );
  const session = (await (await fetch(`${BASE}/g/default/api/session`)).json()) as {
    token: string;
  };
  token = session.token;

  await api("page.create", {
    name: "Semantic Kumquat Page",
    markdown: "- a kumquatword note about the orchard harvest",
  });
  await api("page.create", {
    name: "Semantic Persimmon Page",
    markdown: "- persimmon thoughts on ripening in late autumn",
  });
  // Wait for the server's indexer (3 s debounce) to have embedded both, so a hybrid search there
  // really runs and returns vector neighbours — with two units, KNN returns both.
  await expect
    .poll(
      async () => {
        const r = await api<{
          mode_used: string;
          hits: Array<{ kind: string; snippet: string }>;
        }>("search", { query: "kumquatword", mode: "semantic" });
        // The persimmon BLOCK: pages and blocks are separate units, embedded separately.
        return (
          r.mode_used === "semantic" &&
          r.hits.some((h) => h.kind === "block" && h.snippet.includes("persimmon"))
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});

test.afterAll(() => {
  if (server?.pid) {
    try {
      process.kill(server.pid);
    } catch {}
  }
  // `pnpm exec` forks the real server; kill whatever still listens on the port.
  spawn("sh", ["-c", `lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test.use({ baseURL: BASE });

const source = (page: Page) => page.locator(".search-source");
/** A result row by its snippet: a page and a block on it are separate hits with the same page
 * name, and here the page itself is a semantic neighbour too. */
const row = (page: Page, snippet: string) =>
  page.locator(".search-result", {
    has: page.locator(".search-result-snippet", { hasText: snippet }),
  });

async function openSearch(page: Page): Promise<void> {
  await page.goto("/search");
  await expect(page.locator(".search-query-input")).toBeVisible();
}

/** Until this replica has pulled the seeded pages, the device cannot find them; a fresh browser
 * context starts with an empty one. Searched by another word, in keyword mode (no server), then
 * cleared — so the search under test starts from an empty box. */
async function replicaHasSeed(page: Page): Promise<void> {
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill("orchard");
  await expect(row(page, "kumquatword")).toHaveCount(1, { timeout: 15_000 });
  await page.locator(".search-query-input").fill("");
  await page.locator(".search-mode-toggle button", { hasText: "hybrid" }).click();
}

test("online with semantic search: the device's hit first, then the server's semantic matches, marked", async ({
  page,
}) => {
  await openSearch(page);
  await replicaHasSeed(page);
  // (Latency on a real graph: `tools/probes/search-latency.mjs`.)
  await page.locator(".search-query-input").fill("kumquatword");

  await expect(row(page, "kumquatword")).toHaveCount(1, { timeout: 15_000 });
  await expect(source(page)).toHaveText(
    /Keyword \(this device\) and semantic \(server\) · \d+ found by meaning\./,
  );
  // Found by meaning only — no keyword in it — and marked so.
  const semantic = row(page, "persimmon thoughts");
  await expect(semantic).toHaveAttribute("data-semantic", "");
  await expect(semantic.locator(".search-result-tag")).toHaveText("semantic");
  await expect(row(page, "kumquatword")).not.toHaveAttribute("data-semantic", "");
  await expect(page.locator(".search-fallback")).toHaveCount(0);

  // It opens locally: the block, zoomed, on its page.
  await semantic.locator("button.search-result-open").click();
  await expect(page).toHaveURL(/Semantic%20Persimmon%20Page/);
  await expect(page.getByText("persimmon thoughts").first()).toBeVisible();
});

test("a server that hangs never delays the device's hits, and is given up on", async ({ page }) => {
  await openSearch(page);
  await replicaHasSeed(page);
  // Accepts the request and never answers: B-522's shape, one level up.
  await page.route("**/api/v1/search", () => {});
  const started = Date.now();
  await page.locator(".search-query-input").fill("kumquatword");
  await expect(row(page, "kumquatword")).toHaveCount(1, { timeout: 15_000 });
  const localMs = Date.now() - started;
  await expect(source(page)).toContainText("asking the server");
  await expect(source(page)).toHaveText(
    "Keyword search on this device · the server did not answer in time.",
    { timeout: 12_000 },
  );
  const boundMs = Date.now() - started;
  const timing = `device hit after ${localMs} ms; server given up on after ${boundMs} ms`;
  test.info().annotations.push({ type: "timing", description: timing });
  console.log(`[search timing] ${timing}`);
  expect(localMs).toBeLessThan(3_000);
  expect(boundMs).toBeLessThan(10_000);
});

test("a server hit this device has not synced yet is shown, but does not open", async ({
  page,
}) => {
  await openSearch(page);
  // The real server's answer plus one hit for a block no replica here has: what the server
  // returns for something another device wrote a moment ago.
  await page.route("**/api/v1/search", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { hits: unknown[] };
    body.hits.unshift({
      kind: "block",
      id: "notsyncedyet01",
      page: "Written Elsewhere",
      snippet: "something another device wrote",
      breadcrumb: [],
      score: 0.9,
      updated_at: new Date().toISOString(),
    });
    await route.fulfill({ response: res, json: body });
  });
  await page.locator(".search-query-input").fill("kumquatword");
  const away = row(page, "something another device wrote");
  await expect(away).toContainText("Not on this device yet", { timeout: 15_000 });
  await expect(away.locator("button")).toHaveCount(0);
  await expect(row(page, "kumquatword").locator("button")).toHaveCount(1);
});

test("offline: the device answers at once, and says it is offline", async ({ page, context }) => {
  await openSearch(page);
  await replicaHasSeed(page);
  await context.setOffline(true);
  try {
    const started = Date.now();
    await page.locator(".search-query-input").fill("kumquatword");
    await expect(row(page, "kumquatword")).toHaveCount(1, { timeout: 5_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    // Whether sync has noticed yet (offline) or the request itself failed, it says so quietly
    // and never shows an alert.
    await expect(source(page)).toHaveText(
      /Keyword search on this device (\(offline\)\.|· the server's semantic search failed: could not reach)/,
      { timeout: 5_000 },
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});

test("the server stopped: the device still answers, at once", async ({ page }) => {
  await openSearch(page);
  await replicaHasSeed(page);
  spawn("sh", ["-c", `lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
  await expect
    .poll(async () => {
      try {
        await fetch(`${BASE}/healthz`);
        return "up";
      } catch {
        return "down";
      }
    })
    .toBe("down");

  const started = Date.now();
  await page.locator(".search-query-input").fill("kumquatword");
  await expect(row(page, "kumquatword")).toHaveCount(1, { timeout: 5_000 });
  expect(Date.now() - started).toBeLessThan(3_000);
  await expect(source(page)).toHaveText(
    /Keyword search on this device (\(offline\)\.|· the server's semantic search failed: could not reach)/,
    { timeout: 12_000 },
  );
});
