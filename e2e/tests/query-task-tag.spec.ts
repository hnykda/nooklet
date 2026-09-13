/**
 * B-263: every block with a task marker references `Task` (derived, never in the text — see
 * `core/refs.ts#TASK_TAG`), and a ```` ```query ```` fence must agree with the server's `ref`
 * index about it. On the real graph `tag:task` said "0 blocks" beside 686 backlinks to `Task`.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, openPage, seedPage } from "../helpers/index.js";

const SOURCE = "Query Task Tag Source";
const SOURCE_MARKDOWN = [
  "- LATER call the bank",
  "- DONE camp ČS",
  "- NOW write it",
  "- plain",
].join("\n");

async function openQuery(page: Page, name: string, q: string): Promise<Locator> {
  await seedPage(page, SOURCE, SOURCE_MARKDOWN);
  const outliner = await openPage(page, name, `- \`\`\`query\n  ${q}\n  \`\`\``);
  const view = outliner.locator(".vr-query");
  await expect(view).toBeVisible();
  return view;
}

test("tag:task finds the marked blocks that [[Task]]'s backlinks list (B-263)", async ({
  page,
}) => {
  const view = await openQuery(page, "Query Task Tag All", `page:[[${SOURCE}]] tag:task`);
  await expect(view.locator(".vr-query-count")).toHaveText("3 blocks on 1 page");
  await expect(view).toContainText("camp ČS");
  await expect(view).not.toContainText("plain");

  const backlinks = await api<{ linked: Array<{ page: string }> }>(page, "page.backlinks", {
    target: "Task",
  });
  expect(backlinks.linked.filter((b) => b.page === SOURCE)).toHaveLength(3);
});

test("#task combines with markers, and not #task excludes every task (B-263)", async ({ page }) => {
  const some = await openQuery(
    page,
    "Query Task Tag Open",
    `page:[[${SOURCE}]] #task and (NOW or WAITING)`,
  );
  await expect(some.locator(".vr-query-count")).toHaveText("1 block on 1 page");
  await expect(some).toContainText("write it");

  const none = await openQuery(
    page,
    "Query Task Tag Not",
    `page:[[${SOURCE}]] marker:open not #task`,
  );
  await expect(none.locator(".vr-query-count")).toHaveText("0 blocks");
});
