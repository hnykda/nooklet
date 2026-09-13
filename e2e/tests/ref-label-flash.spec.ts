/**
 * B-500: every refresh (a pull after another device or an agent wrote, or a local write that
 * re-reads the page) turned each `((block ref))` on screen back into its `((id))` placeholder until
 * the lookup answered again.
 *
 * A screenshot or an auto-retrying assertion cannot see this — the placeholder is gone again a few
 * milliseconds later. So the page carries a MutationObserver that records the text of every row
 * after every DOM change, and the test reads the whole history afterwards: a flash that lived for
 * one microtask is in it.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, clickAway, editor, pagePath, readBlocks, seedPage } from "../helpers/index.js";

const TARGET = "Flash Target";
const HOST = "Flash Host";

interface Recorded {
  /** One entry per MutationObserver callback: each row's rendered text, top to bottom. */
  rows: string[][];
  /** Every `.vr-block-ref` label text seen, in order. */
  refs: string[][];
  /** `.vr-block-ref` elements created after the recorder started (a remount, not an update). */
  refMounts: number;
  /** `.vr-row` elements created after the recorder started. */
  rowMounts: number;
}

/** Start recording. Tags the existing rows and ref spans, so a remount shows up as an untagged
 * element later. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __flash: Recorded; __flashStop?: () => void };
    w.__flashStop?.();
    const root = document.querySelector(".page-view") as HTMLElement;
    const tag = (sel: string) => {
      for (const el of root.querySelectorAll(sel)) (el as HTMLElement).dataset.flashSeen = "1";
    };
    tag(".vr-row");
    tag(".vr-block-ref");
    const out: Recorded = { rows: [], refs: [], refMounts: 0, rowMounts: 0 };
    const take = () => {
      out.rows.push(
        [...root.querySelectorAll(".vr-outliner .vr-row")].map(
          (r) => r.querySelector(".vr-block-view")?.textContent ?? "<editing>",
        ),
      );
      out.refs.push(
        [...root.querySelectorAll(".vr-outliner .vr-block-ref")].map((r) => r.textContent ?? ""),
      );
      for (const el of root.querySelectorAll<HTMLElement>(".vr-row:not([data-flash-seen])")) {
        el.dataset.flashSeen = "1";
        out.rowMounts++;
      }
      for (const el of root.querySelectorAll<HTMLElement>(".vr-block-ref:not([data-flash-seen])")) {
        el.dataset.flashSeen = "1";
        out.refMounts++;
      }
    };
    const mo = new MutationObserver(take);
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    w.__flash = out;
    w.__flashStop = () => mo.disconnect();
  });
}

async function recorded(page: Page): Promise<Recorded> {
  return page.evaluate(() => (window as unknown as { __flash: Recorded }).__flash);
}

async function seed(page: Page): Promise<{ other: string; plain: string; alpha: string }> {
  await seedPage(page, TARGET, "- target alpha\n- target **beta**");
  const target = await readBlocks(page, TARGET);
  const alpha = target.find((b) => b.content === "target alpha")?.id as string;
  const beta = target.find((b) => b.content === "target **beta**")?.id as string;
  await seedPage(page, HOST, "- same page target\n- plain block to edit");
  const host = await readBlocks(page, HOST);
  const same = host.find((b) => b.content === "same page target")?.id as string;
  const plain = host.find((b) => b.content === "plain block to edit")?.id as string;
  if (host.length === 2) {
    await api(page, "page.append", {
      page: HOST,
      markdown: [
        `- see ((${alpha})) and ((${beta}))`,
        `- local ((${same})) in [[${TARGET}]]`,
        `  - nested ((${alpha}))`,
      ].join("\n"),
    });
  }
  return { other: beta, plain, alpha };
}

const PLACEHOLDER = /\(\([0-9a-z]+\)\)/;

test("block reference labels stay resolved across refreshes from pulls (B-500)", async ({
  page,
}) => {
  const { plain } = await seed(page);
  await page.goto(pagePath(HOST));
  const outliner = page.locator(".vr-outliner").first();
  const refs = outliner.locator(".vr-block-ref");
  await expect(refs).toHaveCount(4);
  await expect(refs).toHaveText([
    "target alpha",
    "target beta",
    "same page target",
    "target alpha",
  ]);

  await record(page);
  let text = "plain block to edit";
  for (let i = 0; i < 5; i++) {
    const next = `plain block to edit ${i}`;
    await api(page, "block.update", { id: plain, old_str: text, new_str: next });
    text = next;
    await expect(outliner.locator(".vr-row").nth(1)).toHaveText(next, { timeout: 15_000 });
  }
  const r = await recorded(page);
  const flashes = r.refs.filter((labels) => labels.some((l) => PLACEHOLDER.test(l)));
  console.log(
    `pull refreshes: ${r.rows.length} snapshots, ${flashes.length} with a placeholder, ` +
      `${r.refMounts} ref spans mounted, ${r.rowMounts} rows mounted`,
  );
  expect(r.rows.length).toBeGreaterThan(0);
  expect(flashes, JSON.stringify(flashes.slice(0, 3))).toEqual([]);
});

test("block reference labels stay resolved while typing in another block (B-500)", async ({
  page,
}) => {
  await seed(page);
  await page.goto(pagePath(HOST));
  const outliner = page.locator(".vr-outliner").first();
  const refs = outliner.locator(".vr-block-ref");
  await expect(refs).toHaveText([
    "target alpha",
    "target beta",
    "same page target",
    "target alpha",
  ]);

  await record(page);
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed", { delay: 60 });
  await expect
    .poll(async () => (await readBlocks(page, HOST)).some((b) => b.content.endsWith(" typed")))
    .toBe(true);
  await clickAway(page);
  await expect(refs).toHaveText([
    "target alpha",
    "target beta",
    "same page target",
    "target alpha",
  ]);
  const r = await recorded(page);
  const flashes = r.refs.filter((labels) => labels.some((l) => PLACEHOLDER.test(l)));
  console.log(
    `typing: ${r.rows.length} snapshots, ${flashes.length} with a placeholder, ` +
      `${r.refMounts} ref spans mounted, ${r.rowMounts} rows mounted`,
  );
  expect(flashes, JSON.stringify(flashes.slice(0, 3))).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Everything else a refresh could flash: embeds, query results, date chips, the title row (icon),
// the references panel, the word count, the sidebar.
// ---------------------------------------------------------------------------------------------

const REGIONS: Record<string, string> = {
  title: ".page-view .page-title-row",
  embed: ".page-view .vr-embed",
  query: ".page-view .vr-query",
  dates: ".page-view .vr-dates",
  references: ".page-view .references-panel",
  wordCount: '[data-status-item="word-count"]',
  sidebar: ".app-sidebar",
};
const MOUNTS: Record<string, string> = {
  rows: ".page-view .vr-outliner .vr-row",
  blockRefs: ".page-view .vr-block-ref",
  queryHits: ".page-view .vr-query-hit",
  embedItems: ".page-view .vr-embed-item",
  referenceItems: ".page-view .reference-item",
  dateChips: ".page-view .vr-date",
  propRows: ".page-view .vr-prop",
  sidebarItems: ".app-sidebar li",
};

interface RegionRecord {
  /** Per region: each distinct text it showed, in order (consecutive repeats dropped). */
  seq: Record<string, string[]>;
  /** Per row (by block id, the edited row left out): the same. */
  rows: Record<string, string[]>;
  /** Elements of each kind created after recording started. */
  mounts: Record<string, number>;
  callbacks: number;
}

async function recordRegions(page: Page, skipRow: string): Promise<void> {
  await page.evaluate(
    ([regions, mounts, skip]) => {
      const w = window as unknown as { __regions: RegionRecord };
      const out: RegionRecord = { seq: {}, rows: {}, mounts: {}, callbacks: 0 };
      for (const sel of Object.values(mounts))
        for (const el of document.querySelectorAll<HTMLElement>(sel)) el.dataset.regionSeen = "1";
      const push = (map: Record<string, string[]>, key: string, value: string) => {
        const list = map[key] ?? [];
        map[key] = list;
        if (list[list.length - 1] !== value) list.push(value);
      };
      const take = () => {
        out.callbacks++;
        for (const [name, sel] of Object.entries(regions)) {
          push(
            out.seq,
            name,
            [...document.querySelectorAll(sel)].map((e) => e.textContent ?? "").join(" | "),
          );
        }
        for (const row of document.querySelectorAll<HTMLElement>(
          ".page-view .vr-outliner .vr-row",
        )) {
          const id = row.dataset.blockId ?? "?";
          if (id === skip) continue;
          push(out.rows, id, row.querySelector(".vr-block-view")?.textContent ?? "<editing>");
        }
        for (const [name, sel] of Object.entries(mounts)) {
          for (const el of document.querySelectorAll<HTMLElement>(
            `${sel}:not([data-region-seen])`,
          )) {
            el.dataset.regionSeen = "1";
            out.mounts[name] = (out.mounts[name] ?? 0) + 1;
          }
        }
      };
      take();
      new MutationObserver(take).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      w.__regions = out;
    },
    [REGIONS, MOUNTS, skipRow] as const,
  );
}

const RICH = "Flash Rich";
const REFERRER = "Flash Referrer";

/** A page with one of everything a refresh re-reads, and a page that links to it. */
async function seedRich(page: Page): Promise<{ plain: { id: string; content: string } }> {
  const { alpha } = await seed(page);
  const existing = await readBlocks(page, RICH).catch(() => []);
  if (existing.length === 0) {
    await seedPage(page, RICH, "- plain v0");
    await api(page, "page.update", { page: RICH, properties: { icon: "🍎" } });
    await api(page, "page.append", {
      page: RICH,
      markdown: [
        `- quoting ((${alpha})) inline`,
        "- TODO call the bank",
        "  SCHEDULED: <2026-09-20 Sun>",
        "  owner:: [[Flash Target]]",
        `- {{embed ((${alpha}))}}`,
        "- ```query\n  TODO\n  ```",
        `- TODO flashrich task quoting ((${alpha}))`,
      ].join("\n"),
    });
    await seedPage(page, REFERRER, `- mentions [[${RICH}]] and ((${alpha}))`);
  }
  const plain = (await readBlocks(page, RICH)).find((b) => b.content.startsWith("plain v"));
  if (!plain) throw new Error("no plain block");
  return { plain };
}

test("the references panel shows a block reference's text, not its id (B-510)", async ({
  page,
}) => {
  await seedRich(page);
  await page.goto(pagePath(RICH));
  const item = page.locator(".page-view .references-panel .reference-item", {
    hasText: "mentions",
  });
  await expect(item.locator(".vr-block-ref")).toHaveText("target alpha");
});

test("a refresh changes nothing on screen but the block that changed, and rebuilds nothing else (B-500, B-511)", async ({
  page,
}) => {
  const { plain } = await seedRich(page);
  await page.goto(pagePath(RICH));
  if ((await page.locator(".app-sidebar").count()) === 0) {
    await page.locator("button[aria-label='Toggle sidebar']").click();
  }
  await expect(page.locator(".app-sidebar li").first()).toBeVisible();
  const view = page.locator(".page-view");
  await expect(view.locator(".vr-query-hit").first()).toBeVisible();
  await expect(view.locator(".vr-embed-item").first()).toContainText("target alpha");
  await expect(view.locator(".references-panel")).toContainText(REFERRER);
  await expect(view.locator(".vr-outliner .vr-block-ref").first()).toHaveText("target alpha");
  // Let the word count and any late first reads settle before recording.
  await page.waitForTimeout(1500);

  await recordRegions(page, plain.id);
  let text = plain.content;
  for (let i = 1; i <= 5; i++) {
    const next = `plain v${i}`;
    await api(page, "block.update", { id: plain.id, old_str: text, new_str: next });
    text = next;
    await expect(view.locator(`.vr-row[data-block-id="${plain.id}"]`)).toHaveText(next, {
      timeout: 15_000,
    });
    await page.waitForTimeout(300);
  }
  const r = await page.evaluate(() => (window as unknown as { __regions: RegionRecord }).__regions);
  const changed = Object.fromEntries(
    [...Object.entries(r.seq), ...Object.entries(r.rows)].filter(([, s]) => s.length > 1),
  );
  // Any region or row that showed more than one text between the first pull and the last: a
  // placeholder, a "Loading…", an empty word count — whatever it flashed is in the message.
  expect(changed, JSON.stringify(r.mounts)).toEqual({});
  expect(r.callbacks).toBeGreaterThan(5);
  // And nothing was thrown away and rebuilt with the same content (B-511): query results,
  // reference rows, date chips, property rows, sidebar entries, ref labels, rows.
  expect(r.mounts).toEqual({});
});
