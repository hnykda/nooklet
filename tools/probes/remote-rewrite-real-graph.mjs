// Probe (2026-09-13, m11/remote-rewrite, B-192): on a copy of the owner's real graph, does the block
// being edited follow an agent's `block.update` — Czech text, a journal day with many blocks — with
// nothing typed, and offer it over unsaved typing?
//
// Setup, never against ~/.nooklet/default:
//   export NOOKLET_DATA=<scratch>/data
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"
//   pnpm --filter @nooklet/web build
//   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <scratch>/graph --port <p> --no-mirror
//   NOOKLET_PROBE_URL=http://127.0.0.1:<p> NOOKLET_PROBE_DAY=2026-08-17 \
//     NOOKLET_PROBE_BLOCK=<id of a top-level block on that day> node tools/probes/remote-rewrite-real-graph.mjs
//
// Prints what it saw at each step; exits 1 if a step did not go as B-192's rule says.
import { chromium } from "@playwright/test";

const base = process.env.NOOKLET_PROBE_URL ?? "http://127.0.0.1:6413";
const day = process.env.NOOKLET_PROBE_DAY ?? "2026-08-17";
const blockId = process.env.NOOKLET_PROBE_BLOCK ?? "1m287mdbqzg33c";

for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const token = (await (await fetch(`${base}/api/session`)).json()).token;
async function op(name, body) {
  const res = await fetch(`${base}/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function stored() {
  return (await op("block.read", { id: blockId, format: "json", depth: 0 })).block?.content ?? null;
}

let failed = false;
function check(label, ok, detail) {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failed = true;
}
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const original = await stored();
console.log("block before:", JSON.stringify(original));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const t0 = Date.now();
await page.goto(`${base}/page/${day}`);
const row = page.locator(`.vr-row[data-block-id="${blockId}"]`);
await row.waitFor({ timeout: 180_000 });
console.log("rows on the day:", await page.locator(".vr-row").count(), `(${Date.now() - t0} ms)`);
// The editor's DOM text: live preview hides `[[`/`]]` away from the caret, so expected texts are
// compared with the brackets taken out (`shown`).
const text = () =>
  page.evaluate(() =>
    [...(document.querySelector(".cm-content")?.querySelectorAll(".cm-line") ?? [])]
      .map((l) => l.textContent ?? "")
      .join("\n"),
  );
const shown = (s) => s.replaceAll("[[", "").replaceAll("]]", "");

// 1. Nothing typed: the editor follows the agent.
await row.locator(".vr-block-view").click();
await page.locator(".cm-content").waitFor();
await page.keyboard.press("End");
const clean = `${original} — přepsáno agentem`;
await op("block.update", { id: blockId, content: clean });
check(
  "editor took the agent's text",
  await until(async () => (await text()) === shown(clean)),
  await text(),
);
check("no notice", (await page.locator(".vr-remote-notice").count()) === 0);
await page.keyboard.type(" ✓ dál");
check(
  "typing continues after it",
  await until(async () => (await stored()) === `${clean} ✓ dál`),
  await stored(),
);

// 2. Unsaved typing: the notice, then "Use the other version".
await page.waitForTimeout(800);
await page.keyboard.type(" píšu");
const theirs = `${original} — druhá verze`;
const write = op("block.update", { id: blockId, content: theirs });
let typed = "";
const end = Date.now() + 20_000;
while (Date.now() < end && (await page.locator(".vr-remote-notice").count()) === 0) {
  await page.keyboard.type("ž");
  typed += "ž";
  await page.waitForTimeout(60);
}
await write;
check("notice shown over unsaved typing", (await page.locator(".vr-remote-notice").count()) === 1);
check("typing kept", (await text()) === shown(`${clean} ✓ dál píšu${typed}`), await text());
await page.getByRole("button", { name: "Use the other version" }).click();
check(
  "editor shows the other version",
  await until(async () => (await text()) === shown(theirs)),
  await text(),
);
check(
  "stored is the other version",
  await until(async () => (await stored()) === theirs),
  await stored(),
);

// Put the block back as it was.
await page.keyboard.press("Escape");
await op("block.update", { id: blockId, content: original });
console.log("errors:", JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
