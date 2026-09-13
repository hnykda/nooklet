/**
 * Web-client reactivity and failure-path defects from the 2026-09-13 review
 * (`docs/review/2026-09-13-m7-rv-web-reactivity.md`), each driven the way it was found: through
 * the real app, a real server and a production build. Unit tests pin the mechanisms; these pin
 * what a person sees.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, openPage, pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.locator(".app-sidebar");
  if ((await sidebar.count()) === 0) {
    await page.locator("button[aria-label='Toggle sidebar']").click();
  }
  await expect(sidebar).toBeVisible();
}

test("after visiting Trash, an open page still picks up a write made elsewhere (B-130)", async ({
  page,
}) => {
  await seedPage(page, "Reactive After Trash", "- before trash");
  await page.goto(pagePath("Reactive After Trash"));
  await expect(page.locator(".vr-outliner").first()).toContainText("before trash");

  // In-app navigation, never `goto`: a reload re-wires every listener and hides the defect, which
  // lived exactly as long as the tab did.
  await openSidebar(page);
  await page.locator(".app-sidebar .sidebar-nav a[href='/trash']").click();
  await expect(page.locator(".trash-view h1")).toContainText("Trash");
  await page.goBack();
  await expect(page.locator(".vr-outliner").first()).toContainText("before trash");

  // A write from another client (an agent over the API) reaches this replica as a pull; the page
  // tree must refetch on it.
  const [first] = await readBlocks(page, "Reactive After Trash");
  await api(page, "block.update", {
    id: first?.id,
    old_str: "before trash",
    new_str: "after trash",
  });
  await expect(page.locator(".vr-outliner").first()).toContainText("after trash", {
    timeout: 15_000,
  });
});

test("a failed trash load says so and Retry recovers, instead of Loading… forever (B-131)", async ({
  page,
}) => {
  await page.route("**/api/v1/trash.list", (route) => route.abort("failed"));
  await page.goto("/trash");
  const error = page.locator(".trash-error[role='alert']");
  await expect(error).toContainText("Could not load the trash", { timeout: 15_000 });
  await expect(page.locator(".trash-empty", { hasText: "Loading…" })).toHaveCount(0);

  await page.unroute("**/api/v1/trash.list");
  await error.locator(".trash-retry").click();
  await expect(error).toHaveCount(0);
  await expect(page.locator(".trash-count")).toBeVisible();
});

test("a failed history load says so and Retry recovers, instead of Loading… forever (B-131)", async ({
  page,
}) => {
  await seedPage(page, "History Load Fails", "- one");
  await page.route("**/api/v1/page.history", (route) => route.abort("failed"));
  await page.goto("/history/History%20Load%20Fails");
  const error = page.locator(".history-error[role='alert']");
  await expect(error).toContainText("Could not load the history", { timeout: 15_000 });
  await expect(page.locator(".history-empty", { hasText: "Loading…" })).toHaveCount(0);

  await page.unroute("**/api/v1/page.history");
  await error.locator(".history-retry").click();
  await expect(error).toHaveCount(0);
  await expect(page.locator(".history-batch")).toHaveCount(1);
});

test("History lists every batch when the graph changes while Older changes is loading (B-132)", async ({
  page,
}) => {
  const name = "History Paging Race";
  // 31 batches: the view asks for 25 at a time, so there is exactly one older page.
  await seedPage(page, name, "- zero");
  for (let i = 1; i <= 30; i++) await api(page, "page.append", { page: name, markdown: `- ${i}` });

  // Hold the "older than" request (the one with a cursor) until the test lets it go.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let olderRequested = false;
  await page.route("**/api/v1/page.history", async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string };
    if (body.cursor !== undefined) {
      olderRequested = true;
      await held;
    }
    await route.continue();
  });

  await page.goto(`/history/${encodeURIComponent(name)}`);
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(25);
  await page.locator(".history-more").click();
  await expect.poll(() => olderRequested).toBe(true);

  // Two writes land while it is held; the first page refetches and shows the newest on top.
  await api(page, "page.append", { page: name, markdown: "- late 1" });
  const late = await api<{ batch_id: string }>(page, "page.append", {
    page: name,
    markdown: "- late 2",
  });
  await expect(batches.first()).toHaveAttribute("data-batch-id", late.batch_id, {
    timeout: 15_000,
  });

  release();
  // Page on until there is nothing older. (Whether the held answer is used or dropped is the
  // implementation's business; what is listed at the end is what this test is about.)
  const more = page.locator(".history-more");
  await expect(async () => {
    // Non-waiting reads: the button may vanish between two calls, and an auto-waiting
    // `textContent()` on a vanished element would block this retry loop until the test times out.
    if ((await more.allTextContents()).includes("Older changes")) {
      await more.click({ timeout: 1_000 }).catch(() => {});
    }
    await expect(more).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // Every batch the server has for the page, in order, none missing.
  const all = await api<{ batches: Array<{ batch_id: string }> }>(page, "page.history", {
    page: name,
    limit: 100,
  });
  const listed = await batches.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-batch-id")),
  );
  expect(listed).toEqual(all.batches.map((b) => b.batch_id));
  expect(listed).toHaveLength(33);
});

test("a query hit nested past the 60 rendered descendants of another hit is still shown (B-133)", async ({
  page,
}) => {
  // A project task with more notes under it than a result renders, then a subtask. The tag keeps
  // other specs' tasks on the shared server out of the result.
  const notes = Array.from({ length: 70 }, (_, i) => `  - note ${i}`);
  await seedPage(
    page,
    "Capped Project",
    ["- TODO the project #capcheck", ...notes, "  - TODO the late subtask #capcheck"].join("\n"),
  );
  const outliner = await openPage(page, "Capped Query", "- ```query\n  TODO tag:capcheck\n  ```");
  const view = outliner.locator(".vr-query");
  await expect(view.locator(".vr-query-count")).toHaveText("2 blocks on 1 page");
  await expect(view.locator(".vr-query-hit", { hasText: "the late subtask" })).toHaveCount(1);
});

test("a failed Older changes says so instead of silently re-enabling the button (B-131)", async ({
  page,
}) => {
  const name = "History Older Fails";
  // 26 batches: one more than the first page holds.
  await seedPage(page, name, "- zero");
  for (let i = 1; i <= 25; i++) await api(page, "page.append", { page: name, markdown: `- ${i}` });

  await page.route("**/api/v1/page.history", async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string };
    if (body.cursor !== undefined) await route.abort("failed");
    else await route.continue();
  });
  await page.goto(`/history/${encodeURIComponent(name)}`);
  await expect(page.locator(".history-batch")).toHaveCount(25);
  await page.locator(".history-more").click();
  await expect(page.locator(".history-error[role='alert']")).toContainText(
    "Could not load older changes",
  );
  await expect(page.locator(".history-more")).toBeEnabled();

  await page.unroute("**/api/v1/page.history");
  await page.locator(".history-more").click();
  await expect(page.locator(".history-batch")).toHaveCount(26);
  await expect(page.locator(".history-error")).toHaveCount(0);
});

test("Replace all pressed right after editing the replacement writes the edited text (B-134)", async ({
  page,
}) => {
  // A word no other spec seeds: popups.spec and replace-stale.spec leave "quokka…" blocks on the
  // shared server earlier in a full run, and a graph-wide replace counts those too.
  await seedPage(page, "Replace Race", "- the zorillo smiles");
  await page.goto("/replace");
  await page.locator(".replace-query").fill("zorillo");
  await page.locator(".replace-replacement").fill("wombat");
  await expect(page.locator(".replace-after").first()).toContainText("wombat");
  await expect(page.locator(".replace-all")).toBeEnabled();

  // Edit and press at once — well inside the preview's 250 ms debounce.
  await page.locator(".replace-replacement").fill("numbat");
  await page.locator(".replace-all").click();

  await expect(page.locator(".replace-outcome")).toHaveText("Replaced 1 occurrence in 1 block.");
  const blocks = await readBlocks(page, "Replace Race");
  expect(blocks.map((b) => b.content)).toEqual(["the numbat smiles"]);
});
