/**
 * Alt+Enter ("Follow link under cursor", `nav.followLink`) on a `((block ref))` zooms to the
 * referenced block on its own page (B-139). The block case once asked a page-id lookup about a
 * block id, found nothing, and silently stayed put.
 */

import { expect, test } from "@playwright/test";
import { openEditing, readBlocks, seedPage } from "../helpers/index.js";

test("Alt+Enter on a block ref opens the referenced block on its page", async ({ page }) => {
  await seedPage(page, "Follow Ref Target/Deep", "- the referenced block\n- another");
  const [target] = await readBlocks(page, "Follow Ref Target/Deep");
  expect(target?.content).toBe("the referenced block");

  await openEditing(page, "Follow Ref Source", `- see ((${target?.id}))`);
  await page.keyboard.press("Alt+Enter");
  await expect(page).toHaveURL(
    new RegExp(`/page/Follow%20Ref%20Target/Deep\\?block=${target?.id}$`),
  );
});
