/**
 * Probe (2026-09-13, m9/focus, B-161): after Cmd/Ctrl+K then Escape while editing, where does
 * focus go, and what (if anything) brings it back to the editor?
 *
 * Prints, per iteration: activeElement sampled right after Escape and at +50/+250/+1000 ms, and
 * every `focusin`/`focusout` on the page after Cmd+K with its time (ms) and JS stack — so a pass
 * names what refocused the editor, and a fail shows nothing did.
 *
 * Not part of the suite (it prints; it does not assert). To re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium --repeat-each=10
 * then delete the copy. For "under load", start a few busy node loops first
 * (`node -e 'for(;;){}'`, one per core) and kill them after.
 */
import { expect, test } from "@playwright/test";
import { MOD, openEditing } from "../helpers/index.js";

test("probe: who gives the editor focus back after the palette closes?", async ({ page }, info) => {
  const name = `Probe Palette Focus ${info.repeatEachIndex} ${Date.now()}`;
  await openEditing(page, name, "- keep typing");
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __t0: number };
    w.__log = [];
    w.__t0 = performance.now();
    const describe = (el: EventTarget | null): string => {
      const e = el as Element | null;
      if (!e || !("tagName" in e)) return String(el);
      return `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`;
    };
    const at = () => Math.round(performance.now() - w.__t0);
    document.addEventListener(
      "focusin",
      (e) => {
        const stack = (new Error().stack ?? "").split("\n").slice(2, 7).join(" | ");
        w.__log.push(`${at()}ms focusin ${describe(e.target)} ${stack}`);
      },
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => {
        w.__log.push(`${at()}ms focusout ${describe(e.target)} -> ${describe(e.relatedTarget)}`);
      },
      true,
    );
  });
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[]; __t0: number };
    w.__log.push(`${Math.round(performance.now() - w.__t0)}ms --- palette visible; t0 reset`);
    w.__t0 = performance.now();
  });
  await page.keyboard.press("Escape");
  const sample = async (label: string) =>
    page.evaluate((l) => {
      const w = window as unknown as { __log: string[]; __t0: number };
      const a = document.activeElement;
      const desc = a ? `${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]}` : "none";
      w.__log.push(
        `${Math.round(performance.now() - w.__t0)}ms sample ${l}: active=${desc} palette=${document.querySelectorAll(".cmd-palette").length}`,
      );
    }, label);
  await sample("after Escape");
  await page.waitForTimeout(50);
  await sample("+50");
  await page.waitForTimeout(200);
  await sample("+250");
  await page.waitForTimeout(750);
  await sample("+1000");
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  console.log(`--- iteration ${info.repeatEachIndex}\n${log.join("\n")}`);
});

/** The regression test's exact steps, with the trace installed before the app loads so it adds no
 * round trip between the keystrokes — prints what, if anything, refocused the editor. */
test("probe: the real test's timing, traced", async ({ page }, info) => {
  // PROBE_CPU_THROTTLE=<rate>: slow the renderer down the way a loaded machine does (CDP), so
  // animation frames arrive late.
  const throttle = Number(process.env.PROBE_CPU_THROTTLE ?? "0");
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  const rafDelay = Number(process.env.PROBE_RAF_DELAY ?? "0");
  await page.addInitScript((d) => {
    (window as unknown as { __rafDelay?: number }).__rafDelay = d;
  }, rafDelay);
  await page.addInitScript(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    const describe = (el: EventTarget | null): string => {
      const e = el as Element | null;
      if (!e || !("tagName" in e)) return String(el);
      return `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`;
    };
    const at = () => Math.round(performance.now());
    document.addEventListener(
      "focusin",
      (e) => {
        const stack = (new Error().stack ?? "").split("\n").slice(2, 9).join(" | ");
        w.__log.push(`${at()}ms focusin ${describe(e.target)} ${stack}`);
      },
      true,
    );
    document.addEventListener("keydown", (e) => w.__log.push(`${at()}ms keydown ${e.key}`), true);
    // Name every animation-frame callback in the stack, so a focusin caused by one says so.
    // PROBE_RAF_DELAY (ms, via a cookie-free global set below): a starved renderer drops begin-frames
    // while input events keep being dispatched, so a frame callback can land after keys typed later.
    const delay = (window as unknown as { __rafDelay?: number }).__rafDelay ?? 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      raf(function rafCallback(t) {
        if (delay > 0) setTimeout(() => cb(t), delay);
        else cb(t);
      });
    // And log each frame that runs while the palette is open or just closed.
    const tick = () => {
      if (document.querySelector(".cmd-palette")) w.__log.push(`${at()}ms frame (palette open)`);
      raf(tick);
    };
    raf(tick);
  });
  const name = `Probe Palette Real ${info.repeatEachIndex} ${Date.now()}`;
  await openEditing(page, name, "- keep typing");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  let focused = true;
  try {
    await expect(page.locator(".cm-content")).toBeFocused({ timeout: 2000 });
  } catch {
    focused = false;
  }
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  console.log(`--- iteration ${info.repeatEachIndex} focused=${focused}\n${log.join("\n")}`);
});

/** The other direction of the same race: a click that enters editing arms a frame-later "take
 * focus back" in `surface.attach`. When that frame lands AFTER Cmd+K has focused the palette's
 * input, does the editor take focus back from the open palette? Prints where typed text went. */
test("probe: a late frame after entering editing vs an open palette", async ({ page }, info) => {
  const rafDelay = Number(process.env.PROBE_RAF_DELAY ?? "0");
  await page.addInitScript((d) => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      raf((t) => {
        if (d > 0) setTimeout(() => cb(t), d);
        else cb(t);
      });
  }, rafDelay);
  const name = `Probe Palette Steal ${info.repeatEachIndex} ${Date.now()}`;
  const { seedPage, pagePath } = await import("../helpers/index.js");
  await seedPage(page, name, "- keep typing");
  await page.goto(pagePath(name));
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await page.waitForTimeout(rafDelay + 100);
  const active = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]}` : "none";
  });
  await page.keyboard.type("zz");
  const query = await page.locator(".cmd-input").inputValue();
  console.log(
    `--- iteration ${info.repeatEachIndex} rafDelay=${rafDelay}: active after open=${active}, palette query=${JSON.stringify(query)}`,
  );
});
