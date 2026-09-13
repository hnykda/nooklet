/**
 * Block text is untrusted input: it arrives by sync, by import and from agents over MCP, and the
 * renderer must not let it do more than show itself. Each test seeds the text through the API —
 * the way an agent or a synced device would put it there — and checks what reaches the DOM (or a
 * new window) in the real build.
 *
 * - B-137: Alt+Enter on an asset link opens the asset, not `/page/assets/…` (B-51 on the keyboard
 *   path).
 */

import { expect, test } from "@playwright/test";
import { openEditing } from "../helpers/index.js";

test("Alt+Enter on an asset link opens the asset from the server root, not below the page route", async ({
  page,
  baseURL,
}) => {
  // A namespaced page: the route is two segments deep, so a relative href would land on
  // /page/Untrusted/assets/… — the shape B-51 fixed for rendered links.
  await openEditing(page, "Untrusted/Asset Link", "- [spec](../assets/rv-sec-spec.pdf)");
  const popup = page.context().waitForEvent("page");
  await page.keyboard.press("Alt+Enter");
  const opened = await popup;
  await expect.poll(() => opened.url()).toBe(`${baseURL}/assets/rv-sec-spec.pdf`);
  await opened.close();
});
