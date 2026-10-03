/**
 * B-609: a type-ahead burst on a day that does not exist yet keeps its structure.
 *
 * The day's first Enter writes the page and hands the caret from the journal draft (a textarea in
 * `VirtualJournalDay`) to the day's real outliner. A fast typist — or a phone keyboard that batches
 * input — is already pressing the next keys during that handoff. Before the fix the Tab in
 * `aaa`⏎`bbb`⇥⏎`ccc`⇧⇥ typed with zero delay was lost and the server got all three rows at depth 0;
 * the same burst on an ordinary page was always right. What is asserted is the server's tree
 * (depths), since a structure that only looks right on screen is not what was asked for.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { isoOffset, pagePath, readBlocks } from "../helpers/index.js";

const EXPECTED = ["aaa", "  bbb", "ccc"];

/** `aaa`⏎`bbb`⇥⏎`ccc`⇧⇥, every key dispatched back to back (Playwright's default: no delay). */
async function burst(page: Page): Promise<void> {
  await page.keyboard.type("aaa");
  await page.keyboard.press("Enter");
  await page.keyboard.type("bbb");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ccc");
  await page.keyboard.press("Shift+Tab");
}

function shape(blocks: Array<{ content: string; depth: number }>): string[] {
  return blocks.map((b) => `${"  ".repeat(b.depth)}${b.content}`);
}

async function expectRowsSettle(outliner: Locator): Promise<void> {
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
}

test("a zero-delay Enter/Tab burst on a date page with no page keeps the Tab (B-609)", async ({
  page,
}) => {
  const day = isoOffset(-(8000 + (Date.now() % 3000)));
  await page.goto(pagePath(day));
  const draft = page.locator(".page-view-draft .vr-draft-input");
  await expect(draft).toBeVisible();
  await draft.click();
  await burst(page);

  await expect
    .poll(async () => shape(await readBlocks(page, day).catch(() => [])), { timeout: 15_000 })
    .toEqual(EXPECTED);
  await expectRowsSettle(page.locator(".page-view .vr-outliner").first());
});

/** A graph of its own (today on the shared default graph is written by other specs), with a
 * caller for its API and a reader of today's tree as indented lines. */
async function freshGraph(baseURL: string | undefined) {
  const base = baseURL as string;
  const port = process.env.NOOKLET_E2E_PORT ?? "6188";
  const { dataDir } = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${port}.json`), "utf8"),
  ) as { dataDir: string };
  const rootToken = readFileSync(join(dataDir, "root.token"), "utf8").trim();
  const slug = `burst-${Date.now()}`;
  const created = await fetch(`${base}/graphs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ id: slug, label: slug }),
  });
  expect(created.status).toBe(201);
  const { token } = (await created.json()) as { token: string };
  const call = (op: string, body: unknown) =>
    fetch(`${base}/g/${slug}/api/v1/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const today = isoOffset(0);
  type Node = { id: string; content: string; children?: Node[] };
  const readToday = async (): Promise<Node[] | null> => {
    const res = await call("page.read", { page: today, format: "json" });
    return res.ok ? ((await res.json()) as { tree: Node[] }).tree : null;
  };
  const todayShape = async (): Promise<string[] | null> => {
    const tree = await readToday();
    if (!tree) return null;
    const out: string[] = [];
    const walk = (nodes: Node[] | undefined, depth: number): void => {
      for (const n of nodes ?? []) {
        out.push(`${"  ".repeat(depth)}${n.content}`);
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  };
  return { today, journals: `${base}/g/${slug}/journals`, call, readToday, todayShape };
}

test("a zero-delay Enter/Tab burst on an empty today in the journal stream keeps the Tab (B-609)", async ({
  page,
  baseURL,
}) => {
  const g = await freshGraph(baseURL);
  await page.goto(g.journals);
  const draft = page.locator(".journal-day-today .vr-draft-input");
  await expect(draft).toBeVisible({ timeout: 15_000 });
  await draft.click();
  await burst(page);

  await expect.poll(g.todayShape, { timeout: 15_000 }).toEqual(EXPECTED);
  await expectRowsSettle(page.locator(".journal-day-today .vr-outliner").first());
});

test("a zero-delay Enter/Tab burst on a today whose blocks were all deleted keeps the Tab, and no row drops off screen (B-609)", async ({
  page,
  baseURL,
}) => {
  // The sweep's own case (`tools/probes/sweep-core/indent-render.mjs journal fast 0` deletes
  // today's blocks first): today has a page with no blocks, so it is a real `BlockTree` showing
  // "Start typing…", not the draft.
  const g = await freshGraph(baseURL);
  await g.call("page.append", { page: g.today, markdown: "- deleted soon" });
  for (const n of (await g.readToday()) ?? []) await g.call("block.delete", { id: n.id });
  expect(await g.todayShape()).toEqual([]);

  await page.goto(g.journals);
  const start = page.locator(".journal-day-today .vr-empty-start");
  await expect(start).toBeVisible({ timeout: 15_000 });
  // Every frame, note a row count that goes DOWN: after each Enter the rows used to collapse to the
  // one being edited (the "flicker"), the same dropped state that lost the Tab.
  await page.evaluate(() => {
    const w = window as unknown as { __rowDrops: string[] };
    w.__rowDrops = [];
    let last = 0;
    const tick = (): void => {
      const n = document.querySelectorAll(".journal-day-today .vr-outliner .vr-row").length;
      if (n < last) w.__rowDrops.push(`${last} -> ${n}`);
      last = n;
      requestAnimationFrame(tick);
    };
    tick();
  });
  await start.click();
  await burst(page);

  await expect.poll(g.todayShape, { timeout: 15_000 }).toEqual(EXPECTED);
  await expectRowsSettle(page.locator(".journal-day-today .vr-outliner").first());
  const drops = await page.evaluate(
    () => (window as unknown as { __rowDrops: string[] }).__rowDrops,
  );
  // The "Start typing…" row going away as the first block replaces it is 1 -> 1, not a drop.
  expect(drops).toEqual([]);
});
