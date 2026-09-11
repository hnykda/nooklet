/**
 * Journal addressing and the journal stream.
 *
 * The bugs here all came from the same place: a journal day has a *day number*, but its page used
 * to be stored under whatever title format the graph was written with ("Mon, 07.09.2026" in a
 * Logseq graph using that pattern), while search results and block references hand out the ISO
 * date. ADR 018 closed that gap by storing the ISO name and making the format a display setting;
 * the tests below are what stops it reopening.
 */

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

/** The ISO date `offsetDays` from today — how journals are addressed through the API
 * (`journalDayFromWire`) and, since ADR 018, how the page itself is named. */
function isoOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

test("a journal page is reachable by ISO date even when stored under another title format", async ({
  page,
}) => {
  await page.goto("/journals");
  const past = isoOffset(-3);
  // `page.append` is the only way to create a journal day (page.create refuses them).
  await api(page, "page.append", { page: past, markdown: "- written three days ago" });

  // Exactly what a search result links to.
  await page.goto(`/page/${encodeURIComponent(past)}`);
  await expect(page.locator("body")).not.toContainText("doesn't exist yet");
  await expect(page.locator(".vr-outliner").first()).toContainText("written three days ago");
});

test("a future journal day appears in the stream, above today", async ({ page }) => {
  await page.goto("/journals");
  const future = isoOffset(1);
  await api(page, "page.append", { page: future, markdown: "- scheduled for tomorrow" });

  await page.goto("/journals");
  const upcoming = page.locator(".journal-day-upcoming");
  await expect(upcoming).toHaveCount(1);
  await expect(upcoming).toContainText("scheduled for tomorrow");

  // Ordering: newest first, so tomorrow sits above today.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".journal-day")].map((el) => el.className),
  );
  const upcomingIndex = order.findIndex((c) => c.includes("journal-day-upcoming"));
  const todayIndex = order.findIndex((c) => c.includes("journal-day-today"));
  expect(upcomingIndex).toBeGreaterThanOrEqual(0);
  expect(upcomingIndex).toBeLessThan(todayIndex);
});

test("clicking a search result opens the page it came from", async ({ page }) => {
  await page.goto("/journals");
  const day = isoOffset(-5);
  await api(page, "page.append", { page: day, markdown: "- findable journal content" });

  await page.goto("/search");
  await page.locator(".search-query-input").fill("findable journal content");
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });
  await page.locator(".search-result-open").first().click();

  // The regression: this landed on "This page doesn't exist yet."
  await expect(page.locator("body")).not.toContainText("doesn't exist yet");
  await expect(page.locator(".vr-outliner").first()).toContainText("findable journal content");
});

test("a journal is stored under its ISO name and found by every way of writing that date", async ({
  page,
}) => {
  await page.goto("/journals");
  const day = isoOffset(-7);
  await api(page, "page.append", { page: day, markdown: "- a week ago" });

  // ADR 018: the stored name is the ISO date, not a display format.
  const read = (await api(page, "page.read", { page: day })) as { page: { name: string } };
  expect(read.page.name).toBe(day);

  // And a block that links to that day in a *human* format still lands in its backlinks, because
  // the reference index canonicalises — this is the half of ADR 018 that is easy to forget.
  const [y, m, d] = day.split("-");
  const human = `${d}.${m}.${y}`;
  await api(page, "page.append", {
    page: "Cross Format Refs",
    markdown: `- looking back at [[${human}]]`,
  });

  const backlinks = (await api(page, "page.backlinks", { target: day })) as {
    linked: Array<{ page: string; text: string }>;
  };
  expect(backlinks.linked.map((l) => l.page)).toContain("Cross Format Refs");
});
