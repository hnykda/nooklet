/**
 * B-676 H4: a device whose token is already at the server's per-token live-socket cap (20). Its
 * `/sync/live` socket is refused with 4429. Before the client knew that code, `open` reset its
 * reconnect delay to 1 s, so the refusal became a reconnect a second, forever. Now it backs off
 * (30 s, doubling) and the indicator stays "Synced" (push and pull still work) with a note that
 * live updates are paused. Unit level: `apps/web/src/sync/live-backoff.test.ts`,
 * `http-transport-live.test.ts`; server: `packages/server/src/live-limits.test.ts`.
 */

import { type BrowserContext, expect, test } from "@playwright/test";

async function asRemoteDevice(context: BrowserContext): Promise<void> {
  await context.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
}

test("a device over its token's socket cap is told live updates are paused, and does not hammer the server", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  // A device token (the loopback auto-token is exempt from the per-token cap), and 20 sockets
  // holding all of its slots, from another page standing in for the device's other tabs.
  const holder = await browser.newPage();
  await holder.goto("/journals");
  const adminToken = await holder.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token,
  );
  const deviceToken = await holder.evaluate(async (t) => {
    const call = async (op: string, body: unknown, auth?: string) =>
      (
        await fetch(`/g/default/api/v1/${op}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify(body),
        })
      ).json();
    const { code } = await call("pairing.create", {}, t);
    return (await call("pairing.redeem", { code, label: "capped device" })).token as string;
  }, adminToken);
  const held = await holder.evaluate(async (token) => {
    const url = new URL("/g/default/sync/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const w = window as unknown as { held: WebSocket[] };
    w.held = [];
    for (let i = 0; i < 20; i++) {
      const ws = new WebSocket(url);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      ws.send(JSON.stringify({ type: "hello", device_id: `held${i}`, token }));
      w.held.push(ws);
    }
    await new Promise((r) => setTimeout(r, 300));
    return w.held.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }, deviceToken);
  expect(held).toBe(20);

  const ctx = await browser.newContext();
  await asRemoteDevice(ctx);
  const p = await ctx.newPage();
  const attempts: number[] = [];
  p.on("websocket", (ws) => {
    if (ws.url().includes("/sync/live")) attempts.push(Date.now());
  });
  await p.goto("/journals");
  await p.evaluate((t) => {
    localStorage.setItem(
      "nooklet.graphs",
      JSON.stringify([
        { id: "e2e-capped", label: "Remote", kind: "remote", baseUrl: "/g/default", token: t },
      ]),
    );
    localStorage.setItem("nooklet.activeGraphId", "e2e-capped");
  }, deviceToken);
  attempts.length = 0;
  await p.goto("/journals");

  const indicator = p.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute(
    "aria-label",
    /^Synced — live updates paused \(the server is at its connection limit\)/,
    {
      timeout: 15_000,
    },
  );
  await expect(indicator).toHaveAttribute("data-state", "synced");
  // Ten seconds on, still one attempt: the next is ~30 s after the refusal, not 1 s.
  await p.waitForTimeout(10_000);
  expect(attempts).toHaveLength(1);

  // Free a slot: the next attempt is accepted. Not waited for here (30 s); the backoff reset is
  // unit-tested.
  await holder.evaluate(() => {
    for (const ws of (window as unknown as { held: WebSocket[] }).held) ws.close();
  });
  await ctx.close();
  await holder.close();
});
