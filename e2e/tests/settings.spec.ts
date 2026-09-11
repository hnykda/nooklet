/**
 * The settings panel.
 *
 * Two failures this covers that a unit suite structurally cannot: `app.openSettings` was bound to
 * Cmd/Ctrl+, and navigated to a route that does not exist, so the shortcut opened a blank screen
 * and every test of the command still passed (the host method was called — it just did nothing
 * useful); and the embeddings section's whole purpose is to report what a real server says about a
 * real sqlite-vec and a real provider, which only exists in a served production build.
 *
 * The last test is the important one: a failed `embeddings.configure` has to end as a sentence on
 * screen. "Turn it on" sitting on "Testing connection…" forever is the exact shape of bug
 * `docs/BUGS.md` keeps recording.
 */
import { expect, test } from "@playwright/test";

/** The help menu's Settings item — the one pointer route in. */
async function openSettingsFromHelp(page: import("@playwright/test").Page): Promise<void> {
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
}

/**
 * Wait for the embeddings section to have answered.
 *
 * Every branch it can render says "Semantic search" — on, off, indexing, or "cannot run on this
 * server". Counting buttons before this resolves reads the "Checking…" state and silently answers
 * "no such button", which is how the two most important tests below quietly skipped themselves.
 */
async function settledEmbeddingsPanel(
  page: import("@playwright/test").Page,
): Promise<import("@playwright/test").Locator> {
  const panel = page.locator(".set-panel");
  await expect(panel).toContainText("Semantic search", { timeout: 10_000 });
  return panel;
}

test("opens from the help menu and shows all three sections", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);

  const panel = page.locator(".set-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Appearance");
  await expect(panel).toContainText("Search & embeddings");
  await expect(panel).toContainText("About");
});

test("opens from the app.openSettings keybinding", async ({ page }) => {
  await page.goto("/journals");
  // The binding this whole panel exists to give a destination to (Cmd+, / Ctrl+,).
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+,`);
  await expect(page.locator(".set-panel")).toBeVisible();
});

test("closes on backdrop click", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);
  await expect(page.locator(".set-panel")).toBeVisible();
  await page.locator(".set-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".set-panel")).toHaveCount(0);
});

test("the theme control actually changes data-theme", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);

  const root = page.locator("html");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", "light");

  // "System" resolves to one of the two rather than clearing the attribute — the stylesheet keys
  // off a concrete value, so an empty one would render an unthemed page.
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", /^(light|dark)$/);
});

test("the journal date format picker offers the presets and keeps a choice", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);

  // ADR 018's preference, owned by `data/page-title.ts`; this panel only renders the picker.
  const select = page.locator("#set-journal-format");
  await expect(select).toBeVisible();
  await select.selectOption("yyyy-MM-dd");
  await expect(select).toHaveValue("yyyy-MM-dd");

  // It is per-device state in localStorage, so it must survive a reload.
  await page.reload();
  await openSettingsFromHelp(page);
  await expect(page.locator("#set-journal-format")).toHaveValue("yyyy-MM-dd");
});

test("the embeddings section reports real backend state, not a spinner", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);

  const panel = await settledEmbeddingsPanel(page);
  await expect(panel).not.toContainText("Checking…");

  // Whichever state this server is in, it must say which one in words. A fresh e2e graph has no
  // model, so that is "Off" plus the offer to turn it on — unless sqlite-vec could not load, in
  // which case the panel must say semantic search cannot run at all and offer nothing.
  const text = (await panel.textContent()) ?? "";
  if (text.includes("sqlite-vec")) {
    await expect(panel).toContainText("cannot run on this server");
    await expect(page.getByRole("button", { name: /Turn on semantic search/ })).toHaveCount(0);
  } else {
    await expect(panel).toContainText("Off");
    await expect(page.getByRole("button", { name: /Turn on semantic search/ })).toBeVisible();
  }
});

test("a failed embeddings.configure shows a readable error, not a stuck button", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.route("**/api/v1/embeddings.configure", (route) => route.abort("failed"));
  await openSettingsFromHelp(page);

  const panel = await settledEmbeddingsPanel(page);
  const turnOn = page.getByRole("button", { name: /Turn on semantic search/ });
  // Nothing to test here if this server cannot do embeddings at all; that case has its own
  // assertion in the test above.
  test.skip((await turnOn.count()) === 0, "sqlite-vec did not load on this server");

  await turnOn.click();
  await expect(panel.locator("#set-host")).toHaveValue("http://127.0.0.1:11434");
  await expect(panel.locator("#set-model")).toHaveValue("bge-m3");

  await page.getByRole("button", { name: /Test connection/ }).click();

  // The point of the test: a sentence, in an alert, naming what failed.
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("Could not turn on semantic search", { timeout: 10_000 });
  // And the button comes back, rather than sitting on its busy label forever.
  await expect(page.getByRole("button", { name: "Test connection & enable" })).toBeEnabled();
});

test("a configure rejected by the server surfaces the server's own message", async ({ page }) => {
  await page.goto("/journals");
  await openSettingsFromHelp(page);

  const panel = await settledEmbeddingsPanel(page);
  const turnOn = page.getByRole("button", { name: /Turn on semantic search/ });
  test.skip((await turnOn.count()) === 0, "sqlite-vec did not load on this server");
  await turnOn.click();

  // Nothing listens on port 1, so this is the real "Ollama isn't running" path through the real
  // op — the error text and its hint come from `packages/server/src/ops/embeddings.ts`.
  await page.locator("#set-host").fill("http://127.0.0.1:1");
  await page.getByRole("button", { name: /Test connection/ }).click();

  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("Could not reach", { timeout: 15_000 });
  await expect(alert).toContainText("ollama serve");
});
