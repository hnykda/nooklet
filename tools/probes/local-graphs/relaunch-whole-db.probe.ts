/**
 * B-619, narrowing: when a write followed by an immediate relaunch is lost, is it only that write,
 * or the whole replica? Writes note A (draft), lets it settle, relaunches, checks A; then writes
 * note B in the same day's tree and relaunches at once. Reports whether A and B survive.
 */
import { chromium, type Page, test } from "@playwright/test";

const APP = process.env.LG_APP ?? "http://127.0.0.1:6336";
const RUNS = Number(process.env.LG_RUNS ?? 4);
const obs = (...a: unknown[]) => console.log("OBS:", ...a);

const today = (p: Page) =>
  p
    .locator(".journal-day-today")
    .first()
    .innerText()
    .catch(() => "");
async function justThisDevice(p: Page): Promise<void> {
  const b = p.getByRole("button", { name: /Just this device/s });
  if (await b.isVisible({ timeout: 4000 }).catch(() => false)) await b.click();
}

test("whole replica or one write", async () => {
  const b = await chromium.launch();
  for (let i = 0; i < RUNS; i++) {
    const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
    await ctx.addInitScript(() => {
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
        isPluginAvailable: () => false,
        Plugins: {},
      };
    });
    const p = await ctx.newPage();
    const a = `NOTE A ${i} ${Date.now() % 100000}`;
    const bNote = `NOTE B ${i} ${Date.now() % 100000}`;
    await p.goto(`${APP}/`);
    await justThisDevice(p);
    const draft = p.locator(".journal-day-today .vr-draft-input").first();
    await draft.waitFor({ timeout: 20_000 });
    await draft.fill(a);
    await p.keyboard.press("Enter");
    await p.waitForTimeout(2000);
    await p.keyboard.type(bNote);
    // Past the 500 ms text debounce, so B has been handed to the worker.
    await p.waitForTimeout(Number(process.env.LG_B_WAIT_MS ?? 800));
    await p.keyboard.press("Escape");
    const before = await today(p);
    await p.reload();
    await justThisDevice(p);
    await p.waitForTimeout(3000);
    const after = await today(p);
    obs(
      `run ${i}: before reload A=${before.includes(a)} B=${before.includes(bNote)} | after A=${after.includes(a)} B=${after.includes(bNote)}`,
    );
    await ctx.close();
  }
  await b.close();
});
