/**
 * "Delete page" (`app.deletePage`): look the page up, refuse a journal day, ask, delete, go to the
 * journal. Every effect is a dependency — the real ones are wired in `./page-actions-host.ts` — so
 * the order and the refusals are unit-tested (`./page-delete.test.ts`) without a server or a DOM.
 *
 * A journal day is refused before anything is asked. PLAN §8 and ADR 018 make the day the page's
 * identity: there is always a page for a date (virtual until written in), so "delete 2026-09-13"
 * has nothing to mean, and the server's `page.delete` answers `invalid` for one. The title row
 * does not offer Delete on a journal at all; this is the palette's path to the same answer.
 *
 * The confirmation quotes the server's dry run (how many blocks go with the page, whether links
 * will dangle), so what it promises is what the op will do.
 */

import { describeError } from "../data/api-client.js";
import type { PageDeletePreview, PageToDelete } from "../data/page-delete.js";
import type { ConfirmOptions } from "./confirm-dialog.js";

export interface PageDeleteDeps {
  findPage(name: string): Promise<PageToDelete | undefined>;
  preview(pageId: string): Promise<PageDeletePreview>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  remove(pageId: string): Promise<unknown>;
  navigate(path: string): void;
  /** The one-line notice on the page's title row (`./page-actions.ts`). */
  notify(text: string, error: boolean): void;
}

export type PageDeleteOutcome = "deleted" | "cancelled" | "journal" | "missing" | "failed";

/** Where a deleted page's view goes: the page is gone, and the journal is the app's home. */
export const AFTER_DELETE_PATH = "/journals";

export const JOURNAL_DELETE_NOTICE =
  "Journal days can't be deleted. Delete the blocks you don't want instead.";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function pageDeleteConfirmation(name: string, preview: PageDeletePreview): ConfirmOptions {
  const withBlocks = preview.blocks > 0 ? ` and its ${plural(preview.blocks, "block")}` : "";
  const message = [
    `"${name}"${withBlocks} will be moved to the Trash. You can restore ${
      preview.blocks > 0 ? "them" : "it"
    } from there.`,
  ];
  // No number: the dry run's `backlinks_affected` counts every block UNDER a linking block too
  // (`path_ref`) — 98 for a page three blocks link to on the owner's graph (B-492). Any count above
  // zero does mean at least one real link on another page, which is all this sentence claims.
  if (preview.backlinks > 0) {
    message.push(
      "Links to it from other pages will point at a page that doesn't exist until it is restored.",
    );
  }
  return {
    title: `Delete "${name}"?`,
    message,
    confirmLabel: "Delete page",
    destructive: true,
  };
}

export async function deletePageWithConfirm(
  name: string,
  deps: PageDeleteDeps,
): Promise<PageDeleteOutcome> {
  const page = await deps.findPage(name);
  if (!page) {
    deps.notify(`Couldn't delete — no page named "${name}"`, true);
    return "missing";
  }
  if (page.journalDay !== null) {
    deps.notify(JOURNAL_DELETE_NOTICE, true);
    return "journal";
  }
  let preview: PageDeletePreview;
  try {
    preview = await deps.preview(page.id);
  } catch (err) {
    deps.notify(`Couldn't delete "${page.name}": ${describeError(err)}`, true);
    return "failed";
  }
  if (!(await deps.confirm(pageDeleteConfirmation(page.name, preview)))) return "cancelled";
  try {
    await deps.remove(page.id);
  } catch (err) {
    deps.notify(`Couldn't delete "${page.name}": ${describeError(err)}`, true);
    return "failed";
  }
  deps.navigate(AFTER_DELETE_PATH);
  return "deleted";
}
