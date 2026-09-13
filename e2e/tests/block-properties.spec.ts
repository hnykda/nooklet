/**
 * Block properties in the outliner: numbered lists (`list:: number`, B-100), property chips under a
 * block and its `key:: value` lines while editing (B-101), and `/property` writing a property the
 * server can see.
 *
 * All three were dead for the same reason — the client tree never carried a block's generic
 * properties — and every unit test passed anyway, because none of them looked at a rendered row
 * seeded through the real server. What the server stores is read back through `page.read`, never
 * from the DOM alone: the live preview hides markup while editing.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  clickAway,
  clickRow,
  editor,
  editorText,
  MOD,
  openEditing,
  openPage,
  readBlocks,
} from "../helpers/index.js";

interface ReadNode {
  id: string;
  content: string;
  properties?: Record<string, string>;
  children?: ReadNode[];
}

/** `page.read`'s blocks, flattened, with their properties. */
async function readWithProps(
  page: Page,
  name: string,
): Promise<Array<{ content: string; properties: Record<string, string> }>> {
  const out = await api<{ tree?: ReadNode[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<{ content: string; properties: Record<string, string> }> = [];
  const walk = (nodes: ReadNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push({ content: n.content, properties: n.properties ?? {} });
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

test.describe("numbered lists (B-100)", () => {
  test("list:: number siblings render 1, 2 and restart after a plain bullet", async ({ page }) => {
    const outliner = await openPage(
      page,
      "Props Numbered",
      [
        "- one",
        "  list:: number",
        "- two",
        "  list:: number",
        "  - nested plain",
        "  - nested one",
        "    list:: number",
        "- plain",
        "- again",
        "  list:: number",
      ].join("\n"),
    );
    const rows = outliner.locator(".vr-row");
    await expect(rows).toHaveCount(6);
    // One ordinal per numbered row, in row order: the run under `two` is its own sibling group,
    // and `plain` resets the top-level run.
    const numbers = await rows.evaluateAll((els) =>
      els.map((r) => r.querySelector(".vr-list-number")?.textContent ?? null),
    );
    expect(numbers).toEqual(["1.", "2.", null, "1.", null, "1."]);
    // The ordinal is the marker, so `list:: number` itself is not repeated as a chip.
    await expect(outliner.locator(".vr-block-props")).toHaveCount(0);
  });

  test("a literal `1.` bullet imported through page.create numbers too", async ({ page }) => {
    const outliner = await openPage(page, "Props Numbered Literal", "1. first\n2. second");
    await expect(outliner.locator(".vr-list-number")).toHaveText(["1.", "2."]);
  });

  test("Enter at the end of a numbered item makes the next item numbered too", async ({ page }) => {
    const outliner = await openEditing(page, "Props Numbered Enter", "- one\n  list:: number");
    await page.keyboard.press("Enter");
    await page.keyboard.type("two");
    await clickAway(page);
    await expect(outliner.locator(".vr-list-number")).toHaveText(["1.", "2."]);
    await expect
      .poll(() => readWithProps(page, "Props Numbered Enter"))
      .toEqual([
        { content: "one", properties: { list: "number" } },
        { content: "two", properties: { list: "number" } },
      ]);
  });
});

test("the Numbered list slash item numbers a block, and a second use stops it", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Props Numbered Slash", "- first\n- second");
  await page.keyboard.type(" /numbered");
  await expect(page.locator(".cmd-popup .cmd-row--active")).toHaveText("Numbered list");
  await page.keyboard.press("Enter");
  await clickAway(page);
  await expect(outliner.locator(".vr-list-number")).toHaveText(["1."]);
  await expect
    .poll(async () => (await readWithProps(page, "Props Numbered Slash"))[0]?.properties)
    .toEqual({ list: "number" });

  await outliner.locator(".vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" /numbered");
  await expect(page.locator(".cmd-popup .cmd-row--active")).toHaveText("Numbered list");
  await page.keyboard.press("Enter");
  await clickAway(page);
  await expect(outliner.locator(".vr-list-number")).toHaveCount(0);
  await expect
    .poll(async () => (await readWithProps(page, "Props Numbered Slash"))[0]?.properties)
    .toEqual({});
});

test.describe("block properties (B-101)", () => {
  test("show as chips under the block, and as key:: value lines while it is edited", async ({
    page,
  }) => {
    const outliner = await openPage(
      page,
      "Props Chips",
      "- has a prop\n  foo:: bar\n  hl-page:: 3\n- second",
    );
    const row = outliner.locator(".vr-row").first();
    // `hl-page` is PDF-highlight bookkeeping Logseq hides too; `foo` is the one to show.
    await expect(row.locator(".vr-prop")).toHaveCount(1);
    await expect(row.locator(".vr-prop-key")).toHaveText("foo");
    await expect(row.locator(".vr-prop-value")).toHaveText("bar");
    await expect(row.locator(".vr-block-view")).toHaveText("has a prop");

    await row.locator(".vr-block-props").click();
    await expect(editor(page)).toBeFocused();
    expect(await editorText(page)).toBe("has a prop\nfoo:: bar\nhl-page:: 3");
    await expect(row.locator(".vr-block-props")).toHaveCount(0);

    // Leaving without typing writes nothing and brings the chips back.
    await clickRow(page, outliner, 1);
    await expect(row.locator(".vr-prop-value")).toHaveText("bar");
    expect(await readWithProps(page, "Props Chips")).toEqual([
      { content: "has a prop", properties: { foo: "bar", "hl-page": "3" } },
      { content: "second", properties: {} },
    ]);
  });

  test("a typed key:: value line is stored as a property, not as text", async ({ page }) => {
    const outliner = await openEditing(page, "Props Typed", "- start here");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("status:: done");
    await clickAway(page);
    await expect
      .poll(() => readWithProps(page, "Props Typed"))
      .toEqual([{ content: "start here", properties: { status: "done" } }]);
    await expect(outliner.locator(".vr-prop-value")).toHaveText("done");
    await expect(outliner.locator(".vr-block-view")).toHaveText("start here");
  });

  test("/property inserts a line that becomes a real property (the audit's D7 repro)", async ({
    page,
  }) => {
    const outliner = await openEditing(page, "Props Slash", "- start here");
    await page.keyboard.type(" /prop");
    await expect(page.locator(".cmd-popup .cmd-row--active")).toHaveText("Property");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cmd-popup")).toHaveCount(0);
    await page.keyboard.type("status");
    await page.keyboard.press("End");
    await page.keyboard.type("bar");
    await clickAway(page);
    await expect
      .poll(async () =>
        (await readWithProps(page, "Props Slash")).map((b) => ({
          ...b,
          content: b.content.trimEnd(),
        })),
      )
      .toEqual([{ content: "start here", properties: { status: "bar" } }]);
    await expect(outliner.locator(".vr-prop-key")).toHaveText("status");
  });

  test("editing a value and deleting a line change and remove properties; undo restores", async ({
    page,
  }) => {
    const outliner = await openPage(page, "Props Edit", "- item\n  a:: 1\n  b:: 2");
    await outliner.locator(".vr-block-view").first().click();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type("0"); // b:: 20
    await page.keyboard.press("ArrowUp"); // onto `a:: 1`
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace"); // and the newline before it
    expect(await editorText(page)).toBe("item\nb:: 20");
    await expect
      .poll(() => readWithProps(page, "Props Edit"))
      .toEqual([{ content: "item", properties: { b: "20" } }]);

    await page.keyboard.press(`${MOD}+z`);
    await expect
      .poll(() => readWithProps(page, "Props Edit"))
      .toEqual([{ content: "item", properties: { a: "1", b: "2" } }]);
    await expect.poll(() => editorText(page)).toBe("item\na:: 1\nb:: 2");
  });
});

test("a property value the buffer cannot show as one line survives editing the block (B-152)", async ({
  page,
}) => {
  // An agent can store any string as a value (`block.update`'s properties take z.string()). Put
  // into the buffer as `summary:: line1\nline2`, the value's tail read back as content, and the
  // first keystroke wrote `title!\nline2` into the block's text.
  const name = "Props Multiline Value";
  const outliner = await openPage(page, name, "- title");
  const [block] = await readBlocks(page, name);
  await api(page, "block.update", {
    id: block?.id,
    properties: { summary: "line1\nline2", status: "draft" },
  });
  await expect(outliner.locator(".vr-prop")).toHaveCount(2);

  await outliner.locator(".vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  expect(await editorText(page)).toBe("title\nstatus:: draft");
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await clickAway(page);
  await expect
    .poll(() => readWithProps(page, name))
    .toEqual([{ content: "title!", properties: { summary: "line1\nline2", status: "draft" } }]);
});

test("/code, /query and /h1 change the text and leave the properties alone (B-153)", async ({
  page,
}) => {
  // The editor host hands commands the editing text, property lines included. Before the fix
  // `/code` wrapped `list:: number` into the fence, `/query` made `owner:: Dan` the query, and
  // `/h1` left the caret at the end of the property line, so the next word became its value.
  const slash = async (name: string, markdown: string, command: string, label: string) => {
    await openEditing(page, name, markdown);
    await page.keyboard.press(`${MOD}+Home`);
    await page.keyboard.press("End");
    await page.keyboard.type(` /${command}`);
    await expect(page.locator(".cmd-popup .cmd-row--active")).toHaveText(label);
    await page.keyboard.press("Enter");
    await expect(page.locator(".cmd-popup")).toHaveCount(0);
  };

  await slash("Props Code", "- npm install\n  list:: number", "code", "Code block");
  await clickAway(page);
  await expect
    .poll(() => readWithProps(page, "Props Code"))
    .toEqual([{ content: "```\nnpm install \n```", properties: { list: "number" } }]);

  await slash("Props Query", "- open tasks\n  owner:: Dan", "query", "Query");
  await clickAway(page);
  await expect
    .poll(() => readWithProps(page, "Props Query"))
    .toEqual([{ content: "```query\nopen tasks\n```", properties: { owner: "Dan" } }]);

  const outliner = await (async () => {
    await slash("Props Heading", "- Title\n  list:: number", "h1", "Heading 1");
    return page.locator(".vr-outliner").first();
  })();
  await page.keyboard.type("more");
  await clickAway(page);
  await expect
    .poll(() => readWithProps(page, "Props Heading"))
    .toEqual([{ content: "# Title more", properties: { list: "number" } }]);
  await expect(outliner.locator(".vr-list-number")).toHaveText(["1."]);
});

test("a property an agent sets while the block is being typed into is kept", async ({ page }) => {
  // The flush diffs the buffer against the block as the edit began, never against live properties:
  // the buffer never showed `agent`, so its absence from the buffer must not delete it.
  const name = "Props Concurrent Agent";
  const outliner = await openEditing(page, name, "- typing here");
  const [block] = await readBlocks(page, name);
  await page.keyboard.type("abc");
  await api(page, "block.update", { id: block?.id, properties: { agent: "yes" } });
  await page.keyboard.type("def");
  // Past the flush debounce, so a second flush runs against a tree that has seen the agent's write.
  await expect
    .poll(async () => (await readWithProps(page, name))[0]?.content)
    .toBe("typing hereabcdef");
  await page.keyboard.type("g");
  await clickAway(page);
  await expect
    .poll(() => readWithProps(page, name))
    .toEqual([{ content: "typing hereabcdefg", properties: { agent: "yes" } }]);
  await clickRow(page, outliner, 0);
  await clickAway(page);
  await expect(outliner.locator(".vr-prop-value")).toHaveText("yes");
});
