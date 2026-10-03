/**
 * The autocomplete opened by walking the caret INTO an existing `[[link]]` (B-203's precondition).
 * Picking a row replaced only the text between the trigger and the caret, so the rest of the old
 * link stayed behind the new one: `alpha [[Target]]arget]] omega` (B-294). A pick now replaces the
 * whole link it sits in. (`#tag` is not covered — B-380.) Page names start with "Walkin" or "Caret
 * Inside Src" — never "Link Target", which `link-unlinked.spec.ts` counts as
 * a mention on the shared server.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, openEditing, readBlocks, seedPage } from "../helpers/index.js";

async function walkTo(page: Page, offset: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let i = 0; i < offset; i++) await page.keyboard.press("ArrowRight");
}

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("Enter on the autocomplete a walk into a complete [[link]] opened keeps one link (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  const name = "Caret Inside Src One";
  await openEditing(page, name, "- alpha [[Walkin Goal Page]] omega");
  await walkTo(page, "alpha [[Walkin Go".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Goal Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  // The caret lands after the link's `]]`, not inside what was its tail.
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walkin Goal Page]]! omega"]);
});

test("typing inside an existing link and picking another page replaces the whole link (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  await seedPage(page, "Walkin Other Page", "- there");
  const name = "Caret Inside Src Two";
  await openEditing(page, name, "- alpha [[Walkin Goal Page]] omega");
  await walkTo(page, "alpha [[Walkin ".length);
  await page.keyboard.type("Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Other Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walkin Other Page]] omega"]);
});

test("a new [[ typed right before an existing link leaves that link alone (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  await seedPage(page, "Walkin Other Page", "- there");
  const name = "Caret Inside Src Three";
  await openEditing(page, name, "- see [[Walkin Goal Page]]");
  await walkTo(page, "see ".length);
  await page.keyboard.type("[[Walkin Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Other Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect
    .poll(() => stored(page, name))
    .toEqual(["see [[Walkin Other Page]][[Walkin Goal Page]]"]);
});

// The "New page" row is the text of the link, not the text before the caret. Replacing through the
// `]]` with only the query deleted the rest of the name and created a page named after the
// fragment: `alpha [[Walkin Unm]] omega`, plus a page "Walkin Unm" (B-382). A link to a page that
// does not exist yet is ordinary, and before the pages list has loaded the "New page" row is the
// only row even for one that does — so a stray Enter there must leave the link as it was.
//
// Since ADR 024 the server (and, B-568, the client) mints a page for every link it stores, so
// seeding the link alone no longer leaves its page missing: the popup offered the real page, not
// "New page" (B-592). Trashing it does not help either — a still-referenced page is minted again
// (`ref-pages.ts`). The one stored state left where a link's page does not exist is a link naming
// another page's ALIAS: the server mints no page for it, and the popup's "New page" check
// compares titles only, so the row is offered. (Whether "New page" should be offered for an alias
// name at all is its own question — if that changes, this test needs another missing-page state.)
test("Enter on New page inside a link to a page that does not exist keeps the whole link (B-382)", async ({
  page,
}) => {
  // Names of this run's own: the test's last Enter CREATES the alias's page, so a second run
  // (`--repeat-each`, a retry) found "Walkin Unmade Page" already there and failed at the first
  // check — B-624's flake in this spec. The walk stops partway into the tag, as it used to stop
  // partway into "Unmade".
  const tag = runTag();
  const name = `Caret Inside Src Four ${tag}`;
  const unmade = `Walkin Unmade ${tag} Page`;
  const fragment = `Walkin Unmade ${tag.slice(0, 1)}`;
  await api(page, "page.create", {
    name: `Walkin Alias Holder ${tag}`,
    if_exists: "return",
    properties: { alias: unmade },
    markdown: "- holder",
  });
  await seedPage(page, name, `- alpha [[${unmade}]] omega`);
  expect(await pageNames(page)).not.toContain(unmade);
  await openEditing(page, name);
  await walkTo(page, `alpha [[${fragment}`.length);
  const popup = page.locator(".cmd-popup");
  // The row names the whole link, not the fragment before the caret — B-382's fix, visible.
  const create = popup.locator(".cmd-row", { hasText: `New page "${unmade}"` });
  await expect(create).toHaveCount(1);
  // Ranking may put fuzzy page matches (other "Walkin …" pages, earlier runs' "Walkin Unmade …")
  // first; walk to the row. Bounded by the rows on offer, not a fixed 10: each run adds two
  // rows above it, and the sixth run under --repeat-each had eleven.
  const rows = await popup.locator(".cmd-row").count();
  for (let i = 0; i <= rows; i++) {
    if (await create.evaluate((el) => el.classList.contains("cmd-row--active"))) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(create).toHaveClass(/cmd-row--active/);
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual([`alpha [[${unmade}]]! omega`]);
  // No page named after the fragment was created.
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced");
  expect(await pageNames(page)).not.toContain(fragment);
});

/** "aa", "ab", … — one per repeat and retry. */
function runTag(): string {
  const info = test.info();
  const n = info.repeatEachIndex * 4 + info.retry;
  return String.fromCharCode(97 + (Math.floor(n / 26) % 26)) + String.fromCharCode(97 + (n % 26));
}

async function pageNames(page: Page): Promise<string[]> {
  const out = await api<{ items: Array<{ name: string }> }>(page, "page.list", {
    prefix: "Walkin",
  });
  return out.items.map((p) => p.name);
}

// B-384: the row Enter takes on a walk-in was ranked by the fragment before the caret, so a shorter
// page name — or, with nothing before the caret, today's date — came first, and the B-294 pick
// through `]]` then re-pointed the link without anything on screen looking wrong.
test("Enter on the autocomplete a walk into a link opened keeps the link's page, not a shorter name (B-384)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Pat", "- short");
  await seedPage(page, "Walkin Patio", "- other");
  await seedPage(page, "Walkin Pat Novak", "- long");
  const name = "Caret Inside Src Five";
  await openEditing(page, name, "- met [[Walkin Pat Novak]] today");
  await walkTo(page, "met [[Walkin Pat".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row", { hasText: "Walkin Patio" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual(["met [[Walkin Pat Novak]]! today"]);
});

test("Enter with the caret walked to just after [[ keeps the link, not today's date (B-384)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Pat Novak", "- long");
  const name = "Caret Inside Src Six";
  await openEditing(page, name, "- met [[Walkin Pat Novak]] today");
  await walkTo(page, "met [[".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row", { hasText: "Tomorrow" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual(["met [[Walkin Pat Novak]]! today"]);
});

test("walking into a ((ref)) offers nothing to pick, so Enter leaves the ref alone (B-384)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Ref Goal", "- the referenced block");
  const [ref] = await readBlocks(page, "Walkin Ref Goal");
  const name = "Caret Inside Src Seven";
  await openEditing(page, name, `- see ((${ref?.id})) end`);
  await walkTo(page, "see ((".length + 3);
  const popup = page.locator(".cmd-popup");
  await expect(popup).toHaveCount(1);
  // Past the search: without the fix its rows (the edited block itself first) replace "No results".
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  for (let i = 0; i < 4; i++) await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual([`see ((${ref?.id})) end!`]);
});
