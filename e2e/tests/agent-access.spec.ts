/**
 * B-708: the live agent channel (`/ui/live`, ADR 015) on a desktop is unchanged — on by default,
 * badge in the top bar — and Settings → Agent access holds the same switch as the badge. The phone
 * side (off and hidden by default) is `phone-ui.spec.ts` "B-708…", which runs in WebKit too.
 */

import { expect, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

test.use({ viewport: { width: 1280, height: 800 } });

test("B-708: a desktop opens the agent channel by default, shows the badge, and Settings turns it off", async ({
  page,
}) => {
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await openPage(page, "Desktop Agent Access", "- one");
  const badge = page.locator(".vr-live-badge");
  await expect(badge).toBeVisible();
  await expect.poll(() => sockets.some((u) => u.includes("/ui/live"))).toBe(true);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const view = page.getByRole("checkbox", { name: "Let agents view this window" });
  await expect(view).toBeChecked();
  await view.click();
  // Off: the badge stays (a desktop always shows it), reading "off".
  await expect(badge).toHaveAttribute("data-state", "off");

  sockets.length = 0;
  await page.reload();
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  expect(sockets.filter((u) => u.includes("/ui/live"))).toEqual([]);
  await expect(badge).toBeVisible();
});
