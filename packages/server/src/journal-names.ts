/**
 * One-time upgrade of a graph written before ADR 018: journal pages stored under a display format
 * (`Mon, 07.09.2026` — whatever the source Logseq graph used) move to their ISO name, and the
 * derived reference indexes are re-keyed so nothing points at the old string.
 *
 * Why this is a startup task rather than a `schema.ts` migration: the renames are real
 * `page.rename` **ops**. A raw `UPDATE page SET name = …` would change live state without changing
 * the log it is supposed to be a projection of — `nooklet verify` would flag it, and no other
 * device would ever hear about it, because a client bootstraps from a state snapshot and then
 * follows the op stream. Minting ops needs an HLC and the server device id, which exist above the
 * schema layer, so this runs from `open()` in `cli.ts` instead, guarded by a `setting` row.
 *
 * The block text is deliberately NOT rewritten. `[[Mon, 07.09.2026]]` stays exactly as the person
 * typed it; `normalizeKey` (apply-ops.ts) now resolves it to the ISO key, so the reference works
 * without the words on screen changing. Rewriting 18k blocks to make the storage layer's opinion
 * visible in prose would be the wrong direction entirely.
 */

import {
  canonicalRefName,
  isoJournalName,
  isValidJournalDay,
  makeOp,
  normalizePageName,
  type Op,
  type SqlDriver,
} from "@nooklet/core";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "./apply-ops.js";
import { reresolveIndexTargets } from "./page-aliases.js";

const DONE_KEY = "journal.iso_names";

export interface JournalNameMigration {
  /** Pages given their ISO name. */
  renamed: number;
  /** Pages left alone because an unrelated page already owns the ISO name. */
  collided: string[];
  /** Distinct index keys re-pointed at the ISO name (`ref`, `path_ref` and `page_tag` combined). */
  rekeyed: number;
  /** True when the graph had already been through this (the normal case after the first run). */
  alreadyDone: boolean;
}

/**
 * Bring one graph up to ADR 018. Idempotent and cheap on a graph that is already canonical: one
 * `setting` read and nothing else.
 */
export function migrateJournalNames(ctx: ServerContext): JournalNameMigration {
  const { driver } = ctx;
  const done = driver.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = ?", [
    DONE_KEY,
  ]);
  if (done) return { renamed: 0, collided: [], rekeyed: 0, alreadyDone: true };

  const stale = driver
    .all<{ id: string; name: string; journal_day: number }>(
      "SELECT id, name, journal_day FROM page WHERE journal_day IS NOT NULL AND deleted_at IS NULL",
    )
    .filter((p) => isValidJournalDay(p.journal_day) && p.name !== isoJournalName(p.journal_day));

  const collided: string[] = [];
  const ops: Op[] = [];
  for (const page of stale) {
    const iso = isoJournalName(page.journal_day);
    // `applyPageRename` would reject this anyway; catching it here lets us report which page lost
    // rather than swallowing a "rejected" result with no name attached to it.
    const occupied = driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL AND id != ?",
      [normalizePageName(iso), page.id],
    );
    if (occupied) {
      collided.push(page.name);
      continue;
    }
    ops.push(makeOp(ctx.hlc.next(), SERVER_DEVICE_ID, page.id, { kind: "page.rename", name: iso }));
  }

  if (ops.length > 0) {
    serverApplyOps(ctx, ops, { origin: "system", actor: "migration:journal-iso-names" });
  }

  const rekeyed = driver.transaction(() => recanonicaliseIndexKeys(driver));

  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc)
     VALUES (?, 'default', ?, ?, '')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [DONE_KEY, JSON.stringify({ at: Date.now(), renamed: ops.length }), Date.now()],
  );

  return { renamed: ops.length, collided, rekeyed, alreadyDone: false };
}

/**
 * Re-key the derived indexes in place.
 *
 * Rebuilding them from block content would be simpler to read and roughly a hundred times slower
 * — `rebuildRefRows` re-parses every block, and a real graph has tens of thousands. The keys are
 * the only thing that changed, and the mapping (old key → `canonicalRefName`) is a pure function
 * of the key itself, so the indexes can be corrected without looking at the content that produced
 * them. What this does NOT cover is a key that was already canonical but unresolved because the
 * page did not exist under that name yet; the `dst_page_id IS NULL` sweeps at the end pick those
 * up, which is how an old `[[2026-09-07]]` finally finds the journal it always meant.
 */
function recanonicaliseIndexKeys(driver: SqlDriver): number {
  let rekeyed = 0;

  const refKeys = driver.all<{ k: string }>(
    "SELECT DISTINCT dst_page_key AS k FROM ref WHERE dst_page_key IS NOT NULL",
  );
  for (const { k } of refKeys) {
    const next = normalizePageName(canonicalRefName(k));
    if (next === k) continue;
    driver.run("UPDATE ref SET dst_page_key = ? WHERE dst_page_key = ?", [next, k]);
    rekeyed++;
  }

  // `path_ref` and `page_tag` are keyed on (block, key) / (page, key), so an UPDATE can collide
  // with a row that already carries the canonical key — a block that referenced a day both ways.
  // `OR IGNORE` leaves those rows behind under the old key; the DELETE then drops them, which is
  // correct precisely because the canonical row they would have become already exists.
  const pathKeys = driver.all<{ k: string }>("SELECT DISTINCT page_key AS k FROM path_ref");
  for (const { k } of pathKeys) {
    const next = normalizePageName(canonicalRefName(k));
    if (next === k) continue;
    driver.run("UPDATE OR IGNORE path_ref SET page_key = ? WHERE page_key = ?", [next, k]);
    driver.run("DELETE FROM path_ref WHERE page_key = ?", [k]);
    rekeyed++;
  }

  const tagKeys = driver.all<{ k: string }>("SELECT DISTINCT tag_key AS k FROM page_tag");
  for (const { k } of tagKeys) {
    const next = normalizePageName(canonicalRefName(k));
    if (next === k) continue;
    driver.run("UPDATE OR IGNORE page_tag SET tag_key = ? WHERE tag_key = ?", [next, k]);
    driver.run("DELETE FROM page_tag WHERE tag_key = ?", [k]);
    rekeyed++;
  }

  // Own key first, then alias (`page-aliases.ts`) — the same rule every write uses, so this one-off
  // sweep cannot un-resolve a reference that reaches its page through an `alias::`.
  reresolveIndexTargets(driver);

  return rekeyed;
}
