/**
 * B-342 in the browser, through the UI path that turns a block into outline text and back: copy a
 * block selection (`selection-clipboard.ts`, `serializeOutline` with `ids: "none"`) and paste it
 * (`paste.ts`, `parseOutline`) — the same text the markdown mirror and `page_read` write.
 *
 * The bug's own steps: a typed `scheduled:: 2026-09-20` line stays text (OUT-22a — no chip, not on
 * the agenda). Before the fix its copy went out as `scheduled:: 2026-09-20` and the paste made it a
 * real scheduled date; now it goes out as `scheduled\:: 2026-09-20` (OUT-23a) and pastes as text.
 *
 * Page names start with "MES " (mirror-escape) so they cannot collide with another spec's on the
 * shared server.
 */

import { expect, test } from "@playwright/test";
import { api, clickRow, MOD, openEditing } from "../helpers/index.js";

type Node = {
  content: string;
  marker?: string | null;
  properties?: Record<string, string>;
  children: Node[];
};
type Shape = {
  content: string;
  marker: string | null;
  properties: Record<string, string>;
  children: Shape[];
};
const shape = (n: Node): Shape => ({
  content: n.content,
  marker: n.marker ?? null,
  properties: n.properties ?? {},
  children: n.children.map(shape),
});

test("a typed scheduled:: text line copies escaped and pastes back as text, not a date (B-342)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = "MES Shaped Line Clipboard";
  const outliner = await openEditing(page, name, "- TODO call mom\n- paste after me");
  const read = async (): Promise<Shape[]> =>
    (
      (await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" })).tree ?? []
    ).map(shape);

  // openEditing put the caret at the end of row 0's only line.
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("scheduled:: 2026-09-20");
  await clickRow(page, outliner, 1);

  const task: Shape = {
    content: "call mom\nscheduled:: 2026-09-20",
    marker: "TODO",
    properties: {},
    children: [],
  };
  const after: Shape = { content: "paste after me", marker: null, properties: {}, children: [] };
  await expect.poll(read).toEqual([task, after]);

  // Back into row 0, Escape selects it, Cmd+C copies it.
  await clickRow(page, outliner, 0);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+c`);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("- TODO call mom\n  scheduled\\:: 2026-09-20\n");
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  await clickRow(page, outliner, 1);
  await page.locator(".cm-content").evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, copied);

  await expect.poll(read).toEqual([task, after, task]);
});
