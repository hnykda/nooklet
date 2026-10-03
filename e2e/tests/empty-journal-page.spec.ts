/**
 * B-595: a journal day with no page yet opens as an editable empty day — the journal stream's
 * draft — not as "This page doesn't exist yet / Create". Logseq does the same (see
 * docs/progress/empty-journal.md for the source citation).
 *
 * Real browser, real server: what matters is that typing into the day's own page creates the day
 * and its blocks on the server, that the caret stays in an editor across that creation (B-411's
 * swap, now on the page route), and that merely LOOKING at a date makes no page (ADR 024 keeps
 * journal days out of reference-minting; B-579 is what junk pages cost).
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, pagePath } from "../helpers/index.js";

/** The day's top-level block contents on the server, or `null` if it has no page. */
async function serverDay(page: Page, day: string): Promise<string[] | null> {
  try {
    const read = await api<{ tree?: { content: string }[] }>(page, "page.read", {
      page: day,
      format: "json",
    });
    return (read.tree ?? []).map((n) => n.content);
  } catch {
    return null;
  }
}

test("a date URL with no page is an editable day; viewing it makes no page, typing does (B-595)", async ({
  page,
}) => {
  // A day far in the past no other spec writes, different on every run of this test.
  const day = isoOffset(-(4000 + (Date.now() % 3000)));
  expect(await serverDay(page, day)).toBeNull();

  await page.goto(pagePath(day));
  const draft = page.locator(".page-view-draft .vr-draft-input");
  await expect(draft).toBeVisible();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("doesn't exist yet");

  // Viewing, focusing and leaving without typing writes nothing. Long enough for the client's
  // push debounce to have sent anything it had.
  await draft.focus();
  await page.goto("/journals");
  await page.waitForTimeout(1500);
  expect(await serverDay(page, day)).toBeNull();

  await page.goto(pagePath(day));
  await expect(draft).toBeVisible();
  await draft.fill("first on an empty day");
  await page.keyboard.press("Enter");
  // The caret goes on into the next row — the draft's own tree, not a swapped-in second one.
  await expect(page.locator(".page-view .cm-content")).toBeFocused();
  await page.keyboard.type("second on an empty day");

  await expect
    .poll(() => serverDay(page, day), { timeout: 15_000 })
    .toEqual(["first on an empty day", "second on an empty day"]);
  // Now a real journal day: the date is the title, and a reload shows the page, not a draft.
  await page.reload();
  await expect(page.locator(".vr-outliner").first()).toContainText("second on an empty day");
  await expect(page.locator(".page-view-draft")).toHaveCount(0);
});

test("today's heading opens an editable empty today in a fresh graph, and typing creates it (B-595)", async ({
  page,
  baseURL,
}) => {
  // A fresh graph: today on the shared default graph is written by other specs.
  const base = baseURL as string;
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const { dataDir } = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  const rootToken = readFileSync(join(dataDir, "root.token"), "utf8").trim();
  const slug = `ej-${Date.now()}`;
  const created = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ id: slug, label: slug }),
  });
  expect(created.status).toBe(201);
  const { token } = (await created.json()) as { token: string };
  const call = async (op: string, body: unknown) =>
    fetch(`${base}/g/${slug}/api/v1/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const pageNames = async () =>
    (
      (await (await call("page.list", { kind: "all" })).json()) as { items: { name: string }[] }
    ).items.map((p) => p.name);
  const today = isoOffset(0);

  await page.goto(`${base}/g/${slug}/journals`);
  const link = page.locator(".journal-day-today h2.journal-day-title a");
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/g/${slug}/page/${today}$`));
  const draft = page.locator(".page-view-draft .vr-draft-input");
  await expect(draft).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await pageNames()).not.toContain(today);

  await draft.click();
  await page.keyboard.type("typed on today's own page");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-view .cm-content")).toBeFocused();

  await expect
    .poll(
      async () => {
        const res = await call("page.read", { page: today, format: "json" });
        if (!res.ok) return null;
        return ((await res.json()) as { tree: { content: string }[] }).tree.map((n) => n.content);
      },
      { timeout: 15_000 },
    )
    // The Enter's new row is empty, and an empty block is still a block.
    .toEqual(["typed on today's own page", ""]);
  expect((await pageNames()).filter((n) => n === today)).toHaveLength(1);
});
