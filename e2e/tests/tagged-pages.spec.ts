/**
 * "Pages tagged X" on a tag's page (ADR 017, B-111). A page carrying `tags:: Person` links to
 * `Person` from no block, so before this the `Person` page showed nothing about its members.
 */
import { expect, test } from "@playwright/test";
import { api, pagePath } from "../helpers/index.js";

test.beforeEach(async ({ page }) => {
  await api(page, "page.create", {
    name: "Tagged Person",
    if_exists: "return",
    markdown: "- a kind of page",
  });
  await api(page, "page.create", {
    name: "Tagged Zuzana",
    if_exists: "return",
    properties: { tags: "Tagged Person, czech" },
  });
  await api(page, "page.create", {
    name: "Tagged Adam",
    if_exists: "return",
    properties: { tags: "[[Tagged Person]]" },
  });
  await api(page, "page.create", {
    name: "Tagged Notes",
    if_exists: "return",
    markdown: "- met a #[[Tagged Person]] today",
  });
});

test("a tag's page lists the pages tagged with it, above linked references (B-111)", async ({
  page,
}) => {
  await page.goto(pagePath("Tagged Person"));

  const section = page.getByRole("region", { name: "Pages tagged Tagged Person" });
  await expect(section).toBeVisible();
  await expect(section.locator(".reference-count")).toHaveText("2");
  await expect(section.locator(".tagged-page-link")).toHaveText(["Tagged Adam", "Tagged Zuzana"]);

  // The block that says #[[Tagged Person]] is still a linked reference, and it comes second.
  const linked = page.locator(".linked-references");
  await expect(linked.locator(".reference-group-page")).toHaveText(["Tagged Notes"]);
  const order = await page
    .locator(".references-panel > section")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(order.slice(0, 2)).toEqual(["Pages tagged Tagged Person", "Linked references"]);

  // It collapses like the other halves.
  await section.locator(".references-toggle").click();
  await expect(section.locator(".tagged-page-link")).toHaveCount(0);
  await section.locator(".references-toggle").click();

  await section.getByRole("button", { name: "Tagged Zuzana" }).click();
  await expect(page).toHaveURL(new RegExp(`${pagePath("Tagged Zuzana")}$`));
  await expect(page.locator(".page-title-input")).toHaveValue("Tagged Zuzana");
});

test("a page with tagged pages but no linked references still shows the panel (B-111)", async ({
  page,
}) => {
  // `czech` is only ever a page-level tag here — no block links to it.
  await api(page, "page.create", { name: "czech", if_exists: "return", markdown: "- jazyk" });
  await page.goto(pagePath("czech"));

  const section = page.getByRole("region", { name: "Pages tagged czech" });
  await expect(section.locator(".tagged-page-link")).toHaveText(["Tagged Zuzana"]);
  await expect(page.locator(".linked-references")).toHaveCount(0);
});

test("a page tagged later, by a property update, appears on the tag's page (B-111)", async ({
  page,
}) => {
  const suffix = test.info().retry;
  await api(page, "page.create", {
    name: `Tagged Late ${suffix}`,
    if_exists: "return",
    markdown: "- x",
  });
  await api(page, "page.update", {
    page: `Tagged Late ${suffix}`,
    properties: { tags: "Tagged Person" },
  });

  await page.goto(pagePath("Tagged Person"));
  const section = page.getByRole("region", { name: "Pages tagged Tagged Person" });
  await expect(section.locator(".tagged-page-link")).toContainText([`Tagged Late ${suffix}`]);
});

test("an open tag page follows another device untagging and re-tagging a page (B-202)", async ({
  page,
}) => {
  // A `tags::` edit on an existing page is a `page.prop` op and nothing else — no block, no page
  // row — so a panel that only listens to those tables never hears it. Seeded before the visit, so
  // every change below arrives as a pull while the page is open.
  const n = test.info().retry;
  const tag = `Tagged Live ${n}`;
  const [first, second] = [`Tagged Live One ${n}`, `Tagged Live Two ${n}`];
  await api(page, "page.create", { name: tag, if_exists: "return", markdown: "- the tag" });
  for (const name of [first, second]) {
    await api(page, "page.create", { name, if_exists: "return", properties: { tags: tag } });
  }

  await page.goto(pagePath(tag));
  const section = page.getByRole("region", { name: `Pages tagged ${tag}` });
  await expect(section.locator(".tagged-page-link")).toHaveText([first, second]);

  await api(page, "page.update", { page: first, properties: { tags: null } });
  await expect(section.locator(".tagged-page-link")).toHaveText([second]);
  await expect(section.locator(".reference-count")).toHaveText("1");

  await api(page, "page.update", { page: first, properties: { tags: `[[${tag}]]` } });
  await expect(section.locator(".tagged-page-link")).toHaveText([first, second]);
});
