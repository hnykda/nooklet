/**
 * B-560: a journal day's date heading in the stream opens that day's own page, as in Logseq.
 *
 * Real browser, real server, real router: what matters here is that the link is a real router
 * link (a click does not reload), that its URL carries ADR 025's `/g/<slug>` prefix exactly once
 * (B-586 was a prefix bug that only showed against a second graph), and that a day with no page
 * yet — today, before its first block — still lands somewhere sensible rather than a dead end.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

function isoOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The visible page title — PageView also renders a print-only `h1` that is display:none. */
const pageTitle = (page: Page) => page.getByRole("heading", { level: 1 });

test("clicking an earlier day's heading opens that day's page (B-560)", async ({ page }) => {
  await page.goto("/journals");
  const day = isoOffset(-4);
  const text = `heading-link earlier ${Date.now()}`;
  await api(page, "page.append", { page: day, markdown: `- ${text}` });
  await page.goto("/journals");

  const section = page.locator(".journal-day", { hasText: text });
  const link = section.locator("h2.journal-day-title a");
  await expect(link).toBeVisible();
  const title = (await link.textContent())?.trim() ?? "";

  // Looks like the heading, not a browser-default link.
  const [linkStyle, headingColor] = await link.evaluate((a) => {
    const s = getComputedStyle(a);
    return [
      { color: s.color, decoration: s.textDecorationLine },
      getComputedStyle(a.parentElement as HTMLElement).color,
    ];
  });
  expect(linkStyle.decoration).toBe("none");
  expect(linkStyle.color).toBe(headingColor);

  // A router navigation, not a reload: a marker on window survives it.
  await page.evaluate(() => {
    (window as unknown as { __b560?: boolean }).__b560 = true;
  });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/page/${day}$`));
  await expect(pageTitle(page)).toHaveText(title);
  await expect(page.locator(".vr-outliner").first()).toContainText(text);
  expect(await page.evaluate(() => (window as unknown as { __b560?: boolean }).__b560)).toBe(true);
});

test("today's heading opens today's page from the keyboard, page or no page yet (B-560)", async ({
  page,
}) => {
  await page.goto("/journals");
  const link = page.locator(".journal-day-today h2.journal-day-title a");
  await expect(link).toBeVisible();
  // "<date> · Today" — the page's own title is just the date.
  const heading = (await link.textContent()) ?? "";
  const date = heading.replace(/\s*·\s*Today\s*$/, "").trim();

  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/page/${isoOffset(0)}$`));
  // Today may or may not have blocks on this shared server; either way the page names the day.
  await expect(pageTitle(page)).toHaveText(date);
});

test("under a non-default graph's /g/<slug> prefix the heading keeps that prefix, once (B-560, B-586)", async ({
  page,
  baseURL,
}) => {
  const base = baseURL as string;
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const { dataDir } = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  const rootToken = readFileSync(join(dataDir, "root.token"), "utf8").trim();
  const slug = `hl-${Date.now()}`;
  const res = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ id: slug, label: slug }),
  });
  expect(res.status).toBe(201);

  await page.goto(`${base}/g/${slug}/journals`);
  const link = page.locator(".journal-day-today h2.journal-day-title a");
  await expect(link).toBeVisible({ timeout: 15_000 });
  expect(await link.getAttribute("href")).toBe(`/g/${slug}/page/${isoOffset(0)}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/g/${slug}/page/${isoOffset(0)}$`));
  await expect(pageTitle(page)).toBeVisible();
});
