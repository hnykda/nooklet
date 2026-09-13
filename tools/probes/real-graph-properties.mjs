/**
 * Probe (2026-09-13, impl-render, B-100/B-101): on a COPY of the owner's real graph, do numbered
 * lists and property chips render right?
 *
 * Usage (never point it at ~/.nooklet/default itself):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <scratch>/graph --port 6401 --no-mirror &
 *   node tools/probes/real-graph-properties.mjs <scratch>/graph/graph.sqlite http://127.0.0.1:6401 [page…]
 *
 * For each page: every rendered row's block id is looked up in the database; a row must show an
 * ordinal exactly when its block has `list:: number`, ordinals must be 1 + the count of contiguous
 * numbered siblings before it (OUT-17, recomputed here from the database independently of the
 * client), and a row must show one chip per visible generic property.
 */
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";

const [dbPath, base, ...pageArgs] = process.argv.slice(2);
if (!dbPath || !base) {
  console.error("usage: real-graph-properties.mjs <graph.sqlite> <base-url> [page…]");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const HIDDEN = new Set([
  "list",
  "heading",
  "background-color",
  "created-at",
  "updated-at",
  "last-modified-at",
  "query-table",
  "query-properties",
  "query-sort-by",
  "query-sort-desc",
  "ls-type",
  "hl-type",
  "hl-page",
  "hl-stamp",
  "hl-color",
  "hl-value",
  "logseq.macro-name",
  "logseq.macro-arguments",
]);

const pages =
  pageArgs.length > 0
    ? pageArgs
    : db
        .prepare(
          `SELECT p.name, count(*) c FROM block_prop bp JOIN block b ON b.id = bp.block_id
           JOIN page p ON p.id = b.page_id
           WHERE bp.key = 'list' AND bp.value = 'number' AND b.deleted_at IS NULL
           GROUP BY p.id ORDER BY c DESC LIMIT 6`,
        )
        .all()
        .map((r) => r.name);

/** Expected ordinal for every block on the page, computed from the database alone. */
function expectedOrdinals(pageName) {
  const blocks = db
    .prepare(
      `SELECT b.id, b.parent_id, b.order_key,
         EXISTS(SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = 'list'
                AND bp.value = 'number') AS numbered
       FROM block b JOIN page p ON p.id = b.page_id
       WHERE p.name = ? AND b.deleted_at IS NULL`,
    )
    .all(pageName);
  const byParent = new Map();
  for (const b of blocks) {
    const k = b.parent_id ?? "";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(b);
  }
  const out = new Map();
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) =>
      a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1,
    );
    let run = 0;
    for (const s of siblings) {
      run = s.numbered ? run + 1 : 0;
      out.set(s.id, s.numbered ? run : null);
    }
  }
  return out;
}

function visibleChipCount(blockId) {
  return db
    .prepare("SELECT key FROM block_prop WHERE block_id = ? AND value IS NOT NULL")
    .all(blockId)
    .filter((r) => !HIDDEN.has(r.key)).length;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let failures = 0;
for (const name of pages) {
  const url = `${base}/page/${name.split("/").map(encodeURIComponent).join("/")}`;
  await page.goto(url);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 120_000 });
  // Let the page settle: rows keep arriving while the replica finishes bootstrapping.
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const n = await page.locator(".vr-outliner .vr-row").count();
    if (n === last) break;
    last = n;
    await page.waitForTimeout(500);
  }
  const rows = await page.locator(".vr-outliner .vr-row").evaluateAll((els) =>
    els.map((r) => ({
      id: r.getAttribute("data-block-id"),
      number: r.querySelector(".vr-list-number")?.textContent ?? null,
      chips: r.querySelectorAll(":scope .vr-prop").length,
    })),
  );
  const expected = expectedOrdinals(name);
  let numbered = 0;
  let wrong = 0;
  let chipRows = 0;
  let chipWrong = 0;
  const samples = [];
  for (const row of rows) {
    const want = expected.get(row.id);
    const got = row.number === null ? null : Number(row.number.replace(/\.$/, ""));
    if (want != null) numbered++;
    if ((want ?? null) !== got) {
      wrong++;
      if (samples.length < 5) samples.push({ id: row.id, want, got });
    }
    const chips = visibleChipCount(row.id);
    if (chips > 0) chipRows++;
    if (chips !== row.chips) chipWrong++;
  }
  const ok = wrong === 0 && chipWrong === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${name}: ${rows.length} rows, ${numbered} numbered (${wrong} wrong), ` +
      `${chipRows} rows with chips (${chipWrong} wrong)${samples.length ? ` ${JSON.stringify(samples)}` : ""}`,
  );
}
await browser.close();
process.exit(failures === 0 ? 0 : 1);
