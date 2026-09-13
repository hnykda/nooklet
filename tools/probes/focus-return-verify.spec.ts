/**
 * Probe (2026-09-13, verification of m9/focus): the edges of "the palette gives focus back" and two
 * older neighbours. Prints; does not assert. Settled B-293, B-294, B-295 and B-296 in
 * docs/bugs-inbox/focus.md — run it against `cf08d19`'s `apps/web/src` to see the "before" column.
 *
 * To re-run, copy it into `e2e/tests/` and:
 *   NOOKLET_DATA=<scratch>/data NOOKLET_E2E_PORT=<your port> pnpm e2e --project=chromium <copy> --repeat-each=2
 * then delete the copy.
 */
import { expect, type Page, test } from "@playwright/test";
import { activeElement, MOD, openEditing, readBlocks, seedPage } from "../helpers/index.js";

const tag = (info: { repeatEachIndex: number; retry: number }) =>
  `${info.repeatEachIndex}-${info.retry}-${Date.now() % 100000}`;
/** Plain text first: `openEditing` clicks the middle of the block, which must not be the link. */
const PAD = "plain words to click on before the link ".repeat(3);

/** End walks one wrap point at a time on a wrapped line; walk to the block's real end. */
async function toBlockEnd(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) await page.keyboard.press("End");
}

/** Type `qq` straight after `choose` and report where focus was and what the page left holds. */
async function typeAhead(page: Page, from: string, choose: () => Promise<void>, url: RegExp) {
  await choose();
  const active = await activeElement(page);
  await page.keyboard.type("qq");
  await expect(page).toHaveURL(url);
  await page.waitForTimeout(1500);
  return { active, left: (await readBlocks(page, from)).map((b) => b.content) };
}

test("B-293: a palette page row, create row and Follow link command, then type at once", async ({
  page,
}, info) => {
  const t = tag(info);
  const target = `Probe FRV Target ${t}`;
  await seedPage(page, target, "- over there");
  for (const kind of ["page row", "create row", "follow link command"] as const) {
    const from = `Probe FRV From ${kind} ${t}`;
    const created = `Probe FRV Created ${t}`;
    await openEditing(
      page,
      from,
      kind === "follow link command" ? `- ${PAD}[[${target}]]` : "- origin",
    );
    await toBlockEnd(page);
    await page.keyboard.press(`${MOD}+k`);
    const query =
      kind === "page row" ? target : kind === "create row" ? created : ">Follow link under cursor";
    await page.keyboard.type(query);
    const want =
      kind === "create row" ? "Create page" : kind === "page row" ? target : "Follow link";
    await expect(page.locator(".cmd-palette .cmd-row", { hasText: want }).first()).toBeVisible();
    for (let i = 0; i < 20; i++) {
      if ((await page.locator(".cmd-palette .cmd-row--active").textContent())?.includes(want))
        break;
      await page.keyboard.press("ArrowDown");
    }
    const dest = kind === "create row" ? created : target;
    const out = await typeAhead(
      page,
      from,
      () => page.keyboard.press("Enter"),
      new RegExp(encodeURIComponent(dest), "i"),
    );
    console.log("B-293", kind, JSON.stringify(out));
  }
});

test("B-295: Alt+Enter follows a link, then type at once", async ({ page }, info) => {
  const t = tag(info);
  const target = `Probe FRV Alt Target ${t}`;
  const from = `Probe FRV Alt From ${t}`;
  await seedPage(page, target, "- x");
  await openEditing(page, from, `- ${PAD}[[${target}]]`);
  await toBlockEnd(page);
  const out = await typeAhead(
    page,
    from,
    () => page.keyboard.press("Alt+Enter"),
    new RegExp(encodeURIComponent(target), "i"),
  );
  console.log("B-295", JSON.stringify(out));
});

test("B-294: Enter on the autocomplete a walk into a complete link opened", async ({
  page,
}, info) => {
  const t = tag(info);
  const target = `Probe FRV Walk ${t}`;
  const name = `Probe FRV Walk From ${t}`;
  await seedPage(page, target, "- x");
  await openEditing(page, name, `- alpha [[${target}]] ${PAD}`);
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator(".cmd-popup")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  console.log("B-294", JSON.stringify((await readBlocks(page, name))[0]?.content));
});

for (const how of ["key", "insertText at once", "insertText after 50 ms"] as const) {
  test(`B-296: caret at offset 2, Cmd+K, Escape, then text via ${how}`, async ({ page }, info) => {
    const name = `Probe FRV Caret ${how} ${tag(info)}`;
    await openEditing(page, name, "- abcdefghij\n- other");
    let expected = "abcdefghij";
    for (const mark of ["0", "1", "2", "3"]) {
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press(`${MOD}+k`);
      await expect(page.locator(".cmd-palette .cmd-input")).toBeFocused();
      await page.keyboard.press("Escape");
      if (how === "key") await page.keyboard.type(mark);
      else {
        if (how === "insertText after 50 ms") await page.waitForTimeout(50);
        await page.keyboard.insertText(mark);
      }
      expected = `ab${mark}${expected.slice(2)}`;
    }
    await page.waitForTimeout(900);
    const got = (await readBlocks(page, name))[0]?.content;
    console.log(
      "B-296",
      how,
      got,
      got === expected ? "caret kept" : `caret lost (want ${expected})`,
    );
  });
}
