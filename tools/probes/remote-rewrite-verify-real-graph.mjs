// Probe (2026-09-13, m11/remote-rewrite verification pass, B-461/B-462): on a copy of the owner's
// real graph, a LATER task on a journal day with Czech text.
//   1. An agent flips the marker (`old_str: "LATER"` → `"NOW"`) while typing continues: no notice,
//      the typing and the new marker are both stored (B-462).
//   2. This tab's clock 20 s behind: an agent rewrites the block, the editor takes it, typing on it
//      is stored (B-461).
// The block is put back as it was at the end.
//
// Setup, never against ~/.nooklet/default:
//   export NOOKLET_DATA=<scratch>/data
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"
//   pnpm --filter @nooklet/web build
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <scratch>/graph --port <p> --no-mirror)
//   NOOKLET_PROBE_URL=http://127.0.0.1:<p> NOOKLET_PROBE_DAY=2023-09-19 \
//     NOOKLET_PROBE_BLOCK=<id of a top-level LATER block on that day> \
//     node tools/probes/remote-rewrite-verify-real-graph.mjs
//
// Prints what it saw (texts shortened); exits 1 if a step went wrong.
import { chromium } from "@playwright/test";

const base = process.env.NOOKLET_PROBE_URL ?? "http://127.0.0.1:6413";
const day = process.env.NOOKLET_PROBE_DAY ?? "2023-09-19";
const blockId = process.env.NOOKLET_PROBE_BLOCK ?? "1m287mdbh63gev";

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
async function read() {
  return (await op("block.read", { id: blockId, format: "json", depth: 0 })).block;
}
const tail = (s) => (typeof s === "string" ? `…${s.slice(-40)}` : s);

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

const before = await read();
check("block is a LATER task", before?.marker === "LATER", before?.marker);

const browser = await chromium.launch();
const errors = [];
async function openDay(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/page/${day}`);
  const row = page.locator(`.vr-row[data-block-id="${blockId}"]`);
  await row.waitFor({ timeout: 180_000 });
  await row.locator(".vr-block-view").click();
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("End");
  return page;
}
const notices = (page) => page.locator(".vr-remote-notice").count();

// 1. Marker flip while typing.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await openDay(context);
  const row = page.locator(`.vr-row[data-block-id="${blockId}"]`);
  await page.keyboard.type(" ověřeno");
  const flip = op("block.update", { id: blockId, old_str: "LATER", new_str: "NOW" });
  let typed = "";
  const end = Date.now() + 20_000;
  while (Date.now() < end && (await row.locator(".vr-marker-NOW").count()) === 0) {
    await page.keyboard.type("č");
    typed += "č";
    await page.waitForTimeout(60);
  }
  await flip;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.type("ř");
    await page.waitForTimeout(60);
  }
  check("marker pill shows NOW", (await row.locator(".vr-marker-NOW").count()) === 1);
  check("no notice over the typing", (await notices(page)) === 0);
  const want = `${before.content} ověřeno${typed}řřřřř`;
  check(
    "typing stored",
    await until(async () => (await read())?.content === want),
    tail((await read())?.content),
  );
  check("marker stored NOW", (await read())?.marker === "NOW", (await read())?.marker);
  await page.keyboard.press("Escape");
  await context.close();
}

// 2. Clock behind, take, type.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.clock.setFixedTime(Date.now() - 20_000);
  const page = await openDay(context);
  const rewritten = `NOW ${before.content} — přepsáno`;
  await op("block.update", { id: blockId, content: rewritten });
  check(
    "editor took the rewrite",
    await until(
      async () =>
        (await notices(page)) === 0 &&
        (await page.locator(".cm-content").textContent())?.endsWith("— přepsáno"),
    ),
    tail(await page.locator(".cm-content").textContent()),
  );
  await page.keyboard.type(" a dál");
  check(
    "typing on it stored with the clock 20 s behind",
    await until(async () => (await read())?.content === `${before.content} — přepsáno a dál`),
    tail((await read())?.content),
  );
  await page.keyboard.press("Escape");
  await context.close();
}

// A single-line task without properties (checked above by the marker; the block's content has no
// newline on the probed block): its raw text is the marker and the content.
await op("block.update", { id: blockId, content: `LATER ${before.content}` });
const after = await read();
check(
  "block put back",
  after?.content === before.content && after?.marker === "LATER",
  tail(after?.content),
);
console.log("errors:", JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
