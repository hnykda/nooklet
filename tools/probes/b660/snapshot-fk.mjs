// B-660 probe: an older block moved under a newer one, then a fresh browser context (which
// bootstraps its replica from /sync/snapshot) loads the page. Prints console lines mentioning
// SQLite errors and the rows the page shows.
// With TRIM=<server graph.sqlite>, the server's op log is emptied first, standing in for
// `nooklet gc` (only on a throwaway server: it edits the server's database under it).
// Usage: ENGINE=webkit|chromium [TRIM=<graph.sqlite>] node snapshot-fk.mjs <baseURL>
import { DatabaseSync } from "node:sqlite";
import { chromium, webkit } from "@playwright/test";

const [base] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
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
const name = `fk ${Date.now() % 100000}`;
await api("page.create", { name, markdown: "- older\n- newer" });
const ids = [...(await api("page.read", { page: name })).text.matchAll(/- (\w+) \^(\w{14})/g)];
const older = ids.find((m) => m[1] === "older")[2];
const newer = ids.find((m) => m[1] === "newer")[2];
await api("block.move", { id: older, ref: newer, position: "child_last" });
console.log("server:", (await api("page.read", { page: name })).text.trim());
if (process.env.TRIM) {
  const db = new DatabaseSync(process.env.TRIM);
  db.exec("DELETE FROM op");
  db.close();
  console.log("trimmed the server's op log");
}

const browser = await engine.launch();
const page = await (await browser.newContext()).newPage();
page.on("console", (m) => {
  if (/sqlite|constraint|error|bootstrap|snapshot/i.test(m.text()))
    console.log("console:", m.text());
});
page.on("pageerror", (e) => console.log("pageerror:", String(e)));
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForTimeout(4000);
console.log(
  "rows:",
  await page.evaluate(() =>
    [...document.querySelectorAll(".vr-row")].map((r) => r.textContent).join(" | "),
  ),
);
await browser.close();
