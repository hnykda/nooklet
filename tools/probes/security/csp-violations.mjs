#!/usr/bin/env node
// Does the app shell's CSP (`packages/server/src/http/web-client.ts#shellCsp`) break the real app?
//
// Usage: node tools/probes/security/csp-violations.mjs http://127.0.0.1:6456
// Against a scratch, LOOPBACK-bound server (so the page gets its auto-token) serving the production
// build. Loads the app, writes blocks that exercise KaTeX, a code fence, a mermaid fence and a link,
// reloads (service worker path), and prints every `securitypolicyviolation` and console error.
// Also checks that an injected inline handler / javascript: URL is blocked (the point of the CSP).
//
// Result 2026-10-04 (after the CSP commit), Chromium: 0 violations from the app itself; the
// deliberately injected inline script was blocked (1 violation, script-src-elem).

import { createRequire } from "node:module";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:6456";
const browser = await chromium.launch();
const page = await browser.newPage();
const violations = [];
const errors = [];
await page.exposeFunction("__reportViolation", (v) => violations.push(v));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__reportViolation(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
  );
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`${base}/g/default/`);
await page.waitForTimeout(3000);
const token = await page.evaluate(async () => (await (await fetch("api/session")).json()).token);
const call = (op, body) =>
  page.evaluate(
    async ([op, body, token]) =>
      (
        await fetch(`api/v1/${op}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    [op, body, token],
  );
console.log(
  "page.create",
  await call("page.create", {
    name: "CSP probe",
    markdown: [
      "- math $e^{i\\pi}+1=0$ and $$\\int_0^1 x\\,dx$$",
      "- ```js\n  const x = 1;\n  ```",
      "- ```mermaid\n  graph TD; A-->B;\n  ```",
      "- [a link](https://example.com) and [[Other page]]",
    ].join("\n"),
  }),
);
await page.goto(`${base}/g/default/page/CSP%20probe`);
await page.waitForTimeout(4000);
await page.reload();
await page.waitForTimeout(4000);
const appViolations = violations.length;
console.log(`app: ${appViolations} CSP violations`, violations);

// Positive control: injected inline script must be refused.
await page.evaluate(() => {
  const s = document.createElement("script");
  s.textContent = "window.__pwned = true";
  document.body.appendChild(s);
});
await page.waitForTimeout(300);
console.log("injected inline script ran:", await page.evaluate(() => window.__pwned === true));
console.log(`control: ${violations.length - appViolations} new violation(s)`, violations.slice(appViolations));
console.log("console errors:", errors.slice(0, 10));
await browser.close();
