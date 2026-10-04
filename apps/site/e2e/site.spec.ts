import { expect, type Page, test } from "@playwright/test";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function noHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

test("landing renders with screenshots, landmarks and no sideways scroll", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your notes");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  const shot = page.locator("img.theme-img--light").first();
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("sync animations advance on their own", async ({ page }) => {
  await page.goto("/");
  const fig = page.locator('figure[data-figure="sync-op"]');
  await fig.scrollIntoViewIfNeeded();
  await expect(fig).toHaveAttribute("data-playing", "true");
  const first = await fig.getAttribute("data-step");
  await expect.poll(() => fig.getAttribute("data-step"), { timeout: 8_000 }).not.toBe(first);
  // An op dot appears on a wire at some point while it plays.
  await expect(fig.locator(".op").first()).toBeAttached({ timeout: 10_000 });
});

test("under reduced motion the figures hold their end state", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (const name of ["sync-op", "sync-converge", "sync-merge"]) {
    const fig = page.locator(`figure[data-figure="${name}"]`);
    await fig.scrollIntoViewIfNeeded();
    await expect(fig).toHaveAttribute("data-playing", "false");
    await expect(fig).toHaveAttribute("data-reduced", "true");
  }
  const op = page.locator('figure[data-figure="sync-op"]');
  const step = await op.getAttribute("data-step");
  expect(step).toBe("7"); // the last of eight steps
  await page.waitForTimeout(3_000);
  await expect(op).toHaveAttribute("data-step", step ?? "");
  await expect(page.locator(".op")).toHaveCount(0);
  // The step buttons still work.
  await op.getByRole("button", { name: "Previous step" }).click();
  await expect(op).toHaveAttribute("data-step", "6");
});

test("docs navigation: index, sidebar, page, TOC and markdown link", async ({ page, isMobile }) => {
  const errors = trackErrors(page);
  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1, name: "Docs" })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL(/\/docs\/how-it-works$/);
  await expect(page.getByRole("heading", { level: 1, name: "How it works" })).toBeVisible();
  // The three animation-spec fences in how-it-works.md render as live figures.
  await expect(page.locator("figure[data-figure]")).toHaveCount(3);
  await expect(page.locator(".anim-pending")).toHaveCount(0);
  // Highlighted code.
  await expect(page.locator("pre.shiki").first()).toBeVisible();

  if (isMobile) {
    await page.getByText("Docs pages").click();
  }
  const sidebar = page.getByRole("complementary", { name: "Documentation" });
  await sidebar.getByRole("link", { name: "Security model" }).click();
  await expect(page).toHaveURL(/\/docs\/security$/);
  await expect(page.getByRole("heading", { level: 1, name: "Security model" })).toBeVisible();

  if (!isMobile) {
    const toc = page.getByRole("navigation", { name: "On this page" });
    const firstEntry = toc.getByRole("link").first();
    const href = await firstEntry.getAttribute("href");
    await firstEntry.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  }
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("search finds a term from the keyboard and opens the hit", async ({ page, isMobile }) => {
  await page.goto("/docs");
  if (isMobile) {
    await page.getByRole("button", { name: "Search the docs" }).click();
  } else {
    await page.keyboard.press("ControlOrMeta+k");
  }
  const input = page.getByRole("combobox", { name: "Search query" });
  await expect(input).toBeFocused();
  await input.fill("fractional");
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  await expect(options.first()).toContainText(/fractional/i);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/(docs|decisions)\//);
  await expect(page.locator("main")).toContainText(/fractional/i);
});

test("llms.txt, llms-full.txt and a page's .md twin are served", async ({ request }) => {
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["content-type"]).toContain("text/plain");
  const text = await llms.text();
  expect(text.startsWith("# nooklet\n\n> ")).toBe(true);
  const link = /\((https:\/\/nooklet\.danielalder\.cz(\/docs\/[^)]+\.md))\)/.exec(text);
  expect(link, "llms.txt links to .md pages").not.toBeNull();

  const md = await request.get(link?.[2] ?? "");
  expect(md.status()).toBe(200);
  expect(md.headers()["content-type"]).toContain("text/markdown");
  expect(await md.text()).toMatch(/^# .+\n\n> /);

  const full = await request.get("/llms-full.txt");
  expect(full.status()).toBe(200);
  expect((await full.text()).length).toBeGreaterThan(text.length * 5);

  const sitemap = await request.get("/sitemap.xml");
  expect(await sitemap.text()).toContain("https://nooklet.danielalder.cz/docs/how-it-works");
  const og = await request.get("/og.png");
  expect(og.headers()["content-type"]).toBe("image/png");
});

test("an unknown path gets the 404 page", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("does not exist");
});

test("the theme toggle switches and remembers", async ({ page }) => {
  await page.goto("/");
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after).not.toBe(before);
  await page.reload();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(after);
});
