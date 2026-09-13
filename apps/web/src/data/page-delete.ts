/**
 * Deleting a page from the app goes through the server's `page.delete`, not locally minted
 * `page.delete`/`block.delete` ops.
 *
 * Three reasons, each of which a local batch would get wrong:
 *
 * - **One instant.** `trash.restore` brings back the blocks whose `deleted_at` equals the page's
 *   (B-121); the server op stamps one `now` on all of them.
 * - **Who did it.** The Trash shows the deleter, which comes from the `changes` audit row the server
 *   writes for an HTTP call — the same path an agent's `page_delete` takes, so the two cannot drift.
 * - **Its guards.** The op refuses a journal day and reports how many links will dangle; the dry
 *   run is what the confirmation quotes.
 *
 * Like `./page-rename.ts`: push first (a page created in this tab a moment ago may not be on the
 * server yet, and the op would answer "no page"), pull after (so the page leaves the local replica,
 * and every list on it, before the caller navigates away).
 */

import { forceSync, queryAs } from "../db/client.js";
import { callOp } from "./api-client.js";
import { findPageIdByName } from "./page-export.js";

export interface PageToDelete {
  id: string;
  name: string;
  journalDay: number | null;
}

/** The live page `name` means (as the page view resolves it), with what deciding needs. */
export async function findPageToDelete(name: string): Promise<PageToDelete | undefined> {
  const id = await findPageIdByName(name);
  if (id === undefined) return undefined;
  const rows = await queryAs<{ id: string; name: string; journal_day: number | null }>(
    "SELECT id, name, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
    [id],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, journalDay: row.journal_day } : undefined;
}

export interface PageDeletePreview {
  /** Blocks that go to the Trash with the page. */
  blocks: number;
  /** The server's `backlinks_affected`: above zero means some block on another page links here.
   * NOT a count of links — it counts the blocks beneath a linking block as well (B-492). */
  backlinks: number;
}

interface PageDeleteOut {
  page: string;
  deleted_blocks: number;
  backlinks_affected: number;
  batch_id?: string;
}

/** What deleting would do, by the server's own dry run. Pushes pending writes first. Throws
 * `ApiError` (`not_found`, `invalid` for a journal day) with nothing written. */
export async function previewPageDelete(pageId: string): Promise<PageDeletePreview> {
  await forceSync();
  const out = await callOp<PageDeleteOut>("page.delete", { page: pageId, dry_run: true });
  return { blocks: out.deleted_blocks, backlinks: out.backlinks_affected };
}

/** Delete the page and its blocks (to the Trash), then pull so the replica agrees. */
export async function deletePage(pageId: string): Promise<PageDeletePreview> {
  const out = await callOp<PageDeleteOut>("page.delete", { page: pageId });
  await forceSync();
  return { blocks: out.deleted_blocks, backlinks: out.backlinks_affected };
}
