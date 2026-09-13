/**
 * Probe (B-500, B-511): how much does ONE refresh re-render on a real page, and does a resolved
 * `((ref))` label ever fall back to `((id))` on the way? Written 2026-09-13 (ref-label-flash); the
 * numbers it gave are in `docs/progress/ref-label-flash.md` › Measurements.
 *
 * A "refresh" here is what the owner sees all day: another client writes one block on the open
 * page (an agent over the API, the phone), the server pokes, this tab pulls, and the page tree
 * re-reads. The probe makes that write N times per page and reports, per refresh:
 *
 *  - DOM: MutationObserver records, elements created, and snapshots in which a `.vr-block-ref`
 *    that was resolved before recording showed its `((id))` placeholder;
 *  - reactive work (only with an instrumentation patch applied, see below): `lookup` resolver
 *    calls, `refQuery` worker queries for ref text, `contentView`/`tokenView` rebuilds of rendered
 *    content, `rowBlockRead` per-row re-reads, `rowMount` row components created, `dateChips` and
 *    `propEntries` recomputations, `treeEffect` BlockTree tree effect runs, `treeUpdateMs` from the
 *    tree effect's `setLocalBlocks` to the end of Solid's synchronous flush;
 *  - Chromium only, on a second pass with no observer and fixed waits: main-thread time from the
 *    DevTools `Performance.getMetrics` deltas (`TaskDuration`, `ScriptDuration`, layout, style).
 *
 * The counters are `globalThis.__rlfc?.("name")` lines added to the client source by a patch:
 * `refresh-render-count.before.patch` applies to the client source of `3f070e9` (before the fixes),
 * `refresh-render-count.after.patch` to `5e57646`. Without a patch the DOM and Chromium halves
 * still run; the counters come back empty. Never commit the patched source.
 *
 * Usage (never point it at ~/.nooklet/default — copy the graph first; never port 6100):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   git checkout 3f070e9 -- apps/web/src && git apply tools/probes/refresh-render-count.before.patch
 *     (or, on 5e57646 or a descendant it still applies to: git apply ….after.patch)
 *   pnpm --filter @nooklet/web build
 *   NOOKLET_DATA=<scratch> pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6417 --no-mirror
 *   REF_IDS=<ids> URL=http://127.0.0.1:6417 PAGES="2022-12-16,OmnivoreSync,Ref Heavy" node tools/probes/refresh-render-count.mjs
 *   git checkout HEAD -- apps/web/src
 *
 * `Ref Heavy` is created on the copy by the probe if missing: 150 blocks, every third quoting one
 * of REF_IDS (real block ids from the copy, see below) by `((id))`. The owner's graph has only 43
 * blocks with a block ref, none with more than two per page, so without it the resolver numbers
 * would measure almost nothing.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium, webkit } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6417";
const pages = (process.env.PAGES ?? "2022-12-16,OmnivoreSync,Ref Heavy").split(",");
const N = Number(process.env.N ?? 5);
const engine = process.env.ENGINE === "webkit" ? webkit : chromium;

function pagePath(name) {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function api(page, op, body) {
  return page.evaluate(
    async ([op, body]) => {
      const { token } = await (await fetch("/api/session")).json();
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${JSON.stringify(json)}`);
      return json;
    },
    [op, body],
  );
}

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

const browser = await engine.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
await context.addInitScript(() => {
  window.__rlf = {};
  window.__rlfc = (k, n = 1) => {
    window.__rlf[k] = (window.__rlf[k] ?? 0) + n;
  };
});
const page = await context.newPage();
await page.goto(`${base}/journals`);
await page.locator(".vr-outliner, .vr-draft-input").first().waitFor({ timeout: 180_000 });

if (process.env.HEAVY !== "0" && pages.includes("Ref Heavy")) {
  const existing = await api(page, "page.read", { page: "Ref Heavy", format: "json" }).catch(
    () => null,
  );
  if (!existing?.tree?.length) {
    // Real block ids from the copy, picked by the caller (e.g.
    // `sqlite3 <dir>/graph.sqlite "SELECT group_concat(id) FROM (SELECT id FROM block WHERE
    // deleted_at IS NULL AND length(content) BETWEEN 20 AND 80 ORDER BY id LIMIT 50)"`).
    const ids = (process.env.REF_IDS ?? "").split(",").filter(Boolean);
    if (ids.length < 10) throw new Error(`search gave too few block ids: ${ids.length}`);
    const lines = [];
    for (let i = 0; i < 150; i++) {
      lines.push(
        i % 3 === 0
          ? `- line ${i} quoting ((${ids[i % ids.length]})) and [[Megapage]]`
          : `- line ${i} plain text`,
      );
    }
    await api(page, "page.create", { name: "Ref Heavy", markdown: lines.join("\n") });
  }
}

const report = [];
for (const name of pages) {
  const tree = flatten((await api(page, "page.read", { page: name, format: "json" })).tree);
  await page.goto(`${base}${pagePath(name)}`);
  await page.locator(".page-view .vr-outliner .vr-row").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(4000);
  const rows = await page.locator(".page-view .vr-outliner .vr-row").count();
  // A block under a collapsed parent has no row to watch; pick the last one that is on screen.
  const shown = new Set(
    await page
      .locator(".page-view .vr-outliner .vr-row")
      .evaluateAll((els) => els.map((e) => e.dataset.blockId)),
  );
  const target = [...tree]
    .reverse()
    .find(
      (b) => shown.has(b.id) && b.content && !b.content.includes("\n") && b.content.length < 200,
    );
  if (!target) throw new Error(`no editable block on ${name}`);

  // A run cut short leaves the marker behind; start from the unmarked text either way.
  const plain = target.content.replace(/ ·$/, "");
  let text = target.content;
  if (text !== plain) {
    await api(page, "block.update", { id: target.id, old_str: text, new_str: plain });
    text = plain;
    await page.waitForTimeout(2000);
  }

  await page.evaluate(() => {
    const placeholder = /^\(\([0-9a-z]+\)\)$/;
    const out = { records: 0, callbacks: 0, created: 0, flashSnapshots: 0, maxFlashed: 0 };
    const resolvedAtStart = new Set(
      [...document.querySelectorAll(".page-view .vr-block-ref")]
        .filter((e) => !placeholder.test(e.textContent ?? ""))
        .map(
          (e) =>
            e.getAttribute("data-from") + (e.closest("[data-block-id]")?.dataset.blockId ?? ""),
        ),
    );
    new MutationObserver((list) => {
      out.callbacks++;
      out.records += list.length;
      for (const m of list)
        for (const n of m.addedNodes)
          if (n.nodeType === 1) out.created += 1 + n.querySelectorAll("*").length;
      let flashed = 0;
      for (const e of document.querySelectorAll(".page-view .vr-block-ref")) {
        const key =
          e.getAttribute("data-from") + (e.closest("[data-block-id]")?.dataset.blockId ?? "");
        if (resolvedAtStart.has(key) && placeholder.test(e.textContent ?? "")) flashed++;
      }
      if (flashed > 0) out.flashSnapshots++;
      out.maxFlashed = Math.max(out.maxFlashed, flashed);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__dom = out;
    window.__rlf = {};
  });

  /** N writes to `target`, each waited out. With `poll`, waits on the row's marker and returns
   * how long each took to reach the screen; without, sleeps a fixed 1.5 s and checks once — a
   * polling wait runs script in the page, which would be billed to the refresh. */
  const refreshes = async (poll) => {
    const times = [];
    for (let i = 0; i < N; i++) {
      const next = i % 2 === 0 ? `${plain} ·` : plain;
      const started = Date.now();
      await api(page, "block.update", { id: target.id, old_str: text, new_str: next });
      text = next;
      // The rendered text is not the source (links, emphasis), so wait on the marker only.
      const marked = ([id, want]) =>
        (
          document.querySelector(`.page-view .vr-row[data-block-id="${id}"] .vr-block-view`)
            ?.textContent ?? ""
        ).endsWith(" ·") === want;
      if (poll) {
        await page.waitForFunction(marked, [target.id, i % 2 === 0], {
          timeout: 30_000,
          polling: 10,
        });
        times.push(Date.now() - started);
        await page.waitForTimeout(600);
      } else {
        await page.waitForTimeout(1500);
        if (!(await page.evaluate(marked, [target.id, i % 2 === 0])))
          throw new Error(`${name}: write ${i} not on screen after 1.5 s`);
      }
    }
    return times;
  };

  const times = await refreshes(true);
  const { dom, counters } = await page.evaluate(() => ({
    dom: window.__dom,
    counters: window.__rlf,
  }));

  // Second pass, Chromium only: main-thread time per refresh from the DevTools metrics, on a fresh
  // load with no MutationObserver (its own callbacks would be billed to the refresh).
  let mainThread;
  if (engine === chromium) {
    await page.goto(`${base}${pagePath(name)}`);
    await page.locator(".page-view .vr-outliner .vr-row").first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(4000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
      );
    const m0 = await metrics();
    await refreshes(false);
    const m1 = await metrics();
    const ms = (k) => Math.round(((m1[k] - m0[k]) / N) * 10000) / 10;
    mainThread = {
      scriptMs: ms("ScriptDuration"),
      layoutMs: ms("LayoutDuration"),
      styleMs: ms("RecalcStyleDuration"),
      taskMs: ms("TaskDuration"),
    };
    await cdp.detach();
  }
  const per = (v) => Math.round((v / N) * 10) / 10;
  report.push({
    page: name,
    rows,
    refreshes: N,
    perRefresh: {
      ...Object.fromEntries(
        Object.entries(dom).map(([k, v]) => [k, k === "maxFlashed" ? v : per(v)]),
      ),
      ...Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, per(v)])),
    },
    mainThreadPerRefresh: mainThread,
    writeToScreenMs: times,
  });
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
