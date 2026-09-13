/**
 * B-310 through the one UI path that parses `serializeOutline`'s id-less text back: copy a block
 * selection (`selection-clipboard.ts`, `ids: "none"`) and paste it (`paste.ts`, `parseOutline`).
 * Before the fix a task whose text opens with a code fence went out as `- TODO [#A] ```js`, the
 * parser never opened that fence, and the paste made the code's `- ` line a child block and its
 * `key:: value` line a property.
 *
 * Page names start with "COV " (core-ops verification) so they cannot collide with another spec's
 * on the shared server.
 */

import { expect, test } from "@playwright/test";
import { api, clickRow, MOD, openEditing } from "../helpers/index.js";

type Node = {
  content: string;
  marker?: string | null;
  priority?: string | null;
  properties?: Record<string, string>;
  children: Node[];
};
type Shape = {
  content: string;
  marker: string | null;
  priority: string | null;
  properties: Record<string, string>;
  children: Shape[];
};
const shape = (n: Node): Shape => ({
  content: n.content,
  marker: n.marker ?? null,
  priority: n.priority ?? null,
  properties: n.properties ?? {},
  children: n.children.map(shape),
});

test("copying and pasting a task that opens with a code fence keeps marker, fence, property and child (B-310)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = "COV Fence Task Clipboard";
  const outliner = await openEditing(
    page,
    name,
    [
      "- TODO [#A] ```js",
      "  - not a bullet",
      "  foo:: not a property",
      "  ```",
      "  owner:: dan",
      "  - child",
      "- paste after me",
    ].join("\n"),
  );
  const read = async (): Promise<Shape[]> =>
    (
      (await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" })).tree ?? []
    ).map(shape);
  const leaf = (content: string): Shape => ({
    content,
    marker: null,
    priority: null,
    properties: {},
    children: [],
  });
  const task: Shape = {
    content: "```js\n- not a bullet\nfoo:: not a property\n```",
    marker: "TODO",
    priority: "A",
    properties: { owner: "dan" },
    children: [leaf("child")],
  };
  await expect.poll(read).toEqual([task, leaf("paste after me")]);

  // openEditing left row 0 — the task — in the editor: Escape selects it, Cmd+C copies it.
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+c`);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^- TODO \[#A\] ```js\n/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  await clickRow(page, outliner, 2);
  await page.locator(".cm-content").evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, copied);

  await expect.poll(read).toEqual([task, leaf("paste after me"), task]);
});
