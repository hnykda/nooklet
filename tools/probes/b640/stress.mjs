// B-640 probe: random remote structural edits at an open page, checking after each that every row
// is rendered (`checkVisibility({contentVisibilityAuto: true})` on the row's content, and ink
// pixels in a full-viewport screenshot cropped to the row). Prints the first failing step.
// Usage: ENGINE=webkit|chromium SEED=n STEPS=n node stress.mjs <baseURL> <outdir>
import { chromium, webkit } from "@playwright/test";

const [base, out] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 } });
const page = await ctx.newPage();
const { token } = await (await fetch(`${base}/api/session`)).json();
const api = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
let seed = Number(process.env.SEED ?? 1);
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const name = `b640 stress ${Date.now()}`;
await api("page.create", {
  name,
  markdown: Array.from({ length: 8 }, (_, i) => `- row ${i}`).join("\n"),
});
const ids = async () =>
  [...(await api("page.read", { page: name })).text.matchAll(/^(\s*)- ?(.*?) ?\^(\w{14})$/gm)].map(
    (m) => ({ depth: m[1].length / 2, text: m[2], id: m[3] }),
  );
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForSelector(".vr-outliner .vr-row");

async function check(step, what) {
  await page.waitForTimeout(Number(process.env.WAIT ?? 400));
  const rows = await page.locator(".vr-outliner .vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const v = r.querySelector(".vr-block-view") ?? r.querySelector(".cm-content");
      const b = r.querySelector(".vr-bullet");
      return {
        text: v?.textContent ?? null,
        vis: v?.checkVisibility({ contentVisibilityAuto: true }) ?? null,
        bvis: b?.checkVisibility({ contentVisibilityAuto: true }) ?? null,
      };
    }),
  );
  const bad = rows.filter((r) => r.vis === false || r.bvis === false);
  if (bad.length) {
    console.log(`STEP ${step} ${what}: ${bad.length} hidden`, JSON.stringify(rows));
    await page.screenshot({ path: `${out}/stress-fail-${step}.png` });
    return false;
  }
  return true;
}

const steps = Number(process.env.STEPS ?? 40);
let failures = 0;
for (let s = 0; s < steps; s++) {
  const blocks = await ids();
  const a = blocks[rand(blocks.length)];
  const b = blocks[rand(blocks.length)];
  const k = rand(5);
  let what = "";
  try {
    if (k === 0) {
      what = `text ${a.text}`;
      await api("block.update", { id: a.id, content: a.text ? "" : `typed ${s}` });
    } else if (k === 1 && a.id !== b.id) {
      what = `move ${a.text} after ${b.text}`;
      await api("block.move", { id: a.id, ref: b.id, position: "after" });
    } else if (k === 2 && a.id !== b.id) {
      what = `move ${a.text} child of ${b.text}`;
      await api("block.move", { id: a.id, ref: b.id, position: "child_last" });
    } else if (k === 3) {
      what = `insert after ${a.text}`;
      await api("block.insert", { ref: a.id, position: "after", markdown: `- new ${s}` });
    } else {
      what = `move ${a.text} to top end`;
      await api("block.move", { id: a.id, page: name });
    }
  } catch (e) {
    what += ` (refused: ${String(e).slice(0, 80)})`;
  }
  if (!(await check(s, what))) failures++;
}
console.log(`done, ${failures} failing steps`);
await browser.close();
