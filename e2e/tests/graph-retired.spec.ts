/**
 * B-713: a graph retired on the server while a device has it open (`DELETE /graphs/<id>`). The
 * server closes the device's live sockets with 4410. Before, the client took any unknown code as a
 * network blip: it showed "Offline" and reconnected forever into 404s. Now it stops reconnecting
 * and says the graph was retired. Unit level: `apps/web/src/sync/live-backoff.test.ts`,
 * `sync-client.test.ts`, `http-transport-retired.test.ts`; server:
 * `packages/server/src/graphs/retire.test.ts`.
 *
 * Retires its own graph, never "default", which every other spec shares.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

function rootToken(): string {
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  return readFileSync(join(state.dataDir, "root.token"), "utf8").trim();
}

test("a graph retired while open says so, and stops reconnecting", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const base = baseURL as string;
  const graph = `retire-e2e-${Date.now().toString(36)}`;
  const auth = { "content-type": "application/json", authorization: `Bearer ${rootToken()}` };
  const created = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: graph, label: graph }),
  });
  expect(created.status).toBe(201);

  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(`/g/${graph}/journals`);
  const indicator = page.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute("aria-label", /^Synced/, { timeout: 20_000 });
  expect(sockets.some((u) => u.includes(`/g/${graph}/sync/live`))).toBe(true);

  const retired = await fetch(`${base}/graphs/${graph}`, { method: "DELETE", headers: auth });
  expect(retired.status).toBe(200);

  await expect(indicator).toHaveAttribute(
    "aria-label",
    "This graph was retired on the server — changes made here stay on this device",
    { timeout: 10_000 },
  );
  await expect(page.getByRole("button", { name: "Graph retired" })).toBeVisible();

  // No reconnect loop: a retry would open a new /sync/live socket within 1-2 s.
  const syncSockets = () => sockets.filter((u) => u.includes("/sync/live")).length;
  const before = syncSockets();
  await page.waitForTimeout(5000);
  expect(syncSockets()).toBe(before);
  await expect(indicator).toHaveAttribute("aria-label", /^This graph was retired/);
});
