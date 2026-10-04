/**
 * Proposal 006 Phase 1 / ADR 033: `/capture?text=…&url=…&title=…` is where every
 * `nooklet://capture` link, quick action and Android share ends up. Its contract:
 * - it only PRE-FILLS: nothing is written until the person taps Save (a link is untrusted);
 * - Save writes exactly one block at the end of today's journal, formatted as the text,
 *   `[title](url)`, or the bare URL;
 * - Cancel writes nothing;
 * - on a device with no graph yet, the screen says so and keeps the text.
 */
import { expect, type Page, test } from "@playwright/test";
import { capacitorContext, marker } from "../helpers/graph-mismatch.js";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

const input = (page: Page) => page.getByPlaceholder("Capture a thought…");

async function todayContents(page: Page): Promise<string[]> {
  return (await readBlocks(page, isoOffset(0)).catch(() => [])).map((b) => b.content);
}

/** Today's blocks as the server sees them once this page's writes have been pushed. */
async function expectTodayToContainOnce(page: Page, content: string): Promise<void> {
  await expect
    .poll(async () => (await todayContents(page)).filter((c) => c === content).length, {
      timeout: 15_000,
    })
    .toBe(1);
}

test("a text link pre-fills, writes nothing on its own, and Save adds one block to today", async ({
  page,
}) => {
  const text = `walk the dog ${marker("cap")}`;
  await page.goto(`/capture?text=${encodeURIComponent(text)}`);
  await expect(input(page)).toHaveValue(text);

  // Untrusted link: opening it must not write. Give a stray write time to reach the server.
  await page.waitForTimeout(1_500);
  expect((await todayContents(page)).some((c) => c.includes(text))).toBe(false);

  await page.getByRole("button", { name: "Save to journal" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved to today's journal.");
  await expectTodayToContainOnce(page, text);
  // The prefill is gone from the address, so a reload cannot offer the same text again.
  await expect(page).toHaveURL(/\/capture$/);
});

test("a link with a title becomes [title](url) at the end of today's journal", async ({ page }) => {
  const m = marker("lnk");
  const url = `https://example.com/articles/${m}`;
  const title = `An article ${m}`;
  // Something already on today, so "at the end" means something.
  await api(page, "page.append", { page: isoOffset(0), markdown: `- before ${m}` });
  await page.goto(`/capture?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`);
  const expected = `[${title}](${url})`;
  await expect(input(page)).toHaveValue(expected);
  await page.getByRole("button", { name: "Save to journal" }).click();
  await expectTodayToContainOnce(page, expected);
  const contents = await todayContents(page);
  expect(contents.at(-1)).toBe(expected);
  expect(contents.indexOf(`before ${m}`)).toBeLessThan(contents.indexOf(expected));
});

test("a bare URL is captured as the URL", async ({ page }) => {
  const url = `https://example.com/${marker("bare")}`;
  await page.goto(`/capture?url=${encodeURIComponent(url)}`);
  await expect(input(page)).toHaveValue(url);
  await page.getByRole("button", { name: "Save to journal" }).click();
  await expectTodayToContainOnce(page, url);
});

test("Cancel discards a pre-filled capture and writes nothing", async ({ page }) => {
  const text = `never saved ${marker("cxl")}`;
  await page.goto(`/capture?text=${encodeURIComponent(text)}`);
  await expect(input(page)).toHaveValue(text);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/journals/);
  await expect(page.locator(".journal-day-today")).toBeVisible();
  await page.waitForTimeout(1_500);
  expect((await todayContents(page)).some((c) => c.includes(text))).toBe(false);
});

test("first launch on the phone: no graph yet, the capture screen says so and keeps the text", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const ctx = await capacitorContext(browser, base);
  // `capacitorContext` serves the app shell for `/` and `/journals`; a capture link lands on
  // `/capture`, so serve the same shell there.
  await ctx.route(
    (url) => url.origin === new URL(base).origin && url.pathname === "/capture",
    async (route) => {
      const shell = await route.fetch({ url: `${base}/g/default/journals` });
      await route.fulfill({ response: shell });
    },
  );
  const page = await ctx.newPage();
  const text = `first launch thought ${marker("ng")}`;
  await page.goto(`/capture?text=${encodeURIComponent(text)}`);
  await expect(input(page)).toHaveValue(text);
  await expect(page.getByText(/no graph on this device yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save to journal" })).toHaveCount(0);

  // The text survives the app being closed and reopened without the link.
  await page.goto("/capture");
  await expect(input(page)).toHaveValue(text);

  // "Set up a graph" leaves for the set-up screen.
  await page.getByRole("button", { name: "Set up a graph" }).click();
  await expect(page.getByText("Just this device")).toBeVisible();
  await ctx.close();
});
