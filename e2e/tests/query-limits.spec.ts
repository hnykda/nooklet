/**
 * B-129: a query fence is block content any writer can sync to every device, so its size is not
 * the reader's choice. A fence nested thousands deep threw out of `parseQuery` inside the view's
 * memo, and one with ~1,000 filters compiled to SQL that SQLite refuses. Both must render as a
 * query error in words, with the rest of the page intact.
 */
import { expect, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

const fence = (q: string): string => `- \`\`\`query\n  ${q}\n  \`\`\``;

test("a fence nested thousands deep says so and the page around it still renders", async ({
  page,
}) => {
  const deep = `${"(".repeat(5000)}TODO${")".repeat(5000)}`;
  const outliner = await openPage(
    page,
    "Query Limits Deep",
    `- before the fence\n${fence(deep)}\n- after the fence`,
  );
  const view = outliner.locator(".vr-query");
  await expect(view.locator(".vr-query-error")).toContainText("nested too deeply");
  await expect(outliner).toContainText("before the fence");
  await expect(outliner).toContainText("after the fence");
});

test("a fence with a thousand filters says so instead of failing in SQL", async ({ page }) => {
  const wide = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
  const outliner = await openPage(page, "Query Limits Wide", `${fence(wide)}\n- after the fence`);
  const view = outliner.locator(".vr-query");
  await expect(view.locator(".vr-query-error")).toContainText("too many filters");
  await expect(outliner).toContainText("after the fence");
});
