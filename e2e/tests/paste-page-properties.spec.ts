/**
 * B-311: pasting outline text that opens with property lines — which the parser reads as a page's
 * properties (a pre-block) — created the blocks and dropped those lines without a word. They are
 * now kept as a block of their own carrying them.
 *
 * Page names start with "CO " (core-ops) so they cannot collide with another spec's on the shared
 * server.
 */

import { expect, test } from "@playwright/test";
import { api, openEditing } from "../helpers/index.js";

test("pasting outline text that opens with property lines keeps them as a block (B-311)", async ({
  page,
}) => {
  const name = "CO Paste Properties";
  const outliner = await openEditing(page, name, "- anchor");
  await page.locator(".cm-content").evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, "tags:: copaste\nstatus:: draft\n\n- první\n- second");

  type Node = { content: string; properties?: Record<string, string> };
  await expect
    .poll(async () => {
      const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
      return (out.tree ?? []).map((n) => ({ content: n.content, properties: n.properties ?? {} }));
    })
    .toEqual([
      { content: "anchor", properties: {} },
      { content: "", properties: { tags: "copaste", status: "draft" } },
      { content: "první", properties: {} },
      { content: "second", properties: {} },
    ]);
  await expect(outliner.locator(".vr-row")).toHaveCount(4);
});
