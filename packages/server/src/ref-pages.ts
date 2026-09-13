/**
 * Pages exist once referenced (ADR 024).
 *
 * A `[[Page]]`, `#tag`, `#[[multi word]]`, a reference in a property value (`tags::` and the rest,
 * not `alias::` — those name the page they sit on) and the derived `Task` tag of a marked block
 * all make their page EXIST, as a real `page` row, the way Logseq does: in the graph, in All pages,
 * in search and `page_list`, and openable as a page rather than "doesn't exist yet". A namespaced
 * name makes each ancestor exist too (`A/B/C` → `A/B`, `A`), and so does any live namespaced page.
 *
 * Only the server decides. After a `serverApplyOps` batch applies, `planReferencedPages` looks at
 * what the batch touched and mints, in the same transaction:
 *
 *  - `page.create` for every reference key that now resolves to nothing (plus ancestors), named
 *    with the casing of the text that referenced it (always a new page: see `referencePageOps`);
 *  - `page.delete` for every page this mechanism created that the batch left unreferenced and that
 *    nobody has claimed (no blocks ever, no properties, no op from anyone else) — the junk a link
 *    edited one character at a time leaves behind (`tools/probes/ref-link-typing.spec.ts`: seven
 *    intermediate names for one edit at a slow pace).
 *
 * Those ops go out as ordinary logged ops (the batch's `corrections`), so every device learns of the
 * pages by sync, and `nooklet verify` replays them like any other write. Clients never create a page
 * implicitly.
 *
 * "Created from a reference" is the op log's own fact, not a UI-visible property: these ops carry
 * the reserved device id `REFERENCE_DEVICE_ID`. A page is *unclaimed* while every applied op on it
 * came from that device and it has no block rows (tombstones included — a page whose blocks sit in
 * the trash is not junk) and no properties. Real device ids are hex (`newDeviceId`), so no device
 * can ever produce this one.
 *
 * Journal days are deliberately NOT created from date references: the journal stream lists every
 * journal page, so each `[[2026-12-24]]` would put an empty day in it (probe case 5). A date link
 * already opens the day as a virtual page.
 */

import type { Op, OpPayload, SqlDriver } from "@nooklet/core";
import {
  canonicalRefName,
  extractRefs,
  namespaceAncestors,
  newId,
  normalizePageName,
  parseJournalTitle,
  splitList,
  TASK_TAG,
} from "@nooklet/core";
import { resolvePageIdForKey } from "./page-aliases.js";
import type { BlockChangeSnapshot, PageChangeSnapshot } from "./rows.js";

/** Reserved device id stamped on every op this module authors. Not hex, so never a real device;
 * distinct from `SERVER_DEVICE_ID` (corrections) and `IMPORTER_DEVICE_ID`. */
export const REFERENCE_DEVICE_ID = "refpages";

/** The key a reference is indexed under — the same folding `apply-ops.ts#normalizeKey` applies. */
export function referenceKey(name: string): string {
  return normalizePageName(canonicalRefName(name));
}

/** A name that must never get a page from a reference: empty, or a journal day (see header). */
function isMintableName(name: string): boolean {
  return name.trim() !== "" && parseJournalTitle(name) === null;
}

/** Strips the `[[…]]` or `#` a `tags::` item may be written with (`page-tags.ts` does the same). */
function bareTagName(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("[[") && t.endsWith("]]")) return t.slice(2, -2).trim();
  if (t.startsWith("#")) return t.slice(1).trim();
  return t;
}

/**
 * The names block `blockId` references that make a page exist, as written, in text order: page
 * links and tags from its content and from every property value except `alias::`, then `Task` when
 * it carries a marker. Empty for a block that does not exist.
 */
export function pageNamesReferencedByBlock(driver: SqlDriver, blockId: string): string[] {
  const block = driver.get<{ content: string; marker: string | null }>(
    "SELECT content, marker FROM block WHERE id = ?",
    [blockId],
  );
  if (!block) return [];
  const properties: Record<string, string> = {};
  for (const p of driver.all<{ key: string; value: string }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL AND key != 'alias'",
    [blockId],
  )) {
    properties[p.key] = p.value;
  }
  const refs = extractRefs(block.content, properties);
  const names = [...refs.pageRefs, ...refs.tags];
  if (block.marker) names.push(TASK_TAG);
  return names;
}

/** The names a page's `tags::` property references, as written. */
function pageTagNames(driver: SqlDriver, pageId: string): string[] {
  const prop = driver.get<{ value: string | null }>(
    "SELECT value FROM page_prop WHERE page_id = ? AND key = 'tags'",
    [pageId],
  );
  if (!prop?.value) return [];
  return splitList(prop.value)
    .map(bareTagName)
    .filter((n) => n !== "");
}

/**
 * True while something still makes the page under `key` exist: a page link or tag in a live block
 * on a live page, a `tags::` item on a live page, or a live page namespaced under it. `ref` rows of
 * tombstoned blocks and of blocks on deleted pages are kept by the index, so both joins matter.
 * `ignorePageIds` are pages this plan is about to delete, which no longer count as descendants.
 */
export function isKeyStillReferenced(
  driver: SqlDriver,
  key: string,
  ignorePageIds: ReadonlySet<string> = new Set(),
): boolean {
  const fromBlock = driver.get(
    `SELECT 1 FROM ref r
       JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
       JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE r.dst_page_key = ? AND r.kind IN ('page', 'tag') LIMIT 1`,
    [key],
  );
  if (fromBlock) return true;
  const fromPageTag = driver.get(
    `SELECT 1 FROM page_tag pt JOIN page p ON p.id = pt.page_id AND p.deleted_at IS NULL
     WHERE pt.tag_key = ? AND pt.source = 'property' LIMIT 1`,
    [key],
  );
  if (fromPageTag) return true;
  // `key > 'a/' AND key < 'a0'` is "starts with a/" as an index range ('0' follows '/'), with no
  // LIKE wildcards to escape in a name that contains `%` or `_`.
  const children = driver.all<{ id: string }>(
    "SELECT id FROM page WHERE deleted_at IS NULL AND key > ? AND key < ?",
    [`${key}/`, `${key}0`],
  );
  return children.some((c) => !ignorePageIds.has(c.id));
}

/**
 * A page this module created that nobody has claimed since: it was minted by
 * `REFERENCE_DEVICE_ID`, no other device has renamed it or set a property on it, it has never had a
 * block, and it has no properties. Such a page is deleted when its last reference goes, is hidden
 * from the trash, and gives way to a page someone creates or restores under its name.
 *
 * Deleting does not claim. Deleting a page that is still referenced cannot make it go away (the
 * name keeps a page — this module brings it straight back), and `batch.undo` of the write that
 * minted a page deletes it with the server's own device id; counting either as a claim put an
 * empty, never-typed-into page in the trash.
 */
export function isUnclaimedReferencePage(driver: SqlDriver, pageId: string): boolean {
  // The op log first: indexed by entity, and false for almost every page, which ends it there.
  const minted = driver.get(
    "SELECT 1 FROM op WHERE entity = ? AND kind = 'page.create' AND status = 'applied' AND device_id = ?",
    [pageId, REFERENCE_DEVICE_ID],
  );
  if (!minted) return false;
  const claimed = driver.get(
    `SELECT 1 FROM op WHERE entity = ? AND status = 'applied' AND device_id != ?
       AND kind != 'page.delete' LIMIT 1`,
    [pageId, REFERENCE_DEVICE_ID],
  );
  if (claimed) return false;
  if (driver.get("SELECT 1 FROM block WHERE page_id = ? LIMIT 1", [pageId])) return false;
  return !driver.get("SELECT 1 FROM page_prop WHERE page_id = ? AND value IS NOT NULL LIMIT 1", [
    pageId,
  ]);
}

/**
 * SQL condition, over a `page` row named `page`, true for a deleted page the trash must not list:
 * one this module deleted (it only ever deletes unclaimed pages), or one it created that nobody
 * claimed and someone else deleted (`batch.undo` of the write that referenced it). Such a page never
 * held anything to restore. The op lookups are indexed by entity; the block scan is reached only
 * for the second, rare kind. Bind `REFERENCE_DEVICE_ID` for each of the three `?`.
 */
export const HIDDEN_FROM_TRASH_SQL = `(
  EXISTS (SELECT 1 FROM op o WHERE o.entity = page.id AND o.kind = 'page.delete'
            AND o.status = 'applied' AND o.hlc = page.deleted_hlc AND o.device_id = ?)
  OR (
    EXISTS (SELECT 1 FROM op o WHERE o.entity = page.id AND o.kind = 'page.create'
              AND o.status = 'applied' AND o.device_id = ?)
    AND NOT EXISTS (SELECT 1 FROM op o WHERE o.entity = page.id AND o.status = 'applied'
              AND o.device_id != ? AND o.kind != 'page.delete')
    AND NOT EXISTS (SELECT 1 FROM block b WHERE b.page_id = page.id)
    AND NOT EXISTS (SELECT 1 FROM page_prop pp WHERE pp.page_id = page.id AND pp.value IS NOT NULL)
  )
)`;

/** The live, unclaimed reference page holding `key`, if any — what a create or a restore under
 * that name may take over (`page.create`) or push aside (`trash.restore`). */
export function unclaimedReferencePageForKey(driver: SqlDriver, key: string): string | null {
  const row = driver.get<{ id: string }>(
    "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL AND journal_day IS NULL",
    [key],
  );
  return row && isUnclaimedReferencePage(driver, row.id) ? row.id : null;
}

type Snapshot = PageChangeSnapshot | BlockChangeSnapshot | null;
type Mint = (entity: string, payload: OpPayload) => Op;

/**
 * Every key the entities `ops` touch referenced or answered to BEFORE the batch — the candidates for
 * losing their last reference. Must run before `ref`/`page_tag` are re-indexed (the state tables
 * have already changed by then; the derived ones have not), with `before` holding the pre-batch
 * page snapshots for old names.
 */
export function referenceKeysBefore(
  driver: SqlDriver,
  ops: readonly Op[],
  before: ReadonlyMap<string, Snapshot>,
): Set<string> {
  const keys = new Set<string>();
  const add = (k: string | null | undefined) => {
    if (k) keys.add(k);
  };
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.entity)) continue;
    seen.add(op.entity);
    if (op.payload.kind.startsWith("block.")) {
      for (const r of driver.all<{ k: string }>(
        "SELECT DISTINCT dst_page_key AS k FROM ref WHERE src_block_id = ? AND kind IN ('page', 'tag') AND dst_page_key IS NOT NULL",
        [op.entity],
      )) {
        add(r.k);
      }
      continue;
    }
    for (const r of driver.all<{ k: string }>(
      "SELECT tag_key AS k FROM page_tag WHERE page_id = ? AND source = 'property'",
      [op.entity],
    )) {
      add(r.k);
    }
    const snap = before.get(op.entity) as PageChangeSnapshot | null | undefined;
    if (!snap) continue;
    // A rename or a delete can orphan the ancestors of the name it had.
    for (const a of namespaceAncestors(snap.name)) add(referenceKey(a));
    // A deleted page takes its blocks' references with it, without an op touching them. Only then:
    // `ref` has no index on `src_page_id`, and a page op is often a property toggle on a big page.
    const now = driver.get<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM page WHERE id = ?",
      [op.entity],
    );
    if (snap.deleted_at === null && now && now.deleted_at !== null) {
      for (const r of driver.all<{ k: string }>(
        "SELECT DISTINCT dst_page_key AS k FROM ref WHERE src_page_id = ? AND kind IN ('page', 'tag') AND dst_page_key IS NOT NULL",
        [op.entity],
      )) {
        add(r.k);
      }
    }
  }
  return keys;
}

/**
 * The pages that should exist and do not, collected in the order their references are met: the
 * first spelling of a name is the one the page gets. Shared by the per-write planner below and the
 * one-time sweep (`./ref-pages-migration.ts`), so both apply one set of rules.
 */
export class WantedPages {
  /** key -> name */
  readonly byKey = new Map<string, string>();

  constructor(private readonly driver: SqlDriver) {}

  /** `name` and each namespace ancestor, when it is mintable and resolves to nothing. */
  want(name: string): void {
    const trimmed = name.trim();
    // A date written with slashes (`2026/09/10`) is a journal day, not a namespace: no `2026`.
    if (!isMintableName(trimmed)) return;
    // Ancestors first, so `A` is created before `A/B` in HLC order, as a reader would expect.
    for (const n of [trimmed, ...namespaceAncestors(trimmed)].reverse()) {
      if (!isMintableName(n)) continue;
      const key = referenceKey(n);
      if (this.byKey.has(key) || resolvePageIdForKey(this.driver, key) !== null) continue;
      this.byKey.set(key, n);
    }
  }

  /** Everything a live block references, if any of it dangles. */
  wantFromBlock(blockId: string): void {
    // Fast path: an edit whose references all resolve (nearly every edit) parses nothing.
    const dangling = this.driver.get(
      "SELECT 1 FROM ref WHERE src_block_id = ? AND dst_page_id IS NULL AND kind IN ('page', 'tag') LIMIT 1",
      [blockId],
    );
    if (!dangling) return;
    for (const name of pageNamesReferencedByBlock(this.driver, blockId)) this.want(name);
  }

  /** A live page's `tags::` items and its namespace ancestors. */
  wantFromPage(pageId: string, name: string): void {
    for (const tag of pageTagNames(this.driver, pageId)) this.want(tag);
    for (const a of namespaceAncestors(name)) this.want(a);
  }

  /** True when a wanted page would sit under `key` — which keeps an unclaimed `key` alive. */
  hasDescendantOf(key: string): boolean {
    for (const k of this.byKey.keys()) if (k.startsWith(`${key}/`)) return true;
    return false;
  }
}

/**
 * The ops that make the references of a just-applied batch consistent with ADR 024 — see the file
 * header. `ops` is everything the batch applied (corrections included), `keysBefore` is
 * `referenceKeysBefore`'s answer, and `ref`/`page_tag` must already be re-indexed. Returns `[]` for
 * the ordinary edit that neither adds nor removes a reference to a missing or unclaimed page.
 */
export function planReferencedPages(
  driver: SqlDriver,
  ops: readonly Op[],
  keysBefore: ReadonlySet<string>,
  before: ReadonlyMap<string, Snapshot>,
  mint: Mint,
): Op[] {
  const wanted = new WantedPages(driver);
  /** Unclaimed pages whose name an alias now answers for: deleted whatever references them. */
  const yielding = new Set<string>();

  const touchedBlocks = new Set<string>();
  const touchedPages = new Set<string>();
  for (const op of ops) {
    if (op.payload.kind.startsWith("block.")) touchedBlocks.add(op.entity);
    else touchedPages.add(op.entity);
  }

  for (const blockId of touchedBlocks) {
    const live = driver.get(
      `SELECT 1 FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
       WHERE b.id = ? AND b.deleted_at IS NULL`,
      [blockId],
    );
    if (live) wanted.wantFromBlock(blockId);
  }

  for (const pageId of touchedPages) {
    const page = driver.get<{ name: string; deleted_at: number | null }>(
      "SELECT name, deleted_at FROM page WHERE id = ?",
      [pageId],
    );
    const snap = before.get(pageId) as PageChangeSnapshot | null | undefined;
    if (page && page.deleted_at === null) {
      wanted.wantFromPage(pageId, page.name);
      // Restored from the trash: its blocks' references count again, though no op touched them.
      if (snap && snap.deleted_at !== null) {
        for (const b of driver.all<{ id: string }>(
          "SELECT id FROM block WHERE page_id = ? AND deleted_at IS NULL",
          [pageId],
        )) {
          wanted.wantFromBlock(b.id);
        }
      }
      // A page that now answers to an alias takes the name from an unclaimed page holding it — own
      // key outranks alias in resolution, so leaving it would keep `[[Nick]]` on the empty page.
      for (const r of driver.all<{ k: string }>(
        "SELECT alias_key AS k FROM page_alias WHERE page_id = ?",
        [pageId],
      )) {
        const holder = unclaimedReferencePageForKey(driver, r.k);
        if (holder && holder !== pageId) yielding.add(holder);
      }
    }
    // Deleted or renamed away while something still references its old name: the name keeps a
    // page, as it would if the page had never existed (ADR 024), named as the page was. Likewise
    // an alias it no longer answers to.
    if (snap && snap.deleted_at === null) {
      const oldNames = [snap.name];
      if (snap.properties.alias)
        oldNames.push(...splitList(snap.properties.alias).map(bareTagName));
      for (const oldName of oldNames) {
        if (!isMintableName(oldName)) continue;
        const oldKey = referenceKey(oldName);
        if (resolvePageIdForKey(driver, oldKey) === null && isKeyStillReferenced(driver, oldKey)) {
          wanted.want(oldName);
        }
      }
    }
  }

  // Deletions: every key the batch's entities used to reference, and — as pages are deleted —
  // their ancestors, which may have been kept only by them.
  const deleting = new Set<string>(yielding);
  const queue = [...keysBefore];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key) || wanted.byKey.has(key)) continue;
    visited.add(key);
    const holder = unclaimedReferencePageForKey(driver, key);
    if (!holder || deleting.has(holder)) continue;
    if (isKeyStillReferenced(driver, key, deleting) || wanted.hasDescendantOf(key)) continue;
    deleting.add(holder);
    const name = driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [holder])?.name;
    for (const a of namespaceAncestors(name ?? "")) queue.push(referenceKey(a));
  }

  return referencePageOps(wanted, deleting, mint);
}

/**
 * `page.create` for each wanted page, then `page.delete` for each page in `deleting`.
 *
 * Always a new page, never an unclaimed tombstone of the same name brought back. Reuse would save
 * a row per toggled link, but a replica can lack that tombstone: a device that created a page of
 * the name offline meets the old `page.create` while its own page holds the name, and its replica
 * refuses it (B-443). Reviving the tombstone later — a rename and an un-delete — would then land
 * on the server and on every device except that one.
 */
export function referencePageOps(
  wanted: WantedPages,
  deleting: ReadonlySet<string>,
  mint: Mint,
): Op[] {
  const out: Op[] = [];
  const now = Date.now();
  for (const name of wanted.byKey.values()) {
    out.push(mint(newId(), { kind: "page.create", name, journalDay: null, createdAt: now }));
  }
  for (const pageId of deleting) {
    out.push(mint(pageId, { kind: "page.delete", deletedAt: now }));
  }
  return out;
}
