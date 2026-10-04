/**
 * B-642 / ADR 027, the owner's first real-device test: one block rewritten on two devices, one of
 * them offline. Both texts must end up readable on both devices — the winner in place, the other
 * device's text as its own block right after it with a "sync conflict" badge — instead of a
 * `conflict_copy:` property chip under the winner.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  clickAway,
  editor,
  pagePath,
  readBlocks,
  runName,
  seedPage,
} from "../helpers/index.js";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function rewriteFirstBlock(page: Page, text: string): Promise<void> {
  await page.locator(".vr-outliner .vr-row").first().locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.type(text, { delay: 20 });
  await clickAway(page);
}

/** What a person sees on the page: each row's rendered text, and whether it wears the badge. */
async function rows(page: Page): Promise<Array<{ text: string; conflict: boolean }>> {
  return page.locator(".vr-outliner .vr-row").evaluateAll((els) =>
    els.map((el) => ({
      text: (
        el.querySelector(".vr-block-view .vr-block-content, .vr-block-view")?.textContent ?? ""
      )
        .replace("sync conflict", "")
        .trim(),
      conflict: el.querySelector(".vr-prop-conflict") !== null,
    })),
  );
}

test("a block rewritten on an offline device and an online one keeps both texts, readable on both", async ({
  browser,
}, info) => {
  const name = runName("Sync Conflict", info);
  const offlineCtx = await browser.newContext();
  const onlineCtx = await browser.newContext();
  try {
    const a = await offlineCtx.newPage();
    const b = await onlineCtx.newPage();
    await seedPage(b, name, "- Something\n- the next block");
    for (const p of [a, b]) {
      await p.goto(pagePath(name));
      await expect(p.locator(".vr-outliner .vr-row")).toHaveCount(2);
    }

    // A goes offline and rewrites the block; its write stays in its outbox.
    await offlineCtx.setOffline(true);
    await rewriteFirstBlock(a, "There is this");
    await a.waitForTimeout(800);

    // B rewrites the same block later, online — the newer edit, so B's text wins.
    await rewriteFirstBlock(b, "Nothing");
    await expect
      .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 10_000 })
      .toEqual(["Nothing", "the next block"]);

    // A comes back.
    await offlineCtx.setOffline(false);
    await a.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 20_000 })
      .toEqual(["Nothing", "There is this", "the next block"]);
    const read = await api<{
      tree: Array<{ content: string; properties?: Record<string, string> }>;
    }>(b, "page.read", { page: name, format: "json" });
    expect(read.tree.map((n) => n.properties ?? {})).toEqual([{}, { "sync-conflict": "true" }, {}]);

    // Both devices show it the same way: no conflict_copy chip, one badge on the other text.
    const want = [
      { text: "Nothing", conflict: false },
      { text: "There is this", conflict: true },
      { text: "the next block", conflict: false },
    ];
    for (const p of [a, b]) {
      await expect.poll(() => rows(p), { timeout: 20_000 }).toEqual(want);
      await expect(p.locator('.vr-prop[data-key="conflict_copy"]')).toHaveCount(0);
    }
  } finally {
    await offlineCtx.close();
    await onlineCtx.close();
  }
});

/**
 * B-652: the same, with the returning device's pull responses held back 1.5 s while its push goes
 * straight through — so its push response is applied first, the order that used to delete its
 * own edit from the outbox before the other device's edit arrived, and LWW then dropped one text
 * with no copy. Both ways round: the returning device's text losing LWW, and winning it.
 */
for (const returningWins of [false, true]) {
  test(`a reconnecting device whose push response lands before its pull keeps both texts (B-652, its text ${returningWins ? "wins" : "loses"})`, async ({
    browser,
  }, info) => {
    const name = runName(`Sync Race ${returningWins ? "Wins" : "Loses"}`, info);
    const offlineCtx = await browser.newContext();
    const onlineCtx = await browser.newContext();
    try {
      const a = await offlineCtx.newPage();
      const b = await onlineCtx.newPage();
      await seedPage(b, name, "- Something\n- the next block");
      for (const p of [a, b]) {
        await p.goto(pagePath(name));
        await expect(p.locator(".vr-outliner .vr-row")).toHaveCount(2);
      }

      await offlineCtx.setOffline(true);
      const [aText, bText] = ["There is this", "Nothing"];
      // Whoever edits later has the newer HLC and wins LWW.
      if (returningWins) {
        await rewriteFirstBlock(b, bText);
        await expect
          .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 10_000 })
          .toEqual([bText, "the next block"]);
        await rewriteFirstBlock(a, aText);
        await a.waitForTimeout(800);
      } else {
        await rewriteFirstBlock(a, aText);
        await a.waitForTimeout(800);
        await rewriteFirstBlock(b, bText);
        await expect
          .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 10_000 })
          .toEqual([bText, "the next block"]);
      }

      // The server answers A's pulls at once; A gets the answer 1.5 s later.
      await offlineCtx.route("**/sync/pull**", async (route) => {
        const response = await route.fetch();
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ response });
      });
      await offlineCtx.setOffline(false);
      await a.evaluate(() => window.dispatchEvent(new Event("online")));

      const [winner, loser] = returningWins ? [aText, bText] : [bText, aText];
      await expect
        .poll(async () => (await readBlocks(b, name)).map((x) => x.content), { timeout: 20_000 })
        .toEqual([winner, loser, "the next block"]);
      const want = [
        { text: winner, conflict: false },
        { text: loser, conflict: true },
        { text: "the next block", conflict: false },
      ];
      for (const p of [a, b]) {
        await expect.poll(() => rows(p), { timeout: 20_000 }).toEqual(want);
      }
    } finally {
      await offlineCtx.close();
      await onlineCtx.close();
    }
  });
}
