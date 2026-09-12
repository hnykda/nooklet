/**
 * Small helpers shared by the 16 op handlers: `PageRef` resolution (name / id / journal date /
 * `today`|`yesterday`|`tomorrow`, mcp-tools.md's `PageRef` schema), the wire `page` name for a
 * journal (rule 18: ISO date, never the display title), `PageMeta` construction, and
 * `if_version` conflict checking.
 */

import type { Page, SqlDriver } from "@nooklet/core";
import { isId, isoJournalName, parseJournalTitle } from "@nooklet/core";
import type { z } from "zod";
import { journalDayFromWire, WIRE_DATE_RE } from "../data-api.js";
import { type OpContext, OpError } from "./registry.js";
import type { PageMeta as PageMetaSchema } from "./schemas.js";

export type PageMetaT = z.output<typeof PageMetaSchema>;

/**
 * Resolve a `PageRef` string, optionally creating the page it names.
 *
 * Order matters, and each step earns its place:
 *
 *  1. An ISO date or `today`/`yesterday`/`tomorrow` is a journal day — the documented wire form.
 *  2. A 14-char id is an id.
 *  3. A name is a name, INCLUDING one that happens to look like a date: a page someone
 *     deliberately called `11.12.2024` must stay reachable by that name.
 *  4. Only when no such page exists, a name in any other recognised journal title format
 *     (`Sep 4th, 2026`, `Mon, 07.09.2026`) means that journal day. Without this, `page_append`
 *     with a human-written date would create an ordinary page shadowing the journal forever —
 *     the same hole B-23 closed in `page.create`, through a different door.
 *  5. Failing everything, `create` makes an ordinary page. Step 4 having run first is what keeps
 *     this from minting a shadow journal.
 */
export async function resolvePageRef(
  ctx: OpContext,
  ref: string,
  opts?: { create?: boolean },
): Promise<Page | null> {
  const create = opts?.create ?? false;
  if (journalDayFromWire(ref) !== null) {
    return ctx.data.pages.journal(ref, { create });
  }
  // Shaped like a wire date but not a real day (`2026-13-45`): almost certainly a typo, and
  // falling through would mint an ordinary page under that name — a shadow journal that no date
  // format resolves to. Say so instead.
  if (WIRE_DATE_RE.test(ref.trim())) {
    throw new OpError(
      "invalid",
      `"${ref}" looks like a date but is not a valid calendar day`,
      "use YYYY-MM-DD with a real month and day, or today/yesterday/tomorrow",
    );
  }
  if (isId(ref)) {
    const byId = await ctx.data.pages.get(ref);
    if (byId) return byId;
  }
  const byName = await ctx.data.pages.get({ name: ref });
  if (byName) return byName;

  const asJournalDay = parseJournalTitle(ref);
  if (asJournalDay !== null) {
    return ctx.data.pages.journal(isoJournalName(asJournalDay), { create });
  }
  if (!create) return null;
  return ctx.data.pages.create({ name: ref });
}

export async function requirePage(
  ctx: OpContext,
  ref: string,
  opts?: { create?: boolean },
): Promise<Page> {
  const page = await resolvePageRef(ctx, ref, opts);
  if (!page) {
    throw new OpError(
      "not_found",
      `no page named "${ref}"`,
      "use page_create or page_append to create it",
    );
  }
  return page;
}

/** rule 18: a journal page's wire `page` field is its ISO date, never the display title. */
export function wirePageName(page: Page): string {
  return page.journalDay !== null ? isoJournalName(page.journalDay) : page.name;
}

export function pageMetaWire(
  driver: SqlDriver,
  page: Page,
  opts?: { backlinkCount?: number },
): PageMetaT {
  const blockCount =
    driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM block WHERE page_id = ? AND deleted_at IS NULL",
      [page.id],
    )?.n ?? 0;
  return {
    id: page.id,
    name: page.name,
    kind: page.journalDay !== null ? "journal" : "page",
    journal_date: page.journalDay !== null ? isoJournalName(page.journalDay) : undefined,
    properties: Object.keys(page.properties).length > 0 ? page.properties : undefined,
    version: new Date(page.updatedAt).toISOString(),
    block_count: blockCount,
    created_at: new Date(page.createdAt).toISOString(),
    updated_at: new Date(page.updatedAt).toISOString(),
    backlink_count: opts?.backlinkCount,
  };
}

/** The current changes-log head (`graph_overview.seq`'s definition), used as a write's `seq` when
 * nothing actually changed (e.g. `page.create` with `if_exists: 'return'` and no new markdown). */
export function currentHeadSeq(driver: SqlDriver): number {
  return driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0;
}

/** Resolve a `pages` filter array (search's `pages`/`page.backlinks`-adjacent inputs) to page ids,
 * silently dropping refs that don't resolve to anything live. */
export async function resolvePageIds(ctx: OpContext, refs: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    const page = await resolvePageRef(ctx, ref);
    if (page) ids.push(page.id);
  }
  return ids;
}

export function checkIfVersion(currentUpdatedAt: number, ifVersion: string | undefined): void {
  if (ifVersion === undefined) return;
  const current = new Date(currentUpdatedAt).toISOString();
  if (current !== ifVersion) {
    throw new OpError(
      "conflict",
      "target has changed since if_version",
      "read it again to get the current version",
      {
        current_version: current,
      },
    );
  }
}
