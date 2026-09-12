/**
 * DB-facing half of chunking: fetches breadcrumb/descendant/top-level-block text for a block or
 * page and hands it to `chunker.ts`'s pure formatters. Kept separate from `chunker.ts` so the
 * cap/format logic can be unit-tested with plain fixtures, no database involved.
 */

import type { SqlDriver } from "@nooklet/core";
import { wirePageNameOf } from "../rows.js";
import {
  cleanBlockText,
  firstLine,
  formatBlockUnitText,
  formatPageUnitText,
  isEmbeddableBlock,
} from "./chunker.js";

export interface UnitText {
  text: string;
  pageId: string;
  /** Normalized page key, stored as the vec0 `page_key` metadata column. */
  pageKey: string;
}

function pageTitle(driver: SqlDriver, pageId: string): { name: string; key: string } | undefined {
  const p = driver.get<{ name: string; key: string; journal_day: number | null }>(
    "SELECT name, key, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
    [pageId],
  );
  if (!p) return undefined;
  return { name: wirePageNameOf(p), key: p.key };
}

/** Page title, then ancestor blocks' first lines, oldest (nearest the page root) to nearest-parent. */
function breadcrumbForBlock(
  driver: SqlDriver,
  pageTitleText: string,
  parentId: string | null,
): string[] {
  const chain: string[] = [];
  let cur = parentId;
  let guard = 0;
  while (cur !== null && guard++ < 100) {
    const row = driver.get<{ content: string; parent_id: string | null }>(
      "SELECT content, parent_id FROM block WHERE id = ? AND deleted_at IS NULL",
      [cur],
    );
    if (!row) break;
    chain.push(firstLine(cleanBlockText(row.content)));
    cur = row.parent_id;
  }
  chain.reverse();
  return [pageTitleText, ...chain];
}

/** Depth-first, cleaned first-line text of every descendant (children before grandchildren of
 * that child, matching how a reader would encounter them in the outline). */
function descendantLines(driver: SqlDriver, blockId: string): string[] {
  const lines: string[] = [];
  const walk = (id: string): void => {
    const children = driver.all<{ id: string; content: string }>(
      "SELECT id, content FROM block WHERE parent_id = ? AND deleted_at IS NULL ORDER BY order_key",
      [id],
    );
    for (const c of children) {
      const cleaned = firstLine(cleanBlockText(c.content));
      if (cleaned.length > 0) lines.push(cleaned);
      walk(c.id);
    }
  };
  walk(blockId);
  return lines;
}

function hasChildren(driver: SqlDriver, blockId: string): boolean {
  return (
    (driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM block WHERE parent_id = ? AND deleted_at IS NULL",
      [blockId],
    )?.n ?? 0) > 0
  );
}

/** Build a block unit's embedded text, or `undefined` when the block is gone or not worth its own
 * unit (research/06 §4.2 — too short, no children). Callers treat `undefined` the same as
 * "deleted": drop any existing embedding row/vector for this unit. */
export function buildBlockUnit(driver: SqlDriver, blockId: string): UnitText | undefined {
  const block = driver.get<{
    id: string;
    page_id: string;
    parent_id: string | null;
    content: string;
    deleted_at: number | null;
  }>("SELECT id, page_id, parent_id, content, deleted_at FROM block WHERE id = ?", [blockId]);
  if (!block || block.deleted_at !== null) return undefined;
  const page = pageTitle(driver, block.page_id);
  if (!page) return undefined;
  const ownText = cleanBlockText(block.content);
  const hasKids = hasChildren(driver, blockId);
  if (!isEmbeddableBlock(ownText, hasKids)) return undefined;
  const breadcrumb = breadcrumbForBlock(driver, page.name, block.parent_id);
  const descendants = descendantLines(driver, blockId);
  const text = formatBlockUnitText(breadcrumb, ownText, descendants);
  return { text, pageId: block.page_id, pageKey: page.key };
}

/** Build a page unit's embedded text, or `undefined` when the page is gone/deleted. */
export function buildPageUnit(driver: SqlDriver, pageId: string): UnitText | undefined {
  const page = driver.get<{
    id: string;
    name: string;
    key: string;
    journal_day: number | null;
    deleted_at: number | null;
  }>("SELECT id, name, key, journal_day, deleted_at FROM page WHERE id = ?", [pageId]);
  if (!page || page.deleted_at !== null) return undefined;
  const title = wirePageNameOf(page);
  const topLevel = driver.all<{ content: string }>(
    "SELECT content FROM block WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY order_key",
    [pageId],
  );
  const lines = topLevel
    .map((b) => firstLine(cleanBlockText(b.content)))
    .filter((l) => l.length > 0);
  const text = formatPageUnitText(title, lines);
  return { text, pageId: page.id, pageKey: page.key };
}
