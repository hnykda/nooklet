/**
 * Linked and unlinked references over the reference index (`./ref-index.ts`): the rows behind the
 * server's `page.backlinks` op and, since B-641, behind a client replica's references panel too.
 * One copy of the SQL, so the device and the server cannot disagree about which blocks reference a
 * page, which of them link it directly (the B-596 count), or what counts as a mention.
 *
 * Needs `ref`/`path_ref`/`page_tag`/`page_alias`, and `block_fts` for unlinked mentions (the server
 * has it; a replica has it when its SQLite has FTS5 — `apps/web/src/db/schema-client.ts`).
 */

import { ftsPhrase } from "../fts-query.js";
import { isId } from "../ids.js";
import {
  isoJournalName,
  isValidJournalDay,
  parseJournalTitle,
  todayJournalDay,
} from "../journal.js";
import { refKeyOf } from "../page-alias.js";
import { normalizePageName } from "../page-name.js";
import type { SqlDriver } from "./driver.js";
import { pageLookupKeys, resolvePageIdForKey } from "./page-alias-index.js";
import { pagesTaggedWith, type TaggedPageRow } from "./page-tag-index.js";

/** What a backlinks question is about, once resolved. A `key` target is a page that is referenced
 * but does not exist (yet): refs are stored against keys, so it still has backlinks. */
export type BacklinksTarget =
  | { kind: "page"; page: { id: string; key: string; name: string } }
  | { kind: "block"; blockId: string }
  | { kind: "key"; name: string };

export interface LinkedRow {
  block_id: string;
  page_id: string;
  content: string;
  updated_at: number;
  /** 1 when the block's OWN refs name the target, 0 when it is listed only through an ancestor or
   * its page (Logseq counts the former, docs/progress/refs-count.md). */
  direct: number;
}

export interface MentionRow {
  block_id: string;
  page_id: string;
  content: string;
}

export interface BacklinkRows {
  /** Every linked reference, most recently updated first. */
  linked: LinkedRow[];
  /** Up to `unlinkedLimit + 1` mentions: one more than asked for, so a caller can say whether it
   * stopped short (B-253). Empty unless asked for. */
  unlinked: MentionRow[];
  /** Pages carrying the target as a page-level tag (ADR 017); none for a block. */
  tagged: TaggedPageRow[];
}

export function backlinkRows(
  driver: SqlDriver,
  target: BacklinksTarget,
  opts: { includeUnlinked: boolean; unlinkedLimit: number },
): BacklinkRows {
  if (target.kind === "page") {
    const page = target.page;
    // The page's own key plus its aliases (sql-schema.md rule 13): `[[Nick]]` is a link to
    // `Real` when `Real` lists `alias:: Nick`.
    const keys = pageLookupKeys(driver, page);
    const keyList = keys.map(() => "?").join(",");
    // `direct`: the block's OWN refs name the page (or an alias), as opposed to it being in
    // `path_ref` only through an ancestor or its page. Logseq's heading counts these
    // (`reference.cljs` `top-level-blocks`, docs/progress/refs-count.md); the list keeps the rest.
    const linked = driver.all<LinkedRow>(
      `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at,
              EXISTS (SELECT 1 FROM ref r WHERE r.src_block_id = b.id AND r.dst_page_key IN (${keyList})) AS direct
       FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
       WHERE pr.page_key IN (${keyList}) AND b.page_id != ?
       ORDER BY b.updated_at DESC`,
      [...keys, ...keys, page.id],
    );
    return {
      linked,
      unlinked: opts.includeUnlinked
        ? unlinkedMentionRows(driver, page, opts.unlinkedLimit + 1)
        : [],
      tagged: pagesTaggedWith(driver, keys, page.id),
    };
  }
  if (target.kind === "block") {
    const linked = driver.all<LinkedRow>(
      `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at, 1 AS direct
       FROM ref r JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
       WHERE r.kind = 'block' AND r.dst_block_id = ?
       ORDER BY b.updated_at DESC`,
      [target.blockId],
    );
    return { linked, unlinked: [], tagged: [] };
  }
  // A page that is REFERENCED but not created yet is a normal, addressable thing in a wiki:
  // `[[Lisbon]]` makes that page meaningful the moment you write the link, and opening it
  // should show what points at it. Refs are stored against `page_key`, so this needs no page row.
  // Keyed the way refs are indexed (`refKeyOf`, ADR 018): a journal day named by any title format
  // collapses to its ISO key (B-322).
  const key = refKeyOf(target.name);
  const linked = driver.all<LinkedRow>(
    `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at,
            EXISTS (SELECT 1 FROM ref r WHERE r.src_block_id = b.id AND r.dst_page_key = ?) AS direct
     FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
     WHERE pr.page_key = ?
     ORDER BY b.updated_at DESC`,
    [key, key],
  );
  // `Journal` usually has no page of its own, yet every journal day carries it: a tag that only
  // exists as an index key must still list its pages (B-111).
  const tagged = pagesTaggedWith(driver, [key], null);
  let unlinked: MentionRow[] = [];
  if (opts.includeUnlinked) {
    const plainName = target.name.split("/").pop() ?? target.name;
    if (plainName.length >= 3) {
      unlinked = driver.all<MentionRow>(
        `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
         FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
         WHERE block_fts MATCH ? AND b.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key = ?)
         LIMIT ?`,
        [ftsPhrase(plainName), key, opts.unlinkedLimit + 1],
      );
    }
  }
  return { linked, unlinked, tagged };
}

/**
 * Unlinked mentions of a page (PLAN §4: "full-text hits for the page name in blocks that do not
 * already reference P"): blocks on OTHER pages whose text contains the page's short name as a
 * phrase and whose path refs do not already reach the page by its key or any alias. Names shorter
 * than three characters produce nothing: a two-letter phrase matches half the graph and none of it
 * is a mention.
 */
export function unlinkedMentionRows(
  driver: SqlDriver,
  page: { id: string; name: string; key: string },
  limit: number,
): MentionRow[] {
  const plainName = page.name.split("/").pop() ?? page.name;
  if (plainName.length < 3) return [];
  const keys = pageLookupKeys(driver, page);
  return driver.all<MentionRow>(
    `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
     FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
     WHERE block_fts MATCH ? AND b.deleted_at IS NULL AND b.page_id != ?
       AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key IN (${keys.map(() => "?").join(",")}))
     LIMIT ?`,
    [ftsPhrase(plainName), page.id, ...keys, limit],
  );
}

/**
 * Resolve a backlinks target the way the server's `page.backlinks` does (`resolvePageRef` without
 * creating, then a block id, then an unknown name), for a host with only a `SqlDriver` — a client
 * replica. Order, as there: an ISO date or today/yesterday/tomorrow is a journal day; an id is an
 * id; a name (or alias) is a name; only then a name in another journal title format is that day.
 */
export function resolveBacklinksTarget(
  driver: SqlDriver,
  ref: string,
  now: Date = new Date(),
): BacklinksTarget {
  const day = journalDayOfWire(ref, now);
  if (day !== null) {
    const page = journalPage(driver, day);
    // The server answers an empty list for a day with no page (B-591's "missing journal");
    // as a key it is exactly that, and still lists blocks linking the day.
    return page ? { kind: "page", page } : { kind: "key", name: isoJournalName(day) };
  }
  if (isId(ref)) {
    const byId = driver.get<{ id: string; key: string; name: string }>(
      "SELECT id, key, name FROM page WHERE id = ?",
      [ref],
    );
    if (byId) return { kind: "page", page: byId };
  }
  const byNameId = resolvePageIdForKey(driver, normalizePageName(ref));
  if (byNameId) {
    const page = driver.get<{ id: string; key: string; name: string }>(
      "SELECT id, key, name FROM page WHERE id = ?",
      [byNameId],
    );
    if (page) return { kind: "page", page };
  }
  const titled = parseJournalTitle(ref);
  if (titled !== null) {
    const page = journalPage(driver, titled);
    if (page) return { kind: "page", page };
  }
  if (driver.get("SELECT 1 FROM block WHERE id = ?", [ref])) return { kind: "block", blockId: ref };
  return { kind: "key", name: ref };
}

function journalPage(
  driver: SqlDriver,
  day: number,
): { id: string; key: string; name: string } | undefined {
  return driver.get<{ id: string; key: string; name: string }>(
    "SELECT id, key, name FROM page WHERE journal_day = ? AND deleted_at IS NULL",
    [day],
  );
}

/** `today`/`yesterday`/`tomorrow` or a real `YYYY-MM-DD`, as a journal day; else null. The
 * server's `journalDayFromWire`, which is not in core because the server also needs its errors. */
function journalDayOfWire(ref: string, now: Date): number | null {
  const lower = ref.trim().toLowerCase();
  const shifted = (days: number): number => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return todayJournalDay(d);
  };
  if (lower === "today") return shifted(0);
  if (lower === "yesterday") return shifted(-1);
  if (lower === "tomorrow") return shifted(1);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ref.trim());
  if (!m) return null;
  const day = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  return isValidJournalDay(day) ? day : null;
}

/** A page's wire name (sql-schema.md rule 18): a journal's ISO date, never its display title. */
export function wirePageNameById(driver: SqlDriver, pageId: string): string {
  const row = driver.get<{ name: string; journal_day: number | null }>(
    "SELECT name, journal_day FROM page WHERE id = ?",
    [pageId],
  );
  if (!row) return pageId;
  return row.journal_day !== null ? isoJournalName(row.journal_day) : row.name;
}
