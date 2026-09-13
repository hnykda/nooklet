/**
 * A page's markdown from the local replica, plus the two page facts the page actions need
 * (B-220, B-222): which page a name means, and whether it is a favourite.
 *
 * The text is the markdown mirror's, byte for byte: the same four queries and the same row ->
 * tree build (`@nooklet/core`'s `sync/page-outline.ts`) and the same `serializeOutline` the
 * server's `mirror/export.ts` writes `pages/*.md` with. Rendering here rather than asking the
 * server means an export works offline and includes what was typed a moment ago and not yet
 * pushed — this is a local-first app, and "give me my page" must not depend on a connection.
 *
 * The four reads are separate worker RPCs, so a write landing between two of them could in
 * principle produce a torn render (a block without its properties). The window is one worker
 * round trip, the result is a copy the person can simply make again, and a single-transaction
 * worker method would have been a fourth file in `db/` for no observed failure — accepted.
 */

import {
  buildPageOutline,
  normalizePageName,
  PAGE_OUTLINE_SQL,
  type PageOutlineBlockPropRow,
  type PageOutlineBlockRow,
  type PageOutlinePageRow,
  type PageOutlinePropRow,
  pageMirrorPath,
  parseJournalTitle,
  serializeOutline,
} from "@nooklet/core";
import { queryAs } from "../db/client.js";

export interface PageMarkdown {
  /** The mirror file's own name (`Projects___Aurora.md`, `2026_09_13.md`). */
  fileName: string;
  text: string;
}

/**
 * Render `pageId` as outline markdown. `ids: "present"` is the mirror file exactly, `^id` suffixes
 * and all — what "Export page as markdown" downloads, and what re-imports losslessly.
 * `ids: "none"` drops them — what "Copy page as markdown" puts on the clipboard, for pasting into
 * a mail or a chat where a `^1k7f3q9xz2hav4` on every line is noise (and a paste back into
 * nooklet mints fresh ids anyway, `editor/paste.ts`). `undefined` when the page does not exist.
 */
export async function renderPageMarkdown(
  pageId: string,
  opts: { ids: "present" | "none" },
): Promise<PageMarkdown | undefined> {
  const [page, pageProps, blocks, blockProps] = await Promise.all([
    queryAs<PageOutlinePageRow>(PAGE_OUTLINE_SQL.page, [pageId]),
    queryAs<PageOutlinePropRow>(PAGE_OUTLINE_SQL.pageProps, [pageId]),
    queryAs<PageOutlineBlockRow>(PAGE_OUTLINE_SQL.blocks, [pageId]),
    queryAs<PageOutlineBlockPropRow>(PAGE_OUTLINE_SQL.blockProps, [pageId]),
  ]);
  const rendered = buildPageOutline(pageId, { page: page[0], pageProps, blocks, blockProps });
  if (!rendered) return undefined;
  const path = pageMirrorPath(rendered);
  return {
    fileName: path.slice(path.lastIndexOf("/") + 1),
    text: serializeOutline(rendered.parsed, { ids: opts.ids }),
  };
}

/**
 * The live page a route name means, resolved the way the page view resolves it
 * (`./store.ts#usePageByName`): by normalized key, then — for a date in any title format — by
 * journal day. Not reactive; for one-shot actions.
 */
export async function findPageIdByName(name: string): Promise<string | undefined> {
  const byKey = await queryAs<{ id: string }>(
    "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL LIMIT 1",
    [normalizePageName(name)],
  );
  if (byKey[0]) return byKey[0].id;
  const day = parseJournalTitle(name);
  if (day === null) return undefined;
  const byDay = await queryAs<{ id: string }>(
    "SELECT id FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
    [day],
  );
  return byDay[0]?.id;
}

/**
 * Whether a stored `favorite` property value means "favourite". Exactly the sidebar's test
 * (`./store.ts#useFavoritePages`: `value NOT IN ('', 'false')`, and NULL is not a value), so the
 * star on a page and the Favourites list can never disagree about the same page.
 */
export function isFavoriteValue(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value !== "" && value !== "false";
}

export async function isPageFavorite(pageId: string): Promise<boolean> {
  const rows = await queryAs<{ value: string | null }>(
    "SELECT value FROM page_prop WHERE page_id = ? AND key = 'favorite'",
    [pageId],
  );
  return isFavoriteValue(rows[0]?.value);
}
