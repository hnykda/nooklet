// Shared helpers for the 2026-10-03 readiness sweep (docs/review/2026-10-03-sweep-core.md).
// Drives the REAL production build served by a real `nooklet serve` on 127.0.0.1:6310, which has
// a copy of the owner's Logseq graph imported. Never point this at port 6100.
import { chromium } from "@playwright/test";

export const BASE = "http://127.0.0.1:6310/g/default";
export const OUT = process.env.OUT ?? ".";
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

let token;
export async function api(op, body) {
  if (!token) {
    const s = await (await fetch(`${BASE}/api/session`)).json();
    token = s.token;
  }
  const res = await fetch(`${BASE}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function readBlocks(name) {
  const out = await api("page.read", { page: name, format: "json" });
  const flat = [];
  const walk = (nodes, depth) => {
    for (const n of nodes ?? []) {
      flat.push({ id: n.id, content: n.content, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(out.tree, 0);
  return flat;
}

export function isoToday(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function launch() {
  const browser = await chromium.launch();
  return browser;
}

export async function newPage(browser, label = "A") {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.__errs = [];
  page.on("pageerror", (e) => page.__errs.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") page.__errs.push(`[${label}] console: ${m.text().slice(0, 300)}`);
  });
  return { ctx, page };
}

export async function rowTexts(scope) {
  return scope.locator(".vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const cm = r.querySelector(".cm-content");
      if (cm)
        return [...cm.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n");
      return r.querySelector(".vr-block-view")?.textContent ?? "";
    }),
  );
}

export async function rowDepths(scope) {
  return scope
    .locator(".vr-row")
    .evaluateAll((rows) =>
      rows.map((r) => Number(r.style.getPropertyValue("--depth").trim() || "0")),
    );
}

export async function editorText(page) {
  return page.evaluate(() => {
    const c = document.querySelector(".cm-content");
    if (!c) return null;
    return [...c.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n");
  });
}

export const results = [];
export async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`PASS ${name} (${Date.now() - t0}ms) ${note ? JSON.stringify(note) : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: String(e?.message ?? e) });
    console.log(`FAIL ${name} (${Date.now() - t0}ms) ${String(e?.message ?? e).slice(0, 600)}`);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function waitFor(fn, timeout = 8000, every = 100) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`waitFor timed out; last=${JSON.stringify(String(last)).slice(0, 300)}`);
}
