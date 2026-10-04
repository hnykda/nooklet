// B-640 probe, no app involved: what the outliner's Enter does to the DOM, reduced to plain DOM
// calls, in a real engine. Enter inserts a new `content-visibility: auto` row and moves the single
// (focused, contenteditable) editor into it; the next Enter does the same again, and the row the
// editor left gets its read-only text back. Does that row stay skipped (never painted) in WebKit?
// Prints checkVisibility({contentVisibilityAuto}) of every row's text after two Enters.
// Usage: ENGINE=webkit|chromium node webkit-cv-focus.mjs
import { chromium, webkit } from "@playwright/test";

const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const page = await browser.newPage();

const variants = {
  editorMovedIn: { cv: "auto", editable: true, select: true },
  editorMovedInNoSelection: { cv: "auto", editable: true, select: false },
  inputMovedIn: { cv: "auto", editable: false, select: false },
  noContentVisibility: { cv: "visible", editable: true, select: true },
  // The candidate fix: the row holding the editor is exempt (`content-visibility: visible`), so
  // a row is only ever observed for `auto` once the editor has left it.
  editingRowExempt: { cv: "auto", editable: true, select: true, exempt: true },
};

for (const [label, v] of Object.entries(variants)) {
  await page.setContent(`<!doctype html>
<style>.row { content-visibility: ${v.cv}; contain-intrinsic-size: auto 31px; }
.row.editing { content-visibility: visible; }</style>
<div id="list"><div class="row"><span class="t">a</span></div></div>`);
  const result = await page.evaluate(async (v) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const ed = document.createElement(v.editable ? "div" : "input");
    if (v.editable) {
      ed.contentEditable = "true";
      ed.textContent = "x";
    }
    document.body.append(ed);
    const list = document.getElementById("list");
    // Enter: a new row, the editor moved into it, focused, caret placed.
    const enter = (text) => {
      const prev = ed.parentElement;
      const row = document.createElement("div");
      row.className = v.exempt ? "row editing" : "row";
      list.append(row);
      row.append(ed);
      ed.focus();
      if (v.select) getSelection().collapse(ed, 0);
      if (prev?.classList.contains("row")) {
        prev.classList.remove("editing");
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = text;
        prev.append(t);
      }
    };
    enter("");
    await frame();
    enter("b");
    await frame();
    enter("c");
    await frame();
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll(".row .t")].map(
      (t) => `${t.textContent}=${t.checkVisibility({ contentVisibilityAuto: true })}`,
    );
  }, v);
  console.log(label.padEnd(26), result.join("  "));
  if (process.env.SHOTS)
    await page.screenshot({
      path: `${process.env.SHOTS}/cv-${label}.png`,
      clip: { x: 0, y: 0, width: 200, height: 140 },
    });
}
await browser.close();
