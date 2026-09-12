/**
 * The journal template, as the server sees it (ADR 019).
 *
 * Which block is the journal template is a fact stored in the graph — `journal-template:: true`
 * on a block that also says `template:: <name>` — so the server reads it from `block_prop` the
 * same way the client reads its replica (`apps/web/src/data/templates.ts`), with the same tie
 * rule (several claimants: the oldest block wins; ids are time-ordered). No settings row, no
 * second source of truth, and an agent can change it with `block_update`.
 *
 * Only `data-api.ts#journal()` calls this, when it creates a day for an API caller. The block
 * copy itself is `@nooklet/core`'s `templateInsertOps`, shared with the client so a day born
 * here is indistinguishable from one born on a first keystroke.
 */

import {
  isTruthyProp,
  JOURNAL_TEMPLATE_PROP,
  type SqlDriver,
  type TemplateNode,
} from "@nooklet/core";
import { BLOCK_COLUMNS, type BlockRow, getBlockRow, rowToBlock } from "./rows.js";

/** The journal template's block id, or `null` when none is chosen. */
export function journalTemplateId(driver: SqlDriver): string | null {
  const rows = driver.all<{ id: string; value: string | null }>(
    `SELECT j.block_id AS id, j.value AS value
     FROM block_prop j
     JOIN block b ON b.id = j.block_id AND b.deleted_at IS NULL
     JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE j.key = ? AND j.value IS NOT NULL
     ORDER BY j.block_id`,
    [JOURNAL_TEMPLATE_PROP],
  );
  return rows.find((r) => isTruthyProp(r.value))?.id ?? null;
}

/** A live block and its subtree as a `TemplateNode`, properties wire-shaped (`rowToBlock`), or
 * `null` if the block is gone. */
export function loadTemplateNode(driver: SqlDriver, rootId: string): TemplateNode | null {
  const root = getBlockRow(driver, rootId);
  if (!root || root.deleted_at !== null) return null;
  const build = (row: BlockRow): TemplateNode => {
    const block = rowToBlock(driver, row);
    const children = driver.all<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM block
       WHERE page_id = ? AND parent_id = ? AND deleted_at IS NULL
       ORDER BY order_key, id`,
      [row.page_id, row.id],
    );
    return {
      content: block.content,
      marker: block.marker,
      priority: block.priority,
      collapsed: block.collapsed,
      properties: block.properties,
      children: children.map(build),
    };
  };
  return build(root);
}

/** The chosen journal template, loaded, or `null` when there is none. */
export function journalTemplateNode(driver: SqlDriver): TemplateNode | null {
  const id = journalTemplateId(driver);
  return id ? loadTemplateNode(driver, id) : null;
}
