/**
 * Templates (ADR 019) in a real browser against a real server: `/template` inserting a copy of a
 * template block's subtree — structure, fresh ids, the `template::` property not copied — the
 * journal template landing on a day born on the client (first keystroke) and on a day born
 * through the API (`page.append`), and `<% today %>` following the reader's date format.
 *
 * One server for the whole file, tests in order: the settings test chooses the journal template
 * that the two journal tests then rely on. Page names carry a `Templates` prefix so nothing here
 * collides with other specs sharing the graph.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  editingRowIndex,
  isoOffset,
  openEditing,
  rowDepths,
  rowTexts,
  seedPage,
} from "../helpers/index.js";

const LIBRARY = "Templates Library";
const LIBRARY_MD = `- Daily plan for <% today %>
  template:: daily
  - Gratitude
  - TODO plan the day at <% time %>
- Meeting
  template:: meeting
  template-including-parent:: false
  - Attendees
  - Notes`;

interface Node {
  id: string;
  content: string;
  marker?: string | null;
  properties?: Record<string, string>;
  children: Node[];
}

/** `page.read`'s JSON tree, with properties — `readBlocks` flattens those away. */
async function readTree(page: Page, name: string): Promise<Node[]> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  return out.tree ?? [];
}

function allIds(nodes: Node[]): string[] {
  return nodes.flatMap((n) => [n.id, ...allIds(n.children)]);
}

/** date-fns `MMM do, yyyy` — the default journal title format — for a `YYYY-MM-DD` string. */
function defaultTitle(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const suffix =
    d % 10 === 1 && d !== 11
      ? "st"
      : d % 10 === 2 && d !== 12
        ? "nd"
        : d % 10 === 3 && d !== 13
          ? "rd"
          : "th";
  return `${months[m - 1]} ${d}${suffix}, ${y}`;
}

const TIME_RE = /\d{2}:\d{2}/;

/** Type `/template`, take the slash menu's Template row, filter the picker, pick with Enter. */
async function pickTemplate(page: Page, name: string): Promise<void> {
  await page.keyboard.type("/template");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu).toBeVisible();
  await menu
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker = page.locator(".tpl-picker");
  await expect(picker).toBeVisible();
  // The slash menu is gone the moment the picker is up — one popup for one question.
  await expect(page.locator(".cmd-popup")).toHaveCount(1);
  await page.keyboard.type(name);
  await expect(picker.locator('[role="option"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await seedPage(page, LIBRARY, LIBRARY_MD);
});

test("/template into an empty bullet: the copy has the template's shape, fresh ids, no template:: property", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Templates Empty", "- start");
  await page.keyboard.press("Enter");
  await pickTemplate(page, "daily");

  const today = defaultTitle(isoOffset(0));
  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  const texts = await rowTexts(page, outliner);
  expect(texts[0]).toBe("start");
  expect(texts[1]).toContain(`Daily plan for [[${today}]]`);
  expect(texts[2]).toContain("Gratitude");
  expect(texts[3]).toMatch(/plan the day at \d{2}:\d{2}/);
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 1, 1]);
  // The empty bullet became the template's first block, and the caret stayed in it.
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await expect(page.locator(".cm-content")).toBeFocused();

  // Through the API: structure, ids and properties.
  await expect
    .poll(async () => (await readTree(page, "Templates Empty")).map((n) => n.content))
    .toEqual(["start", `Daily plan for [[${today}]]`]);
  const [, root] = await readTree(page, "Templates Empty");
  const library = await readTree(page, LIBRARY);
  expect(root?.children.map((c) => c.content)).toEqual([
    "Gratitude",
    expect.stringMatching(/^plan the day at \d{2}:\d{2}$/),
  ]);
  expect(root?.children[1]?.marker).toBe("TODO");
  expect(root?.properties?.template).toBeUndefined();
  expect(library[0]?.properties?.template).toBe("daily");
  const copied = allIds([root as Node]);
  const original = allIds(library);
  expect(copied.some((id) => original.includes(id))).toBe(false);
  expect(new Set(copied).size).toBe(3);
});

test("/template into an empty numbered item: what is typed next extends the text, not the list property (B-360)", async ({
  page,
}) => {
  // The block keeps its `list:: number`, which the editor shows as a line below the text (B-101).
  // The caret after the insertion was placed at the end of that whole buffer — inside the property
  // line — so the next keystroke turned `list:: number` into `list:: numberx`.
  const name = "Templates Numbered Into";
  const outliner = await openEditing(page, name, "- first\n  list:: number");
  await page.keyboard.press("Enter");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["first", "\nlist:: number"]);
  await pickTemplate(page, "daily");

  const today = defaultTitle(isoOffset(0));
  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await page.keyboard.type("!");
  await expect
    .poll(async () =>
      (await readTree(page, name)).map((n) => ({ content: n.content, properties: n.properties })),
    )
    .toEqual([
      { content: "first", properties: { list: "number" } },
      { content: `Daily plan for [[${today}]]!`, properties: { list: "number" } },
    ]);
});

test("/template after a bullet with text: inserted as the next siblings, caret in the first new block", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Templates After", "- keep me");
  await page.keyboard.type(" ");
  await pickTemplate(page, "daily");

  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  const texts = await rowTexts(page, outliner);
  expect(texts[0]).toContain("keep me");
  expect(texts[1]).toContain("Daily plan for");
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 1, 1]);
  await expect.poll(() => editingRowIndex(page, outliner)).toBe(1);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("template-including-parent:: false inserts only the children", async ({ page }) => {
  const outliner = await openEditing(page, "Templates Children", "- x");
  await page.keyboard.press("Enter");
  await pickTemplate(page, "meeting");

  await expect.poll(() => rowTexts(page, outliner)).toEqual(["x", "Attendees", "Notes"]);
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 0]);
  await expect
    .poll(async () => (await readTree(page, "Templates Children")).map((n) => n.content))
    .toEqual(["x", "Attendees", "Notes"]);
});

test("Settings lists the templates and chooses the journal template by writing the property", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".set-panel");
  await expect(panel).toContainText("Templates");

  const select = panel.locator("#set-journal-template");
  await expect(select.locator("option")).toHaveText(["None", "daily", "meeting"]);
  await expect(select).toHaveValue("");

  const [daily] = await readTree(page, LIBRARY);
  await select.selectOption({ label: "daily" });
  await expect(select).toHaveValue(daily?.id as string);

  // The setting IS the property: the server sees `journal-template:: true` once the write syncs.
  await expect
    .poll(async () => {
      const out = await api<{ block: Node }>(page, "block.read", { id: daily?.id });
      return out.block.properties?.["journal-template"];
    })
    .toBe("true");
  // Reopening shows the choice, read back from the graph rather than remembered locally.
  await page.reload();
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#set-journal-template")).toHaveValue(daily?.id as string);
});

test("a day started in the app begins with the journal template, the typed text after it", async ({
  page,
}) => {
  await page.goto("/journals");
  // B-583: the trigger is now a top-bar icon (accessible name "Calendar"), not an inline toggle.
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const calendar = page.locator(".calendar");
  // Two months ahead, the 15th: a day no other spec touches and that certainly has no page.
  await calendar.getByRole("button", { name: "Next month" }).click();
  await calendar.getByRole("button", { name: "Next month" }).click();
  await calendar.getByRole("button", { name: "15", exact: true }).click();

  const pinned = page.locator(".journal-day-pinned");
  const draft = pinned.locator(".vr-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("first thought");
  await page.keyboard.press("Enter");

  const outliner = pinned.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row")).toHaveCount(5);
  const texts = await rowTexts(page, outliner);
  const target = new Date();
  target.setDate(1);
  target.setMonth(target.getMonth() + 2);
  target.setDate(15);
  const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-15`;
  // A rendered row shows the link's text without its brackets; the exact `[[…]]` content is
  // asserted through the API below.
  expect(texts[0]).toContain(`Daily plan for ${defaultTitle(iso)}`);
  expect(texts[1]).toContain("Gratitude");
  expect(texts[2]).toMatch(TIME_RE);
  expect(texts[3]).toBe("first thought");
  expect(texts[4]).toBe("");
  expect(await rowDepths(page, outliner)).toEqual([0, 1, 1, 0, 0]);
  await expect(outliner.locator(".cm-content")).toBeFocused();

  // The day was written on the client; the server learns of it on the next push, so "no such
  // page" is "not yet", not a failure — `api()` throws on a 404, which would end the poll.
  await expect
    .poll(async () => {
      try {
        return (await readTree(page, iso)).map((n) => n.content);
      } catch {
        return [];
      }
    })
    .toEqual([`Daily plan for [[${defaultTitle(iso)}]]`, "first thought", ""]);
});

test("a day created through the API begins with the journal template, before what was appended", async ({
  page,
}) => {
  // Not 400: pages.spec.ts creates that day earlier in a full run, and a day that already exists
  // has no birth for the journal template to attach to. Every spec shares one server.
  const iso = isoOffset(407);
  await api(page, "page.append", { page: iso, markdown: "- appended by an agent" });
  const tree = await readTree(page, iso);
  expect(tree.map((n) => n.content)).toEqual([
    `Daily plan for [[${defaultTitle(iso)}]]`,
    "appended by an agent",
  ]);
  expect(tree[0]?.children.map((c) => c.content)).toEqual([
    "Gratitude",
    expect.stringMatching(/^plan the day at \d{2}:\d{2}$/),
  ]);
  expect(tree[0]?.properties?.template).toBeUndefined();

  // And the app shows it as an upcoming day with the same blocks.
  await page.goto("/journals");
  const upcoming = page.locator(".journal-day-upcoming", { hasText: "appended by an agent" });
  await expect(upcoming).toContainText("Gratitude");
});

test("dynamic dates use the reader's journal date format", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#set-journal-format").selectOption("yyyy-MM-dd");
  await page.locator(".set-close").click();

  const outliner = await openEditing(page, "Templates Dates", "- x");
  await page.keyboard.press("Enter");
  await pickTemplate(page, "daily");

  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  const texts = await rowTexts(page, outliner);
  expect(texts[1]).toContain(`Daily plan for [[${isoOffset(0)}]]`);
  expect(texts[3]).toMatch(TIME_RE);
});

test("the picker closes on Escape and leaves the block as it was", async ({ page }) => {
  const outliner = await openEditing(page, "Templates Escape", "- untouched");
  await page.keyboard.type(" /template");
  await page
    .locator(".cmd-popup")
    .first()
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker: Locator = page.locator(".tpl-picker");
  await expect(picker).toBeVisible();
  await page.keyboard.type("dai");
  await expect(picker.locator(".tpl-picker-text")).toHaveText("dai");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  // Nothing typed into the filter reached the block, and nothing was inserted.
  await expect(page.locator(".cm-content")).toHaveText("untouched ");
  expect(await rowTexts(page, outliner)).toHaveLength(1);
});
