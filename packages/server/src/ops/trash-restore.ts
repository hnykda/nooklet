/**
 * `trash.restore` (M7 item 8, ADR 022): bring a soft-deleted page or block back, through
 * `serverApplyOps` like every other write — it mints `page.delete {deletedAt: null}` /
 * `block.delete {deletedAt: null}` exactly the way `batch.undo` does, never a raw UPDATE, so the
 * restore replicates to every device and is itself a batch `batch.undo` can reverse.
 *
 * What comes back with the thing you asked for:
 *
 *  - A **page** restores with every block that was tombstoned *at the same instant* as the page.
 *    `page.delete` stamps one `now` on the page and all of its blocks (../ops/page-delete.ts), so
 *    that instant is the delete action's own signature; a block deleted separately, earlier, keeps
 *    its own tombstone and stays in the trash as its own entry. Blocks that were never tombstoned
 *    (hidden only because their page was) need no op at all — they reappear with the page.
 *  - A **block** restores with the descendants that share its `deleted_at` (the editor's
 *    `deleteSelectedBlocks` and the API's `block.delete` both tombstone the whole subtree with one
 *    timestamp), plus any tombstoned *ancestor*, so the restored block is actually visible rather
 *    than live-but-hidden under a parent that is still in the trash. Only the ancestor chain is
 *    revived, not the ancestors' other deleted children — those stay in the trash as their own
 *    entries.
 *
 * Refused rather than guessed at:
 *
 *  - A page whose name is now taken by a live page. Core rejects that un-delete
 *    (`page-key-collision`, docs/BUGS.md B-90) but would apply the block un-deletes in the same
 *    batch, leaving live blocks on a page still in the trash; this op checks first and asks for
 *    `new_name` (also when a live page uses the name as an alias, B-256).
 *  - `new_name` for a journal day. A journal page's name is derived from its date (ADR 018), so
 *    core stores any rename of it under the ISO name again — the rename and the un-delete were both
 *    rejected while the blocks came back, and the call answered 200.
 *  - A block whose page is itself in the trash, with a pointer at the page — restoring one block
 *    onto a deleted page would "succeed" invisibly.
 *
 * Anything core still rejects rolls the whole restore back (`./apply-all-or-nothing.ts`).
 */

import type { Op, SqlDriver } from "@nooklet/core";
import { normalizePageName } from "@nooklet/core";
import { z } from "zod";
import { pageWireNameById, wirePageNameOf } from "../rows.js";
import { applyAllOrNothing } from "./apply-all-or-nothing.js";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { BatchIdOut, IdempotencyKey } from "./schemas.js";

interface TrashPageRow {
  id: string;
  name: string;
  key: string;
  journal_day: number | null;
  deleted_at: number | null;
}

interface TrashBlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  content: string;
  deleted_at: number | null;
}

const BLOCK_COLS = "id, page_id, parent_id, content, deleted_at";

/**
 * The blocks that come back when `rootId` is restored: the root itself, every descendant
 * tombstoned at the same instant (one delete action), and every descendant that was never
 * tombstoned (hidden only by its ancestor). A descendant tombstoned at a *different* instant is a
 * separate trash entry; the walk stops there and does not descend into it.
 */
export function collectRestorableSubtree(
  driver: SqlDriver,
  root: TrashBlockRow,
): { tombstoned: TrashBlockRow[]; hidden: TrashBlockRow[] } {
  const tombstoned: TrashBlockRow[] = [root];
  const hidden: TrashBlockRow[] = [];
  const queue = [root.id];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of driver.all<TrashBlockRow>(
      `SELECT ${BLOCK_COLS} FROM block WHERE parent_id = ?`,
      [parentId],
    )) {
      if (child.deleted_at === null) hidden.push(child);
      else if (child.deleted_at === root.deleted_at) tombstoned.push(child);
      else continue;
      queue.push(child.id);
    }
  }
  return { tombstoned, hidden };
}

/** Tombstoned ancestors of `block`, nearest first — the chain that has to come back for the block
 * to be visible. Stops at the first live ancestor (everything above it is visible already). */
export function tombstonedAncestors(driver: SqlDriver, block: TrashBlockRow): TrashBlockRow[] {
  const chain: TrashBlockRow[] = [];
  let parentId = block.parent_id;
  let guard = 0;
  while (parentId !== null && guard++ < 1000) {
    const parent = driver.get<TrashBlockRow>(`SELECT ${BLOCK_COLS} FROM block WHERE id = ?`, [
      parentId,
    ]);
    if (!parent) break;
    if (parent.deleted_at !== null) chain.push(parent);
    parentId = parent.parent_id;
  }
  return chain;
}

/** The most recent tombstoned page stored under `name` — a deleted page is not reachable through
 * `requirePage`, which (rightly) only sees live pages. */
export function findTrashedPageByName(driver: SqlDriver, name: string): TrashPageRow | undefined {
  return driver.get<TrashPageRow>(
    "SELECT id, name, key, journal_day, deleted_at FROM page WHERE key = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1",
    [normalizePageName(name)],
  );
}

function livePageWithKey(driver: SqlDriver, key: string): { id: string; name: string } | undefined {
  return driver.get<{ id: string; name: string }>(
    "SELECT id, name FROM page WHERE key = ? AND deleted_at IS NULL",
    [key],
  );
}

/**
 * The live page, other than `exceptPageId`, that answers to `key` as an alias (B-256). A page's
 * own key wins over an alias when a link resolves (`page-aliases.ts#resolvePageIdForKey`), so
 * restoring a page under a name another page aliases silently re-points every `[[name]]` at the
 * restored page — which is exactly what un-merging "Alex" from "@Alex" (`alias:: Alex`) did.
 */
function livePageAliasing(
  driver: SqlDriver,
  key: string,
  exceptPageId: string,
): { id: string; name: string } | undefined {
  return driver.get<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM page_alias pa JOIN page p ON p.id = pa.page_id
     WHERE pa.alias_key = ? AND p.deleted_at IS NULL AND p.id != ? LIMIT 1`,
    [key, exceptPageId],
  );
}

/** Refuse a restored name that a live page already has, or uses as an alias. `liveHint` is the
 * hint for the first case; the alias case always says how to get past it. */
function assertNameFree(
  driver: SqlDriver,
  name: string,
  restoringPageId: string,
  liveHint: string | undefined,
): void {
  const key = normalizePageName(name);
  const clash = livePageWithKey(driver, key);
  if (clash) {
    throw new OpError("conflict", `a live page is already named "${clash.name}"`, liveHint, {
      live_page_id: clash.id,
    });
  }
  const aliasing = livePageAliasing(driver, key, restoringPageId);
  if (aliasing) {
    throw new OpError(
      "conflict",
      `a live page, "${aliasing.name}", uses "${name}" as an alias`,
      `restore under another name with new_name, or remove "${name}" from ${aliasing.name}'s alias:: first`,
      { live_page_id: aliasing.id },
    );
  }
}

export const trashRestore = defineOp({
  name: "trash.restore",
  summary: "Restore a deleted page or block from the trash",
  description:
    "Brings a soft-deleted page or block back from the trash (see trash_list for what is there " +
    "and its ids). A page comes back with every block that was deleted along with it; a block " +
    "comes back with the subtree deleted along with it, plus any deleted ancestor it needs in " +
    "order to be visible. Pass id (a page or block id from trash_list) or page (the name of a " +
    "deleted page). If a live page now has the restored page's name, or uses it as an alias, this " +
    "fails with conflict - pass new_name to restore it under another name instead. A block whose " +
    "whole page is in the trash is refused with conflict: restore the page. The restore is " +
    "itself a normal write " +
    "with its own batch_id, so batch_undo reverses it. The trash has no expiry (ADR 022): " +
    "nothing is ever purged, so anything trash_list shows can be restored. Use dry_run to see " +
    "what would come back without writing anything.",
  input: z
    .object({
      id: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("A deleted page's or block's id, as returned by trash_list"),
      page: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe("Alternatively, the name of a deleted page (case-insensitive)"),
      new_name: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe(
          "Pages only: restore under this name instead (required when a live page already has the old name)",
        ),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    kind: z.enum(["page", "block"]),
    id: z.string(),
    page: z.string().describe("The page the restored thing is on, after the restore"),
    restored: z
      .array(z.string())
      .describe("Every page/block id un-deleted by this call, the target first"),
    revealed: z
      .number()
      .int()
      .describe(
        "Blocks that were never tombstoned and became visible again (no op needed for them)",
      ),
    seq: z.number().int(),
    batch_id: BatchIdOut,
    dry_run: z.boolean(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) =>
    `restored ${out.kind} ${out.page} (${out.restored.length} entit${out.restored.length === 1 ? "y" : "ies"} un-deleted, ${out.revealed} revealed)`,
  handler: async (input, ctx) => {
    if ((input.id === undefined) === (input.page === undefined)) {
      throw new OpError("invalid", "pass exactly one of id or page", "ids come from trash_list");
    }
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const driver = ctx.db;

      // ---- resolve: a page (by id or name) or a block (by id) --------------------------------
      let page: TrashPageRow | undefined;
      let block: TrashBlockRow | undefined;
      if (input.page !== undefined) {
        page = findTrashedPageByName(driver, input.page);
        if (!page) {
          const live = livePageWithKey(driver, normalizePageName(input.page));
          if (live) {
            throw new OpError("invalid", `page "${input.page}" is not in the trash`);
          }
          throw new OpError("not_found", `no deleted page named "${input.page}"`);
        }
      } else {
        const id = input.id as string;
        page = driver.get<TrashPageRow>(
          "SELECT id, name, key, journal_day, deleted_at FROM page WHERE id = ?",
          [id],
        );
        if (page) {
          if (page.deleted_at === null) {
            throw new OpError("invalid", `page "${page.name}" is not in the trash`);
          }
        } else {
          block = driver.get<TrashBlockRow>(`SELECT ${BLOCK_COLS} FROM block WHERE id = ?`, [id]);
          if (!block) throw new OpError("not_found", `nothing with id ${id} exists`);
          if (block.deleted_at === null) {
            throw new OpError("invalid", `block ${id} is not in the trash`);
          }
        }
      }

      const ops: Op[] = [];
      const restored: string[] = [];
      let revealed = 0;
      let kind: "page" | "block";
      let pageId: string;

      if (page) {
        kind = "page";
        pageId = page.id;
        if (input.new_name === undefined) {
          assertNameFree(
            driver,
            page.name,
            page.id,
            "pass new_name to restore this page under a different name, or rename/delete the live page first",
          );
        } else {
          if (page.journal_day !== null) {
            throw new OpError(
              "invalid",
              `page "${page.name}" is a journal day, whose name is its date; new_name cannot rename it`,
              "delete or merge away the live page for that day, then restore this one without new_name",
            );
          }
          assertNameFree(driver, input.new_name, page.id, undefined);
          // Rename lands while the page is still tombstoned (core's rename only guards against
          // LIVE pages with the key), then the un-delete brings it back under the new name.
          ops.push(ctx.mintOp(page.id, { kind: "page.rename", name: input.new_name }));
        }
        ops.push(ctx.mintOp(page.id, { kind: "page.delete", deletedAt: null }));
        restored.push(page.id);
        // Blocks tombstoned by the same delete action come back; separately-deleted ones stay.
        const blocks = driver.all<{ id: string; deleted_at: number | null }>(
          "SELECT id, deleted_at FROM block WHERE page_id = ? AND (deleted_at IS NULL OR deleted_at = ?)",
          [page.id, page.deleted_at],
        );
        for (const b of blocks) {
          if (b.deleted_at === null) {
            revealed++;
            continue;
          }
          ops.push(ctx.mintOp(b.id, { kind: "block.delete", deletedAt: null }));
          restored.push(b.id);
        }
      } else {
        const root = block as TrashBlockRow;
        kind = "block";
        pageId = root.page_id;
        if (input.new_name !== undefined) {
          throw new OpError("invalid", "new_name applies to pages only");
        }
        const pageRow = driver.get<{ deleted_at: number | null; name: string }>(
          "SELECT deleted_at, name FROM page WHERE id = ?",
          [root.page_id],
        );
        if (!pageRow) throw new OpError("not_found", `block ${root.id}'s page no longer exists`);
        if (pageRow.deleted_at !== null) {
          throw new OpError(
            "conflict",
            `block ${root.id} is on page "${pageRow.name}", which is in the trash`,
            `restore the page instead: trash_restore { id: "${root.page_id}" }`,
            { page_id: root.page_id },
          );
        }
        const { tombstoned, hidden } = collectRestorableSubtree(driver, root);
        for (const b of tombstoned) {
          ops.push(ctx.mintOp(b.id, { kind: "block.delete", deletedAt: null }));
          restored.push(b.id);
        }
        revealed = hidden.length;
        for (const ancestor of tombstonedAncestors(driver, root)) {
          ops.push(ctx.mintOp(ancestor.id, { kind: "block.delete", deletedAt: null }));
          restored.push(ancestor.id);
        }
      }

      const applyResult = await applyAllOrNothing(ctx, ops, "trash_restore");
      const pageWire =
        kind === "page" && input.new_name !== undefined
          ? wirePageNameOf({ name: input.new_name, journal_day: page?.journal_day ?? null })
          : pageWireNameById(driver, pageId);
      return {
        kind,
        id: restored[0] as string,
        page: pageWire,
        restored,
        revealed,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
