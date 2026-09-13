/**
 * B-520: a hybrid search that falls back to keyword says why, and "not set up" leads to the place
 * that sets it up.
 *
 * The owner saw "Fell back to keyword search. 4 results" and had to ask whether semantic search
 * worked at all. The reason comes from the real server (`search`'s `fallback`), and the button
 * raises the real shell-level Settings panel — neither exists in a unit test's world. A fresh e2e
 * graph has no embedding model, which is exactly the owner's state.
 */

import { expect, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test("a hybrid search on a graph with no embedding model says semantic search is not set up, and the button opens Settings at Search & embeddings", async ({
  page,
}) => {
  // The query word must be in no page name — this page's, or any other spec's: the e2e graph is
  // shared by the whole run, and "quokka" also matched search-cleared.spec's "Cleared Search
  // Quokka" page too, so the count below read 2 in every full-suite run (B-526).
  await seedPage(
    page,
    "Search Fallback Note Hit",
    "- a fallbacknotequokka sentence for the fallback note",
  );
  await page.goto("/search");
  await page.locator(".search-query-input").fill("fallbacknotequokka");
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });

  const note = page.locator(".search-fallback");
  await expect(note).toBeVisible({ timeout: 15_000 });
  // If this server could not load sqlite-vec, that — not "not set up" — is the true reason, and it
  // has its own sentence with nothing to click.
  const reason = await note.getAttribute("data-reason");
  test.skip(reason === "sqlite_vec_unavailable", "sqlite-vec did not load on this server");

  expect(reason).toBe("not_configured");
  await expect(note).toHaveText(
    "Fell back to keyword search: semantic search is not set up. Set up semantic search…",
  );
  // The keyword results are still there, under it.
  await expect(page.locator(".search-summary")).toHaveText("1 result");
  await expect(page.locator(".search-result", { hasText: "Search Fallback Note Hit" })).toHaveCount(
    1,
  );

  await note.getByRole("button", { name: "Set up semantic search…" }).click();

  const panel = page.locator(".set-panel");
  await expect(panel).toBeVisible();
  const section = panel.locator("#set-embeddings");
  await expect(section).toContainText("Semantic search", { timeout: 10_000 });
  await expect(section.getByRole("heading", { name: "Search & embeddings" })).toBeInViewport();
  await expect(section.getByRole("button", { name: /Turn on semantic search/ })).toBeVisible();
});

test("a keyword search shows no fallback note", async ({ page }) => {
  await seedPage(page, "Search Fallback Keyword Hit", "- a wombat sentence");
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill("wombat");
  await expect(page.locator(".search-summary")).toHaveText("1 result", { timeout: 15_000 });
  await expect(page.locator(".search-fallback")).toHaveCount(0);
});

test("closing Settings re-runs a search that had fallen back, so its note is not left stale (B-523)", async ({
  page,
}) => {
  await seedPage(page, "Search Fallback Stale Hit", "- a numbat sentence");
  await page.goto("/search");
  await page.locator(".search-query-input").fill("numbat");
  const note = page.locator(".search-fallback");
  await expect(note).toBeVisible({ timeout: 15_000 });
  test.skip(
    (await note.getAttribute("data-reason")) === "sqlite_vec_unavailable",
    "sqlite-vec did not load on this server",
  );

  await note.getByRole("button", { name: "Set up semantic search…" }).click();
  await expect(page.locator(".set-panel")).toBeVisible();
  // Whatever was changed in Settings, the note under it describes the server as it WAS. An e2e
  // server cannot actually turn embeddings on (no Ollama in CI), so the evidence is the request.
  const rerun = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/v1/search"),
    { timeout: 5_000 },
  );
  await page.locator(".set-close").click();
  await rerun;
  await expect(note).toBeVisible();
});

test("Try again and Check again keep keyboard focus on the pressed button when the same reason comes back (B-525)", async ({
  page,
}) => {
  // An e2e server has no embedding host, so the reasons that offer a retry cannot happen for real
  // here. The search itself runs against the real server; only its reply is rewritten into the
  // fallback, and each reply carries a new object with a new count — which is what a real
  // "still indexing" answer does. jsdom cannot catch this: it does not blur a focused element
  // that is moved by `insertBefore`, and a move is what a browser blurs on.
  await seedPage(page, "Search Fallback Focus Hit", "- a bilby sentence");
  let indexed = 0;
  let reason: "provider_unreachable" | "indexing" = "provider_unreachable";
  await page.route("**/api/v1/search", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    indexed += 1;
    const fallback =
      reason === "indexing"
        ? { reason, message: "…", indexed, total: 100, errors: 0 }
        : { reason, message: "…", host: "http://127.0.0.1:59999", error: `refused #${indexed}` };
    await route.fulfill({ response, json: { ...body, mode_used: "keyword", fallback } });
  });
  await page.goto("/search");
  await page.locator(".search-query-input").fill("bilby");
  const note = page.locator(".search-fallback");
  await expect(note).toHaveAttribute("data-reason", "provider_unreachable", { timeout: 15_000 });

  const retry = note.getByRole("button", { name: "Try again" });
  await retry.focus();
  const before = indexed;
  await page.keyboard.press("Enter");
  await expect(note.locator(".search-fallback-detail")).toHaveText(`(refused #${before + 1})`);
  await expect(retry).toBeFocused();

  reason = "indexing";
  await page.keyboard.press("Enter");
  await expect(note).toHaveAttribute("data-reason", "indexing");
  const check = note.getByRole("button", { name: "Check again" });
  // The reason changed and so did the button's label; the keyboard user is still on it.
  await expect(check).toBeFocused();
  const shown = indexed;
  await page.keyboard.press("Enter");
  await expect(note).toContainText(`(${shown + 1} of 100 embedded)`);
  await expect(check).toBeFocused();
});
