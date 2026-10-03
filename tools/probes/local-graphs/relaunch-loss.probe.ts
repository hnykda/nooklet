/**
 * B-619: a local-only ("Just this device") draft-journal write, then an IMMEDIATE relaunch. Records,
 * per run, what the relaunched page's replica is (the sync indicator's `data-state`: `follower`
 * means an in-memory replica, because the previous page load's worker still held the writer lock),
 * whether the note is on screen right after the relaunch, a few seconds later, and after one more
 * (settled) relaunch. LG_RUNS (default 10).
 */
import { chromium, type Page, test } from "@playwright/test";

const APP = process.env.LG_APP ?? "http://127.0.0.1:6336";
const RUNS = Number(process.env.LG_RUNS ?? 10);
const obs = (...a: unknown[]) => console.log("OBS:", ...a);

const today = (p: Page) =>
  p
    .locator(".journal-day-today")
    .first()
    .innerText()
    .catch(() => "");
const state = (p: Page) =>
  p
    .locator(".app-sync-indicator")
    .getAttribute("data-state")
    .catch(() => null);
async function justThisDevice(p: Page): Promise<void> {
  const b = p.getByRole("button", { name: /Just this device/s });
  if (await b.isVisible({ timeout: 4000 }).catch(() => false)) await b.click();
}

test("local-only draft write survives an immediate relaunch", async () => {
  const b = await chromium.launch();
  let lost = 0;
  for (let i = 0; i < RUNS; i++) {
    const ctx = await b.newContext({
      viewport: { width: 393, height: 852 },
      serviceWorkers: process.env.LG_DISK === "1" ? "block" : "allow",
    });
    await ctx.addInitScript(() => {
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
        isPluginAvailable: () => false,
        Plugins: {},
      };
    });
    const p = await ctx.newPage();
    const logs: string[] = [];
    if (process.env.LG_CONSOLE === "1") {
      p.on("console", (m) => {
        if (m.type() !== "debug") logs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
      });
      p.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 200)}`));
    }
    const note = `RELAUNCH NOTE ${i} ${Date.now() % 100000}`;
    await p.goto(`${APP}/`);
    await justThisDevice(p);
    // LG_WARM=1: one launch (and relaunch) before the write, so it does not land in the very first
    // page load of a fresh replica.
    if (process.env.LG_WARM === "1") {
      await p.locator(".journal-day-today .vr-draft-input").first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(1500);
      await p.reload();
      await justThisDevice(p);
    }
    const draft = p.locator(".journal-day-today .vr-draft-input").first();
    await draft.waitFor({ timeout: 20_000 });
    await draft.fill(note);
    await p.keyboard.press("Enter");
    await p.keyboard.press("Escape");
    await p.locator(".journal-day-today", { hasText: note }).first().waitFor();
    const s0 = await state(p);
    // Where the note is shown at the moment of the relaunch: a `.vr-draft-line` is a line Enter
    // closed that the draft has NOT written yet (its commit is waiting on `prepare`'s worker round
    // trips); a `.vr-row` outside `.vr-draft` is a block of the day's tree.
    const shownAs = await p.evaluate((needle) => {
      const inDraft = [...document.querySelectorAll(".vr-draft-line")].some((e) =>
        e.textContent?.includes(needle),
      );
      return inDraft ? "draft-line (unwritten)" : "tree";
    }, note);
    // LG_TXN=1 needs a build with the temporary `__lgDebugQuery` hook (see docs/progress/local-graphs.md):
    // is the write in the replica, and is a transaction left open around it?
    if (process.env.LG_TXN === "1") {
      const dbg = await p.evaluate(async (needle) => {
        const q = (
          globalThis as unknown as {
            __lgDebugQuery: (s: string, p?: unknown[]) => Promise<unknown>;
          }
        ).__lgDebugQuery;
        const rows = await q("SELECT count(*) AS n FROM block WHERE content LIKE ?", [
          `%${needle}%`,
        ]);
        let txn = "none open";
        try {
          await q("BEGIN");
          await q("COMMIT");
        } catch (e) {
          txn = String(e).slice(0, 160);
        }
        return { rows, txn };
      }, note);
      obs(`  replica before reload: ${JSON.stringify(dbg)}`);
    }
    const batches = await p.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith("nooklet.unapplied")).length,
    );
    // LG_SETTLE_MS: a pause between the write and the relaunch (default 0: immediate).
    await p.waitForTimeout(Number(process.env.LG_SETTLE_MS ?? 0));
    await p.reload();
    await justThisDevice(p);
    await p.waitForTimeout(1000);
    const s1 = await state(p);
    const t1 = (await today(p)).includes(note);
    await p.waitForTimeout(6000);
    const t2 = (await today(p)).includes(note);
    await p.reload();
    await justThisDevice(p);
    await p.waitForTimeout(2500);
    const s3 = await state(p);
    const t3 = (await today(p)).includes(note);
    if (!t3) lost++;
    // Where is the note on disk, if anywhere? A page with none of the app's code (the service
    // worker is blocked for this context), reading every OPFS file raw.
    let onDisk = "?";
    if (process.env.LG_DISK === "1") {
      await p.goto(`${APP}/manifest.webmanifest`);
      onDisk = await p.evaluate(async (needle) => {
        const out: string[] = [];
        const walk = async (d: FileSystemDirectoryHandle, pre: string): Promise<void> => {
          // @ts-expect-error entries() exists in Chromium
          for await (const [n, h] of d.entries()) {
            if (h.kind === "directory") await walk(h, `${pre}${n}/`);
            else {
              const text = new TextDecoder("latin1").decode(
                await (await h.getFile()).arrayBuffer(),
              );
              if (text.includes(needle)) out.push(`${pre}${n}`);
            }
          }
        };
        await walk(await navigator.storage.getDirectory(), "");
        return out.join(",") || "nowhere";
      }, note);
    }
    obs(
      `run ${i}: writer state=${s0} shown-as=${shownAs} unapplied-at-reload=${batches} relaunch state=${s1} note@1s=${t1} note@7s=${t2} | after settled relaunch state=${s3} note=${t3} on-disk=${onDisk}`,
    );
    if (logs.length > 0) obs(`  console:\n    ${logs.join("\n    ")}`);
    await ctx.close();
  }
  obs(`lost ${lost} of ${RUNS}`);
  await b.close();
});
