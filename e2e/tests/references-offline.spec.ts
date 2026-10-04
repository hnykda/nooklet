/**
 * B-641: the references panel answers from the device. The owner, on a phone in airplane mode,
 * got "Couldn't load references · Retry": references were a server read (`page.backlinks`) and the
 * replica had no reference index. Now it keeps one (`apps/web/src/db/ref-index-client.ts`) and
 * reads it with the server's own code, so offline and local-only both work — and say what the
 * server says: the counts here are checked against the server's answer for the same graph.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, clickAway, editor, pagePath, seedPage } from "../helpers/index.js";

const stamp = Date.now().toString(36);

interface ServerBacklinks {
  linked: unknown[];
  linked_total: number;
  linked_direct_total: number;
  unlinked: unknown[];
  tagged_total: number;
}

/** Type a `[[link]]` the way a person does (`ref-pages.spec.ts`): Escape dismisses the popup. */
async function typeLink(page: Page, name: string): Promise<void> {
  await page.keyboard.type(" [[", { delay: 20 });
  await page.keyboard.type(name, { delay: 10 });
  await page.keyboard.press("Escape");
  await page.keyboard.type("]]", { delay: 20 });
}

const linkedCount = (page: Page) => page.locator(".linked-references .reference-count").first();
const unlinkedCount = (page: Page) =>
  page.locator(".unlinked-references .references-toggle .reference-count");

test("offline, references come from the device and match the server's counts", async ({
  page,
  context,
}) => {
  const target = `Offline Refs ${stamp}`;
  const source = `Offline Refs Source ${stamp}`;
  const tagged = `Offline Refs Member ${stamp}`;
  await seedPage(page, target, "- the target");
  await seedPage(
    page,
    source,
    [
      `- see [[${target}]]`,
      "  - a child that only inherits the link",
      `- also #[[${target}]]`,
      `- mentions ${target} in passing`,
      `- and ${target} once more`,
    ].join("\n"),
  );
  await api(page, "page.create", { name: tagged, properties: { tags: target } });
  const server = await api<ServerBacklinks>(page, "page.backlinks", {
    target,
    include_unlinked: true,
  });
  // The shape this test relies on, so a seeding change cannot make it vacuous.
  expect(server.linked_direct_total).toBe(2);
  expect(server.linked_total).toBe(3);
  expect(server.unlinked).toHaveLength(2);
  expect(server.tagged_total).toBe(1);

  // Online first, so the replica has the graph (a fresh device bootstraps here).
  await page.goto(pagePath(target));
  await expect(linkedCount(page)).toHaveText(String(server.linked_direct_total));

  // Airplane mode: no network at all, and every server read refused besides.
  let serverReads = 0;
  await page.route("**/api/v1/**", (route) => {
    serverReads++;
    return route.abort("internetdisconnected");
  });
  await context.setOffline(true);
  try {
    // Away and back in the app (a reload offline needs the service worker; not what this tests).
    await page.locator(".linked-references .reference-group-page", { hasText: source }).click();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(source).replace(/%20/g, "%20")));

    // Write offline: one plain mention becomes a link.
    await page
      .locator(".vr-outliner")
      .first()
      .locator(".vr-block-view", { hasText: "and" })
      .filter({ hasText: "once more" })
      .click();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press("End");
    await typeLink(page, target);
    await clickAway(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${pagePath(target).replace(/%20/g, "%20")}$`));

    await expect(page.locator(".references-error")).toHaveCount(0);
    // The written link counts at once, and its block is no longer an unlinked mention.
    await expect(linkedCount(page)).toHaveText(String(server.linked_direct_total + 1));
    await expect(unlinkedCount(page)).toHaveText(String(server.unlinked.length - 1));
    await expect(page.locator(".tagged-pages, .references-panel").getByText(tagged)).toBeVisible();
    // The filter popover works from the same list.
    await page.locator(".linked-references .references-tool[aria-expanded]").click();
    await expect(page.locator(".references-filter-option").first()).toBeVisible();
    expect(serverReads, "nothing asked the server for references").toBe(0);
  } finally {
    await context.setOffline(false);
  }

  // Back online: once the edit has synced, the server says what the device said.
  await expect
    .poll(
      async () =>
        (
          await api<ServerBacklinks>(page, "page.backlinks", {
            target,
            include_unlinked: true,
          })
        ).linked_direct_total,
      { timeout: 20_000 },
    )
    .toBe(server.linked_direct_total + 1);
});

test("with no server configured, references work from the device", async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  let serverReads = 0;
  await page.route("**/api/v1/**", (route) => {
    serverReads++;
    return route.abort();
  });
  await page.goto("/journals");
  // A genuinely local-only entry, seeded the way `search-local-only.spec.ts` does it.
  await page.evaluate(() => {
    localStorage.setItem(
      "nooklet.graphs",
      JSON.stringify([{ id: "refs-local", label: "Refs Local Only", kind: "local" }]),
    );
    localStorage.setItem("nooklet.activeGraphId", "refs-local");
  });
  await page.goto("/journals");
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "local");

  const name = `Local Refs ${stamp}`;
  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.click();
  await page.keyboard.type("see", { delay: 10 });
  await typeLink(page, name);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`a plain ${name} mention`, { delay: 5 });
  await clickAway(page);

  await page.locator(".vr-page-ref", { hasText: name }).first().click();
  await expect(page.locator(".page-title-input")).toHaveValue(name);
  await expect(linkedCount(page)).toHaveText("1");
  await expect(unlinkedCount(page)).toHaveText("1");
  await expect(page.locator(".references-error")).toHaveCount(0);
  await expect(page.getByText("References need a server")).toHaveCount(0);
  // Link all is a server op: with no server it is not offered rather than offered and failing.
  await expect(page.locator(".references-link-all")).toHaveCount(0);
  expect(serverReads).toBe(0);
});
