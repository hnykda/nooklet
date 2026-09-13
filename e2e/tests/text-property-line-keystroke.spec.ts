/**
 * B-474: a block whose TEXT holds a `foo:: bar` line — written by an agent as `foo\:: bar` (OUT-23a,
 * B-342) or pasted from a copied block — lost that line on the first keystroke in the app, or got
 * it twice. Attaching the editor laid the untouched buffer over the block with `withEditText`,
 * which split the line out as a property the database did not have; the first keystroke snapshot
 * that tree as `before`, and the diff at flush saw the line as an unchanged property.
 *
 * What the line should become on an edit — a property (today's editing-text rule, B-472) or text
 * kept by an escape in the buffer — is the owner's call (B-472). Either way it must survive exactly
 * once, which is what these assert.
 *
 * Page names start with "MEV " (mirror-escape-verify) so they cannot collide on the shared server.
 */

import { expect, test } from "@playwright/test";
import { api, clickRow, MOD, openPage } from "../helpers/index.js";

type Node = { id: string; content: string; properties?: Record<string, string>; children: Node[] };

/** Every place key `key` survives in block `b` — a `key:: …` text line, a property — as the value
 * it has there. */
const survivors = (b: Node, key: string): string[] => [
  ...b.content
    .split("\n")
    .filter((line) => line.startsWith(`${key}:: `))
    .map((line) => line.slice(key.length + 3)),
  ...(b.properties?.[key] !== undefined ? [b.properties[key] as string] : []),
];

for (const { where, keys, typedLine, foo } of [
  { where: "on line 1", keys: [`${MOD}+Home`, "End"], typedLine: "notes!", foo: "bar" },
  { where: "on the last line", keys: [`${MOD}+End`], typedLine: "more!", foo: "bar" },
  {
    where: "on the foo:: line itself",
    keys: [`${MOD}+Home`, "ArrowDown", "End"],
    typedLine: "notes",
    foo: "bar!",
  },
]) {
  test(`one keystroke ${where} keeps a foo:: text line exactly once (B-474)`, async ({ page }) => {
    const name = `MEV Text Line Keystroke ${where}`;
    const outliner = await openPage(page, name, "- notes\n  foo\\:: bar\n  more\n- other");
    const read = async (): Promise<Node> =>
      ((await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" })).tree ??
        [])[0] as Node;
    // Seeded as text (OUT-23a), not as a property.
    expect(await read()).toMatchObject({ content: "notes\nfoo:: bar\nmore" });
    expect((await read()).properties ?? {}).toEqual({});

    await clickRow(page, outliner, 0);
    for (const key of keys) await page.keyboard.press(key);
    await page.keyboard.type("!");
    await clickRow(page, outliner, 1);

    // The edit landed (block.text and block.prop go out in one batch)...
    await expect
      .poll(async () => {
        const b = await read();
        return b.content.includes("!") || Object.values(b.properties ?? {}).includes("bar!");
      })
      .toBe(true);
    const b = await read();
    // ...and nothing else in the block moved.
    expect(b.content.split("\n")).toContain(typedLine);
    expect(b.content.split("\n")).toContain(where === "on the last line" ? "more!" : "more");
    // The line: once, never gone, never twice — as text or as a property, with the typed value.
    expect(survivors(b, "foo"), JSON.stringify(b)).toEqual([foo]);
  });
}

test("undo of that keystroke brings the text line back and keeps it; redo redoes the edit (B-474)", async ({
  page,
}) => {
  const name = "MEV Text Line Undo";
  const outliner = await openPage(page, name, "- notes\n  foo\\:: bar\n  more\n- other");
  const read = async () => {
    const b = ((await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" }))
      .tree ?? [])[0] as Node;
    return { content: b.content, properties: b.properties ?? {}, foo: survivors(b, "foo") };
  };
  const seeded = await read();
  expect(seeded).toEqual({ content: "notes\nfoo:: bar\nmore", properties: {}, foo: ["bar"] });

  await clickRow(page, outliner, 0);
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect.poll(async () => (await read()).content.startsWith("notes!")).toBe(true);
  const edited = await read();
  expect(edited.foo).toEqual(["bar"]);

  // The undo rewrites the buffer to the restored text. That rewrite used to be flushed like typing,
  // and half a second later the line was a property again and the redo stack empty.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(read).toEqual(seeded);
  await page.waitForTimeout(1500);
  expect(await read()).toEqual(seeded);

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(read).toEqual(edited);
});
