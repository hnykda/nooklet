// Probe (2026-09-13, m11/webkit-focus, B-42): does a sync refresh with the `[[` popup open drop
// editor focus on the REAL graph — in WebKit (headless and headed) and in Chromium?
//
// The same trace as `webkit-refresh-focus.spec.ts` (focusin/focusout with stacks, focus()/blur()
// calls, DOM ops on the focused subtree, activeElement / popup / sync-indicator / editor-row
// changes every 20 ms), plus the text of today's outliner outside the editor, so a refresh is
// visible in the timeline (B-500: `((id))` labels flash back to placeholders on each one).
//
// Run from `e2e/` (so `@playwright/test` resolves) against a server on a COPY of the graph:
//   BASE=http://127.0.0.1:6416 OUT=<dir> BROWSERS=webkit,webkit-headed,chromium \
//     node ../tools/probes/webkit-refresh-focus-real-graph.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6416";
const OUT = process.env.OUT ?? ".";
const BROWSERS = (process.env.BROWSERS ?? "webkit,chromium").split(",");
const SCENARIOS = (
  process.env.SCENARIOS ?? "own-cycle,new-block-own-cycle,api-same-page,api-other-page"
).split(",");
// Variations that a real desktop session has and a default run does not:
//   RAF_DELAY=<ms>  every requestAnimationFrame callback runs this late (a busy main thread)
//   MOUSE=popup|below|none  where the pointer rests while waiting (a real pointer is somewhere;
//                   WebKit sends mouse events to whatever re-renders under it)
//   KEY_DELAY=<ms>  pause between keystrokes (slow typing lets refreshes land mid-word)
const RAF_DELAY = Number(process.env.RAF_DELAY ?? 0);
const MOUSE = process.env.MOUSE ?? "none";
const KEY_DELAY = Number(process.env.KEY_DELAY ?? 80);
const LABEL = process.env.LABEL ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await (await fetch(`${BASE}/api/session`)).json();
async function api(op, body) {
  const res = await fetch(`${BASE}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function traceInit() {
  const w = window;
  w.__trace = [];
  const at = () => Math.round(performance.now());
  const describe = (el) => {
    if (el === null || el === undefined) return String(el);
    if (el === window) return "window";
    if (el === document) return "document";
    if (!("tagName" in el)) return String(el.nodeName ?? el);
    const cls =
      typeof el.className === "string" ? el.className.split(" ").slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };
  const stack = () => (new Error().stack ?? "").split("\n").slice(2, 16).join(" | ");
  const push = (kind, detail, withStack = false) =>
    w.__trace.push({ t: at(), kind, detail, stack: withStack ? stack() : undefined });
  w.__mark = (label) => push("MARK", label);
  for (const type of ["focusin", "focusout"]) {
    document.addEventListener(
      type,
      (e) => push(type, `${describe(e.target)} related=${describe(e.relatedTarget)}`, true),
      true,
    );
  }
  window.addEventListener("blur", (e) => e.target === window && push("window-blur", "", true));
  window.addEventListener("focus", (e) => e.target === window && push("window-focus", ""));
  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) {
    push("call.focus()", describe(this), true);
    return origFocus.call(this, opts);
  };
  const origBlur = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function () {
    push("call.blur()", describe(this), true);
    return origBlur.call(this);
  };
  const holdsFocus = (node) => {
    const a = document.activeElement;
    return node instanceof Node && !!a && a !== document.body && (node === a || node.contains(a));
  };
  for (const [name, pick] of [
    ["insertBefore", (a) => [a[0]]],
    ["appendChild", (a) => [a[0]]],
    ["removeChild", (a) => [a[0]]],
    ["replaceChild", (a) => [a[0], a[1]]],
  ]) {
    const orig = Node.prototype[name];
    Node.prototype[name] = function (...args) {
      const hit = pick(args).find((n) => holdsFocus(n));
      if (hit) push(`dom.${name}`, `${describe(hit)} parent=${describe(this)}`, true);
      return orig.apply(this, args);
    };
  }
  for (const name of ["remove", "replaceWith", "before", "after", "append", "prepend"]) {
    const orig = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      if ((name === "remove" || name === "replaceWith") && holdsFocus(this))
        push(`dom.${name}`, describe(this), true);
      for (const a of args) if (holdsFocus(a)) push(`dom.${name}(arg)`, describe(a), true);
      return orig.apply(this, args);
    };
  }
  const last = {};
  const log = (key, value) => {
    if (last[key] !== value) {
      push(key, value);
      last[key] = value;
    }
  };
  setInterval(() => {
    log("activeElement", describe(document.activeElement));
    log("sync-indicator", document.querySelector(".app-sync-indicator")?.textContent ?? "");
    const popup = document.querySelector(".cmd-popup");
    log("popup", popup ? `open rows=${popup.querySelectorAll("[role=option]").length}` : "closed");
    const row = document.querySelector(".cm-editor")?.closest(".vr-row");
    log("editor-row", row ? (row.textContent ?? "").slice(0, 50) : "none");
    const today = document.querySelector(".journal-day-today .vr-outliner");
    if (today) {
      const texts = [...today.querySelectorAll(".vr-block-view")].map((v) =>
        (v.textContent ?? "").slice(0, 40),
      );
      log("today-rows", JSON.stringify(texts));
    }
  }, 20);
}

// `draft-*` scenarios start the day from its draft, as the owner's today page was started
// (created 17:22 local, minutes before the report): the browser's clock is moved to a day with no
// journal page, so the stream shows the draft, and the tree is the one `VirtualJournalDay` renders.
function shiftDate(days) {
  const Real = Date;
  const offset = days * 86_400_000;
  function Shifted(...a) {
    if (!new.target) return new Real(Real.now() + offset).toString();
    return a.length === 0 ? new Real(Real.now() + offset) : new Real(...a);
  }
  Shifted.prototype = Real.prototype;
  Shifted.now = () => Real.now() + offset;
  Shifted.UTC = Real.UTC;
  Shifted.parse = Real.parse;
  window.Date = Shifted;
}

const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

const summary = [];
for (const which of BROWSERS) {
  const engine = which.startsWith("webkit") ? webkit : chromium;
  const browser = await engine.launch({ headless: !which.endsWith("headed") });
  for (const scenario of SCENARIOS) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await ctx.addInitScript(traceInit);
    if (RAF_DELAY > 0) {
      await ctx.addInitScript((delay) => {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => raf((t) => void setTimeout(() => cb(t), delay));
      }, RAF_DELAY);
    }
    const tag = `${scenario}-${which}-${Date.now().toString(36)}`;
    const draft = scenario.startsWith("draft");
    if (draft) {
      await ctx.addInitScript(shiftDate, 40 + Math.floor(Math.random() * 3000));
      await page.goto(`${BASE}/journals`);
      const input = page.locator(".journal-day-today .vr-draft-input");
      await input.waitFor({ timeout: 90_000 });
      await sleep(4000);
      await input.click();
      await page.keyboard.type("seed line", { delay: 40 });
      await page.keyboard.press("Enter");
      await page.locator(".journal-day-today .cm-content").waitFor();
    } else {
      await api("page.append", { page: today, markdown: `- probe base ${tag}\n- sibling ${tag}` });
      await page.goto(`${BASE}/journals`);
      const row = page.locator(".journal-day-today .vr-block-view", {
        hasText: `probe base ${tag}`,
      });
      await row.waitFor({ timeout: 90_000 });
      await sleep(4000); // first sync, bootstrap refetches, agenda: let them settle
      await row.click();
      await page.locator(".cm-content").waitFor();
      await page.keyboard.press("End");
      if (scenario.startsWith("new-block")) await page.keyboard.press("Enter");
    }
    await page.evaluate(() => window.__mark("typing starts"));
    const text = scenario.startsWith("new-block") || draft ? "testing [[dru" : " testing [[dru";
    const perKey = [];
    for (const ch of text) {
      await page.keyboard.type(ch);
      perKey.push({
        key: ch,
        focused: await page.evaluate(() => !!document.activeElement?.closest(".cm-content")),
      });
      await sleep(KEY_DELAY);
    }
    await page.evaluate(() => window.__mark("typing done"));
    if (MOUSE !== "none") {
      const target =
        MOUSE === "popup"
          ? await page.locator(".cmd-popup").boundingBox()
          : await page.locator(".cm-editor").boundingBox();
      if (target) {
        const y = MOUSE === "popup" ? target.y + 20 : target.y + target.height + 30;
        await page.mouse.move(target.x + 40, y, { steps: 3 });
      }
    }
    const samples = [];
    const sample = async (at) =>
      samples.push({
        at,
        focused: await page.evaluate(() => !!document.activeElement?.closest(".cm-content")),
        popup: (await page.locator(".cmd-popup").count()) > 0,
      });
    if (scenario.endsWith("own-cycle")) {
      for (let i = 1; i <= 50; i++) {
        await sleep(100);
        await sample(i * 100);
      }
    } else {
      await sleep(4000);
      await page.evaluate((s) => window.__mark(`api write ${s}`), scenario);
      if (scenario === "api-same-page") {
        const tree = (await api("page.read", { page: today, format: "json" })).tree;
        const sib = tree.find((n) => n.content === `sibling ${tag}`);
        await api("block.update", { id: sib.id, content: `sibling ${tag} edited` });
      } else {
        await api("page.append", { page: "Probe Other Page", markdown: `- line ${tag}` });
      }
      for (let i = 1; i <= 40; i++) {
        await sleep(100);
        await sample(i * 100);
      }
    }
    await page.evaluate(() => window.__mark("typing again"));
    await page.keyboard.type("x");
    await sleep(400);
    const after = await page
      .locator(".cm-content")
      .textContent({ timeout: 1000 })
      .catch(() => null);
    const trace = await page.evaluate(() => window.__trace);
    const base = join(OUT, `real${LABEL}-${scenario}-${which}`);
    writeFileSync(`${base}.json`, JSON.stringify({ perKey, samples, after, trace }, null, 1));
    writeFileSync(
      `${base}.txt`,
      trace
        .map(
          (e) =>
            `${String(e.t).padStart(6)} ${e.kind} ${e.detail ?? ""}${e.stack ? `\n         @ ${e.stack}` : ""}`,
        )
        .join("\n"),
    );
    const line = `${LABEL} ${which} ${scenario}: lostAt=${JSON.stringify(samples.filter((s) => !s.focused).map((s) => s.at))} unfocusedAfterKeys=${JSON.stringify(perKey.filter((k) => !k.focused).map((k) => k.key))} popupAtEnd=${samples.at(-1)?.popup} after=${JSON.stringify(after)} focusouts=${trace.filter((e) => e.kind === "focusout").length}`;
    console.log(line);
    summary.push(line);
    await ctx.close();
  }
  await browser.close();
}
writeFileSync(join(OUT, `real${LABEL}-summary.txt`), summary.join("\n"));
