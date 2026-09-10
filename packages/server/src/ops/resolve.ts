/**
 * Small helpers shared by the 16 op handlers: `PageRef` resolution (name / id / journal date /
 * `today`|`yesterday`|`tomorrow`, mcp-tools.md's `PageRef` schema), the wire `page` name for a
 * journal (rule 18: ISO date, never the display title), `PageMeta` construction, and
 * `if_version` conflict checking.
 */

import type { Page, SqlDriver } from "@vrite/core";
import { isId } from "@vrite/core";
import { isoFromJournalDay, journalDayFromWire } from "../data-api.js";
import { OpError, type OpContext } from "./registry.js";
import type { PageMeta as PageMetaSchema } from "./schemas.js";
import type { z } from "zod";

export type PageMetaT = z.output<typeof PageMetaSchema>;

/** Resolve a `PageRef` string. Returns `null` when nothing matches (never creates). */
export async function resolvePageRef(ctx: OpContext, ref: string, opts?: { create?: boolean }): Promise<Page | null> {
  if (journalDayFromWire(ref) !== null) {
    return ctx.data.pages.journal(ref, { create: opts?.create ?? false });
  }
  if (isId(ref)) {
    const byId = await ctx.data.pages.get(ref);
    if (byId) return byId;
  }
  return ctx.data.pages.get({ name: ref });
}

export async function requirePage(ctx: OpContext, ref: string, opts?: { create?: boolean }): Promise<Page> {
  const page = await resolvePageRef(ctx, ref, opts);
  if (!page) {
    throw new OpError("not_found", `no page named "${ref}"`, "use page_create or page_append to create it");
  }
  return page;
}

/** rule 18: a journal page's wire `page` field is its ISO date, never the display title. */
export function wirePageName(page: Page): string {
  return page.journalDay !== null ? isoFromJournalDay(page.journalDay) : page.name;
}

export function pageMetaWire(driver: SqlDriver, page: Page, opts?: { backlinkCount?: number }): PageMetaT {
  const blockCount =
    driver.get<{ n: number }>("SELECT count(*) AS n FROM block WHERE page_id = ? AND deleted_at IS NULL", [page.id])
      ?.n ?? 0;
  return {
    id: page.id,
    name: page.name,
    kind: page.journalDay !== null ? "journal" : "page",
    journal_date: page.journalDay !== null ? isoFromJournalDay(page.journalDay) : undefined,
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
    throw new OpError("conflict", "target has changed since if_version", "read it again to get the current version", {
      current_version: current,
    });
  }
}
