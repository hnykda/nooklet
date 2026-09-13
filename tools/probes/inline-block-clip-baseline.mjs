// Probe (2026-09-13, docs/BUGS.md B-138): can `.vr-math-rendered` clip what a formula paints
// outside its own box without moving the formula off the text baseline?
//
// CSS 2.1 puts an inline-block's baseline at its bottom margin edge when `overflow` is not
// `visible`, which would lift every formula with a descender. `overflow: clip` is not a scroll
// container, so engines may keep the content baseline. This renders the same KaTeX-shaped inline
// span with each candidate style next to plain text and prints how far the formula's own baseline
// marker moved relative to the unstyled one, and whether a `\raisebox`/`\kern`-style offset child
// still paints outside the box.
//
// Run: node tools/probes/inline-block-clip-baseline.mjs   (needs e2e's Playwright browsers)
//
// Result, Playwright 1.63 Chromium and WebKit, 2026-09-13 (baseline offset; 4 = unstyled):
//   none                              4 / 4    offset child paints outside: yes
//   inline-block + overflow:hidden   -7 / -7   clipped (baseline lifted 11px in both engines)
//   inline-block + overflow:clip      4 / -7   clipped (WebKit — the Tauri host — lifts it)
//   overflow:clip on the inline span  4 / 4    NOT clipped (containment needs an atomic box)
//   inline-block + contain:paint      4 / 4    clipped
// So the review's suggested `display:inline-block; overflow:hidden` would misalign every formula;
// `contain: paint` is the only candidate that clips without moving the baseline. Not adopted for
// B-138 (KaTeX `maxSize` fixed the reported box; see apps/web/src/editor/render/math.ts).
import { createRequire } from "node:module";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium, webkit } = require("@playwright/test");

const variants = {
  none: "",
  "inline-block + overflow:hidden": "display:inline-block;max-width:100%;overflow:hidden",
  "inline-block + overflow:clip": "display:inline-block;max-width:100%;overflow:clip",
  "overflow:clip only (inline)": "overflow:clip",
  "inline-block + contain:paint": "display:inline-block;max-width:100%;contain:paint",
};

const html = Object.entries(variants)
  .map(
    ([, style], i) => `
<p style="font:16px/1.5 serif;margin:40px 0">text g
  <span id="v${i}" style="${style}"><span style="display:inline-block;vertical-align:-0.25em">yg<i id="m${i}" style="display:inline-block;width:1px;height:0"></i></span><span id="o${i}" style="position:relative;top:-3em;left:-8em;background:red">OUT</span></span>
  <i id="t${i}" style="display:inline-block;width:1px;height:0"></i> after</p>`,
  )
  .join("");

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body style="margin:0 200px">${html}</body>`);
  const rows = await page.evaluate((names) => {
    const out = [];
    names.forEach((name, i) => {
      const box = document.getElementById(`v${i}`).getBoundingClientRect();
      const marker = document.getElementById(`m${i}`).getBoundingClientRect();
      const text = document.getElementById(`t${i}`).getBoundingClientRect();
      const outEl = document.getElementById(`o${i}`).getBoundingClientRect();
      // Is the offset child's centre actually painted (hit-testable) outside the formula box?
      const cx = outEl.left + outEl.width / 2;
      const cy = outEl.top + outEl.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      out.push({
        variant: name,
        "formula baseline - text baseline (px)": Math.round((marker.top - text.top) * 100) / 100,
        "offset child visible outside box": hit?.id === `o${i}`,
        "box height": Math.round(box.height * 100) / 100,
      });
    });
    return out;
  }, Object.keys(variants));
  console.log(engineName);
  console.table(rows);
  await browser.close();
}
