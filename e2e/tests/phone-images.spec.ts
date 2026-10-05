/**
 * Phone fixes from the owner's second iPhone round (2026-10-04), at an iPhone 13's viewport with
 * touch: B-684 (the slash menu opening one keystroke late), B-681 (the menu next to the caret),
 * B-682/B-683 (an uploaded image: its own aspect ratio, never wider than the screen), and a sweep
 * of the other block content that could widen the page at phone width.
 *
 * Runs in both projects (Chromium and WebKit). The real iOS keyboard and photo picker were driven
 * on the Simulator (`tools/probes/phone-images/`).
 */

import { devices, expect, type Page, test } from "@playwright/test";
import { api, clickAway, editor, openEditing, openPage, seedPage } from "../helpers/index.js";
import { solidPng } from "../helpers/png.js";

test.use({ ...devices["iPhone 13"] });

const popup = (page: Page) => page.locator(".cmd-popup");

/** The page is no wider than the screen, and nothing has zoomed it (B-648, B-683). */
async function expectWithinScreen(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    scale: window.visualViewport?.scale ?? 1,
  }));
  expect(m.docW, "document scrollWidth vs innerWidth").toBeLessThanOrEqual(m.innerW);
  expect(m.scale).toBe(1);
}

test("B-684: `/` alone opens the slash menu, with no further keystroke", async ({ page }) => {
  await openEditing(page, "Phone Slash Alone", "- start");
  await page.keyboard.type(" /");
  await expect(editor(page)).toHaveText("start /");
  await expect(popup(page)).toBeVisible();
});

test("B-684: a `/` that reaches the editor with no event after it still opens the menu", async ({
  page,
}) => {
  // What iOS can do (CodeMirror's `DOMObserver`: during a composition WebKit's mutations are
  // read a frame later, `flushSoon`): the editor takes in the `/` AFTER the last key/input event
  // has been and gone, so a detection that only runs on those events looks before the `/` is
  // there and nothing looks again until the next key. Here the text node is changed directly —
  // no keydown, no beforeinput, no input, no keyup — and only CodeMirror's own mutation
  // observer sees it.
  await openEditing(page, "Phone Slash Late", "- start");
  await page.locator(".cm-content .cm-line").evaluate((line) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
    if (!last) throw new Error("no text node in the line");
    last.data += " /";
    const sel = window.getSelection();
    sel?.collapse(last, last.data.length);
  });
  await expect(editor(page)).toHaveText("start /");
  await expect(popup(page)).toBeVisible();
  // Exactly one menu, and the query still filters it as it is typed.
  await expect(popup(page)).toHaveCount(1);
  await page.keyboard.type("tod");
  await expect(popup(page)).toContainText(/TODO/);
});

test("B-681: the slash menu opens at the caret and stays on the screen", async ({ page }) => {
  await openEditing(page, "Phone Slash Position", "- a line of text to type after");
  await page.keyboard.type(" /");
  await expect(popup(page)).toBeVisible();
  const m = await page.evaluate(() => {
    const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const p = document.querySelector(".cmd-popup")?.getBoundingClientRect();
    return {
      caret: r ? { left: r.left, top: r.top, bottom: r.bottom } : null,
      popup: p ? { left: p.left, right: p.right, top: p.top, bottom: p.bottom } : null,
      vw: window.visualViewport?.width ?? window.innerWidth,
      vh: window.visualViewport?.height ?? window.innerHeight,
    };
  });
  if (!m.caret || !m.popup) throw new Error("no caret or popup");
  // Just below the caret line (or just above it, flipped) — never across the screen.
  const gap = Math.min(
    Math.abs(m.popup.top - m.caret.bottom),
    Math.abs(m.caret.top - m.popup.bottom),
  );
  expect(gap).toBeLessThan(24);
  expect(Math.abs(m.popup.left - m.caret.left)).toBeLessThan(m.vw);
  expect(m.popup.left).toBeGreaterThanOrEqual(0);
  expect(m.popup.right).toBeLessThanOrEqual(m.vw);
  expect(m.popup.bottom).toBeLessThanOrEqual(m.vh);
  await expectWithinScreen(page);
});

/** Every element in the page scroller whose box reaches past the screen's right edge, unless an
 * ancestor clips or scrolls it within the screen (a code block's own horizontal scroll is fine:
 * the page does not widen). */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = window.innerWidth + 0.5;
    const out: string[] = [];
    const scroller = document.querySelector(".page-scroll");
    for (const el of document.querySelectorAll<HTMLElement>(".page-scroll *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= limit) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== scroller; a = a.parentElement) {
        if (
          getComputedStyle(a).overflowX !== "visible" &&
          a.getBoundingClientRect().right <= limit
        ) {
          clipped = true;
          break;
        }
      }
      // The outermost offender only: its descendants overflow because it does.
      const parent = el.parentElement;
      const parentOver = parent && parent.getBoundingClientRect().right > limit;
      if (!clipped && !parentOver) {
        out.push(`${el.tagName}.${el.className} right=${Math.round(r.right)}`);
      }
    }
    return out;
  });
}

async function uploadPng(page: Page, name: string, width: number, height: number) {
  return api<{ markdown: string }>(page, "asset.upload", {
    filename: `${name}.png`,
    mime_type: "image/png",
    data_base64: solidPng(width, height, [30, 120, 200]).toString("base64"),
  });
}

test("B-682/B-683: an image picked with /image keeps its aspect ratio, no bars, within the screen", async ({
  page,
}) => {
  await openEditing(page, "Phone Image Insert", "- look");
  await page.keyboard.type(" /image");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  // 3:1 and three times the phone's width: it must be scaled down, not overflow.
  await (await chooser).setFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: solidPng(1200, 400, [200, 30, 30]),
  });
  await expect(editor(page)).toContainText("assets/");
  await expectWithinScreen(page);
  await clickAway(page);
  const img = page.locator("img.vr-image").first();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1200);
  const box = await img.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const content = el.closest(".vr-content")?.getBoundingClientRect();
    return { w: r.width, h: r.height, right: r.right, contentW: content?.width ?? 0 };
  });
  // The box IS the picture: its own aspect ratio (no letterbox bars), as wide as the block allows.
  expect(box.w / box.h).toBeCloseTo(3, 1);
  expect(Math.abs(box.w - box.contentW)).toBeLessThan(1);
  expect(box.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  await expectWithinScreen(page);
  expect(await overflowingElements(page)).toEqual([]);
});

test("B-682: a small image keeps its own size, a tall one is capped in height at its ratio", async ({
  page,
}) => {
  await page.goto("/journals");
  const small = await uploadPng(page, "small", 120, 60);
  const tall = await uploadPng(page, "tall", 400, 2000);
  await openPage(page, "Phone Image Sizes", `- ${small.markdown}\n- ${tall.markdown}`);
  const imgs = page.locator("img.vr-image");
  await expect(imgs).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect
      .poll(() => imgs.nth(i).evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  }
  const [s, t] = await imgs.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }),
  );
  if (!s || !t) throw new Error("images missing");
  // Not stretched to the block's width: 120×60 stays 120×60.
  expect(s).toEqual({ w: 120, h: 60 });
  // A 1:5 portrait does not run several screens long, and is not squashed doing it.
  const vh = await page.evaluate(() => window.innerHeight);
  expect(t.h).toBeLessThanOrEqual(vh);
  expect(t.w / t.h).toBeCloseTo(0.2, 2);
  await expectWithinScreen(page);
});

test("phone overflow sweep: nothing in a block widens the page past the screen", async ({
  page,
}) => {
  await page.goto("/journals");
  const longUrl = `https://example.com/${"a-very-long-path-segment-".repeat(8)}end?q=${"x".repeat(60)}`;
  const word = "Donaudampfschifffahrtselektrizitatenhauptbetriebswerkbauunterbeamtengesellschaft";
  const wide = await uploadPng(page, "sweep-wide", 2000, 300);
  const markdown = [
    `- a bare link ${longUrl}`,
    `- a labelled [link](${longUrl}) and an autolink <${longUrl}>`,
    `- ${word}${word}`,
    `- [[${word} page]] and #${word}`,
    `- inline \`${"code_without_spaces_".repeat(10)}\``,
    `- \`\`\`\n  const x = "${"long line of code without any wrapping at all ".repeat(4)}";\n  \`\`\``,
    // No leading pipes: with them every cell currently renders as "|" (found in this sweep,
    // `tools/probes/phone-images/table-cells.spec.ts`), and a table of bars is not wide.
    "- a | b | c | d | e | f\n  ---|---|---|---|---|---\n" +
      `  ${"wide cell text ".repeat(3)} | ${"more ".repeat(6)} | c | d | e | ${word}`,
    `- $$${"x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + ".repeat(3)}y$$`,
    `- ${wide.markdown}`,
    `- > a quote with ${longUrl}`,
    "- ```mermaid\n  graph LR\n    A-->B-->C-->D-->E-->F-->G-->H-->I-->J-->K-->L\n  ```",
    "- {{embed [[Phone Overflow Embedded]]}}",
  ].join("\n");
  await seedPage(page, "Phone Overflow Embedded", `- embedded ${longUrl} ${word}`);
  await openPage(page, "Phone Overflow Sweep", markdown);
  await expect(page.locator(".vr-embed")).toContainText("embedded");
  await expect(page.locator(".vr-table")).toContainText("wide cell text");
  const diagram = page.locator(".vr-plugin-fence svg");
  await diagram.evaluate((el) => el.closest(".vr-row")?.scrollIntoView());
  await expect(diagram).toBeVisible();
  await expect(page.locator(".katex").first()).toBeVisible();
  // `loading="lazy"`: below the fold it is not fetched until scrolled to — and an unloaded image
  // is 0×0, which `scrollIntoViewIfNeeded` does not move to, so its row is scrolled to instead.
  const img = page.locator("img.vr-image");
  await img.evaluate((el) => el.closest(".vr-row")?.scrollIntoView());
  // Loaded: a resized copy (B-738, ADR 035), so narrower than the 2000-px original.
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await overflowingElements(page)).toEqual([]);
  await expectWithinScreen(page);
  const scroll = await page.evaluate(() => {
    const s = document.querySelector(".page-scroll") as HTMLElement;
    return { sw: s.scrollWidth, cw: s.clientWidth };
  });
  expect(scroll.sw).toBeLessThanOrEqual(scroll.cw);

  // And while editing, where the same rows are CodeMirror lines holding the raw markdown.
  for (const row of [0, 2, 8]) {
    const view = page.locator(".vr-outliner").first().locator(".vr-row").nth(row);
    await view.scrollIntoViewIfNeeded();
    await view.locator(".vr-block-view").click();
    // Row 8 is only a full-width picture: a tap on it opens the image viewer (B-736), whose
    // "Edit block" is the way into that block's editor.
    const viewer = page.getByRole("dialog");
    if (row === 8) await viewer.getByRole("button", { name: "Edit block" }).click();
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await overflowingElements(page), `row ${row} while editing`).toEqual([]);
    await expectWithinScreen(page);
  }
});

test("B-789: a chosen size never takes a picture past the screen; no handle or ⋯ on a phone, the tap opens it", async ({
  page,
}, info) => {
  await page.goto("/journals");
  const pic = await uploadPng(page, "sized", 1200, 600);
  const small = await uploadPng(page, "sized-small", 160, 80);
  // A width wider than any phone (written on a desktop), and a small one aligned right.
  await openPage(
    page,
    `Phone Image Sized ${info.project.name}`,
    `- ${pic.markdown}{:height 1000, :width 2000}\n- ${small.markdown}{:width 100, :align "right"}`,
  );
  const imgs = page.locator("img.vr-image");
  await expect(imgs).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect
      .poll(() => imgs.nth(i).evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  }
  const [big, right] = await imgs.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const content = el.closest(".vr-content")?.getBoundingClientRect();
      return {
        w: r.width,
        h: r.height,
        right: r.right,
        contentW: content?.width ?? 0,
        contentRight: content?.right ?? 0,
      };
    }),
  );
  if (!big || !right) throw new Error("images missing");
  // As wide as the block allows, at its own ratio — not 2000 px.
  expect(Math.abs(big.w - big.contentW)).toBeLessThan(1);
  expect(big.w / big.h).toBeCloseTo(2, 1);
  // 100 px, against the right edge of the block.
  expect(right.w).toBeCloseTo(100, 0);
  expect(Math.abs(right.right - right.contentRight)).toBeLessThan(2);
  await expectWithinScreen(page);
  expect(await overflowingElements(page)).toEqual([]);

  // Touch gets neither control (ADR 034): the tap opens the viewer and its actions (in the
  // Capacitor app the button reads "Save / Share…"; this is a browser on a phone).
  await expect(page.locator(".vr-image-handle")).toHaveCount(0);
  await expect(page.locator(".vr-image-more")).toHaveCount(0);
  await imgs.first().tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Download" })).toBeVisible();
});
