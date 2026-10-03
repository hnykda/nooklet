/**
 * What a user actually sees when the client is opened over plain http on a non-loopback address
 * (a LAN IP, or a Tailscale 100.x IP without `tailscale serve`): B-27 says "cannot open its
 * database"; this records the on-screen symptom after a successful token paste.
 */
import { readFileSync } from "node:fs";
import { chromium, devices, expect, test, webkit } from "@playwright/test";

const BASE = process.env.SWEEP_INSECURE_BASE ?? "http://192.168.1.5:6311";
const T = JSON.parse(readFileSync(process.env.SWEEP_TOKENS ?? "tokens.json", "utf8"));

for (const [name, launcher, opts] of [
  ["chromium", chromium, {}],
  ["webkit-iphone", webkit, devices["iPhone 15"]],
] as const) {
  test(`insecure context symptom (${name})`, async () => {
    const b = await launcher.launch();
    const ctx = await b.newContext(opts);
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
    await p.goto(`${BASE}/`);
    console.log("OBS:", name, "isSecureContext =", await p.evaluate(() => isSecureContext));
    await p.getByRole("button", { name: /Sync with a server/s }).click();
    await p.getByLabel("Device token").fill(T.default.mac);
    await p.getByRole("button", { name: "Connect" }).click();
    await expect(p.locator(".connect"))
      .toHaveCount(0, { timeout: 20_000 })
      .catch(() => {});
    await p.waitForTimeout(6000);
    await p.screenshot({ path: `/tmp/nooklet-sweep-insecure-${name}.png` });
    console.log(
      "OBS:",
      name,
      "body:",
      (await p.locator("body").innerText()).slice(0, 300).replace(/\n+/g, " | "),
    );
    console.log("OBS:", name, "pageerrors:", JSON.stringify([...new Set(errors)]));
    await b.close();
  });
}
