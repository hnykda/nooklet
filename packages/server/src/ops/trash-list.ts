/**
 * `trash.list` (M7 item 8, ADR 022): what is in the trash — every soft-deleted page, and every
 * soft-deleted block that is the *root* of a delete action on a live page — newest first, with
 * who deleted it, read from the `changes` audit row the deletion wrote.
 *
 * "Root of a delete action": a block deleted together with its parent (same `deleted_at`
 * instant — see `./trash-restore.ts` for why that timestamp is the action's signature) is part of
 * the parent's entry, not its own. A block deleted separately, at a different instant, is its own
 * entry even if its parent is deleted too. Blocks on a deleted page are part of the page's entry.
 *
 * Nothing here expires: the trash is kept indefinitely (ADR 022), so this is the full list.
 */

import type { SqlDriver } from "@nooklet/core";
import { normalizePageName } from "@nooklet/core";
import { z } from "zod";
import { pageWireNameById, wirePageNameOf } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { Limit, OriginEnum } from "./schemas.js";
import { collectRestorableSubtree } from "./trash-restore.js";

interface PageRow {
  id: string;
  name: string;
  journal_day: number | null;
  deleted_at: number;
}

interface BlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  content: string;
  deleted_at: number;
}

interface DeletionInfo {
  origin: string;
  actor: string;
  batch_id: string;
}

/**
 * Who deleted the entity: the newest `changes` row whose after-image carries the tombstone. The
 * newest row is almost always the deletion itself; the small scan covers an edit that landed on
 * the tombstoned entity afterwards (a late sync push). `undefined` when the deletion predates the
 * audit log or its row was never written (a raw import).
 */
function deletionInfo(
  driver: SqlDriver,
  entityType: "page" | "block",
  id: string,
  deletedAt: number,
): DeletionInfo | undefined {
  const rows = driver.all<{
    origin: string;
    actor: string;
    batch_id: string;
    after_json: string | null;
  }>(
    "SELECT origin, actor, batch_id, after_json FROM changes WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 8",
    [entityType, id],
  );
  for (const r of rows) {
    if (!r.after_json) continue;
    try {
      const after = JSON.parse(r.after_json) as { deleted_at?: number | null };
      if (after.deleted_at === deletedAt) {
        return { origin: r.origin, actor: r.actor, batch_id: r.batch_id };
      }
    } catch {
      // malformed JSON should never happen (we wrote it ourselves); skip the row.
    }
  }
  return undefined;
}

function firstLine(content: string): string {
  return (content.split("\n")[0] ?? "").trim();
}

/** Cursor = `<deleted_at>:<id>` of the last item returned; both sources share one ordering
 * (`deleted_at DESC, id DESC`) so a single cursor cuts both. */
function parseCursor(cursor: string | undefined): { at: number; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const m = /^(\d+):([0-9a-z]+)$/.exec(cursor);
  if (!m) throw new OpError("invalid", "cursor is not a trash_list cursor");
  return { at: Number(m[1]), id: m[2] as string };
}

const TrashItem = z.object({
  kind: z.enum(["page", "block"]),
  id: z.string().describe("Pass to trash_restore"),
  title: z.string().describe("The page's name, or the block's first line"),
  page: z.string().describe("The page this is (or is on), by wire name"),
  block_count: z
    .number()
    .int()
    .describe("Blocks that come back with it (for a page: its blocks; for a block: its subtree)"),
  deleted_at: z.string().describe("ISO-8601"),
  deleted_by: z
    .object({ origin: OriginEnum, actor: z.string(), batch_id: z.string() })
    .optional()
    .describe("From the audit log; absent when the deletion predates it"),
});

export const trashList = defineOp({
  name: "trash.list",
  summary: "List deleted pages and blocks, newest first",
  description:
    "Lists everything in the trash: soft-deleted pages, and soft-deleted blocks on live pages " +
    "(a block deleted together with its parent is part of the parent's entry; a block on a " +
    "deleted page is part of the page's entry). Newest deletion first, each with who deleted it " +
    "(origin, actor, batch_id) when the audit log knows. Restore an item with trash_restore " +
    "and its id, or reverse the whole deleting write with batch_undo and its batch_id. The " +
    "trash never expires (ADR 022), so an item stays restorable until someone restores it. " +
    "Paginate with cursor; has_more: false means you have seen it all.",
  input: z
    .object({
      kind: z
        .enum(["page", "block", "all"])
        .default("all")
        .describe("Only pages, only blocks, or both"),
      page: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe("Only blocks deleted from this live page (by name or id)"),
      cursor: z.string().max(64).optional(),
      limit: Limit,
    })
    .strict(),
  output: z.object({
    items: z.array(TrashItem),
    cursor: z.string().optional().describe("Present when there is more; pass back as cursor"),
    has_more: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    out.items.length === 0
      ? "the trash is empty"
      : out.items
          .map(
            (i) =>
              `${i.kind} ${i.id} "${i.title}" (${i.block_count} block${i.block_count === 1 ? "" : "s"}, deleted ${i.deleted_at}${i.deleted_by ? ` by ${i.deleted_by.actor}` : ""})`,
          )
          .join("\n") + (out.has_more ? "\n…more" : ""),
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const after = parseCursor(input.cursor);
    const fetchN = input.limit + 1;
    const cursorSql = after ? "AND (deleted_at < ? OR (deleted_at = ? AND id < ?))" : "";
    const blockCursorSql = after ? "AND (b.deleted_at < ? OR (b.deleted_at = ? AND b.id < ?))" : "";
    const cursorParams = after ? [after.at, after.at, after.id] : [];

    let pageFilterId: string | undefined;
    if (input.page !== undefined) {
      const row =
        driver.get<{ id: string }>("SELECT id FROM page WHERE id = ? AND deleted_at IS NULL", [
          input.page,
        ]) ??
        driver.get<{ id: string }>("SELECT id FROM page WHERE key = ? AND deleted_at IS NULL", [
          normalizePageName(input.page),
        ]);
      if (!row) throw new OpError("not_found", `no live page "${input.page}"`);
      pageFilterId = row.id;
    }

    type Merged = { at: number; id: string; item: z.infer<typeof TrashItem> };
    const merged: Merged[] = [];

    if (input.kind !== "block" && pageFilterId === undefined) {
      const pages = driver.all<PageRow>(
        `SELECT id, name, journal_day, deleted_at FROM page
         WHERE deleted_at IS NOT NULL ${cursorSql}
         ORDER BY deleted_at DESC, id DESC LIMIT ?`,
        [...cursorParams, fetchN],
      );
      for (const p of pages) {
        const blockCount =
          driver.get<{ n: number }>(
            "SELECT count(*) AS n FROM block WHERE page_id = ? AND (deleted_at IS NULL OR deleted_at = ?)",
            [p.id, p.deleted_at],
          )?.n ?? 0;
        merged.push({
          at: p.deleted_at,
          id: p.id,
          item: {
            kind: "page",
            id: p.id,
            title: p.name,
            page: wirePageNameOf(p),
            block_count: blockCount,
            deleted_at: new Date(p.deleted_at).toISOString(),
            deleted_by: deletionInfo(driver, "page", p.id, p.deleted_at) as
              | (DeletionInfo & { origin: z.infer<typeof OriginEnum> })
              | undefined,
          },
        });
      }
    }

    if (input.kind !== "page") {
      const pageSql = pageFilterId !== undefined ? "AND b.page_id = ?" : "";
      const pageParams = pageFilterId !== undefined ? [pageFilterId] : [];
      const blocks = driver.all<BlockRow>(
        `SELECT b.id, b.page_id, b.parent_id, b.content, b.deleted_at
         FROM block b
         JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
         LEFT JOIN block par ON par.id = b.parent_id
         WHERE b.deleted_at IS NOT NULL
           AND (b.parent_id IS NULL OR par.deleted_at IS NULL OR par.deleted_at != b.deleted_at)
           ${pageSql}
           ${blockCursorSql}
         ORDER BY b.deleted_at DESC, b.id DESC LIMIT ?`,
        [...pageParams, ...cursorParams, fetchN],
      );
      for (const b of blocks) {
        const { tombstoned, hidden } = collectRestorableSubtree(driver, b);
        merged.push({
          at: b.deleted_at,
          id: b.id,
          item: {
            kind: "block",
            id: b.id,
            title: firstLine(b.content),
            page: pageWireNameById(driver, b.page_id),
            block_count: tombstoned.length + hidden.length,
            deleted_at: new Date(b.deleted_at).toISOString(),
            deleted_by: deletionInfo(driver, "block", b.id, b.deleted_at) as
              | (DeletionInfo & { origin: z.infer<typeof OriginEnum> })
              | undefined,
          },
        });
      }
    }

    merged.sort((a, b) => b.at - a.at || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
    const hasMore = merged.length > input.limit;
    const page = merged.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((m) => m.item),
      cursor: hasMore && last ? `${last.at}:${last.id}` : undefined,
      has_more: hasMore,
    };
  },
});
