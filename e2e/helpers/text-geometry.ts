/**
 * Where characters of a row's text are on screen — the rendered view's or, for the row being
 * edited, the live editor's. For tests about text geometry (B-821's larger zoom root): where a click
 * puts the caret, whether entering edit mode moves the text, how the bullet lines up with it.
 */
import type { Locator } from "@playwright/test";

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

/**
 * The box of character `index` of `row`'s visible text (the `.cm-content` if the row is being
 * edited, else its `.vr-block-view`), counted over its text nodes in order. A negative index counts
 * from the end (`-1` is the last character).
 */
export async function charBox(row: Locator, index: number): Promise<Box> {
  return row.evaluate((el, index) => {
    const root = el.querySelector(".cm-content") ?? el.querySelector(".vr-block-view");
    if (!root) throw new Error("row has no text");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const total = nodes.reduce((sum, n) => sum + n.data.length, 0);
    let at = index < 0 ? total + index : index;
    for (const node of nodes) {
      if (at < node.data.length) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
      }
      at -= node.data.length;
    }
    throw new Error(`no character ${index} in ${total}`);
  }, index);
}

/** The vertical centre of `loc`'s box. */
export async function centreY(loc: Locator): Promise<number> {
  const box = await loc.boundingBox();
  if (!box) throw new Error("not on screen");
  return box.y + box.height / 2;
}

/** `loc`'s computed line height in px. */
export async function lineHeight(loc: Locator): Promise<number> {
  return loc.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
}

/** `loc`'s computed font size in px. */
export async function fontSize(loc: Locator): Promise<number> {
  return loc.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}
