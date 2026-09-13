/**
 * THE reactive data seam (task item 6): the API the views/editor/command agents build against.
 * Nobody outside `apps/web/src/db/` and `apps/web/src/data/` should import `../db/client.ts`
 * directly — everything a Solid component needs to read or write the local replica is one of the
 * functions below.
 *
 * Invalidation model (kept deliberately simple, per the task brief): the worker fires one
 * `ChangeEvent { tables, pageIds }` per write (local, pulled, corrected, or bootstrapped — see
 * `../db/worker-core.ts`). This module keeps one Solid signal per "table" and one per
 * "table:pageId", and bumps whichever ones a `ChangeEvent` names. A resource created by
 * `usePageTree`/`useJournalStream` reads (and thus subscribes to) exactly the signals its data
 * could be affected by, so it refetches automatically on the next change and never on an
 * unrelated one (e.g. editing page A does not refetch page B's tree).
 *
 * Everything here is async (it crosses the worker boundary) — use Solid's `createResource`
 * ergonomics (`.loading`, `.error`, `resource()` for the current value) exactly as you would for
 * any other async data source.
 */

import {
  type ApplyOpsResult,
  makeOp,
  normalizePageName,
  type Op,
  type OpPayload,
  type PageRow,
  parseJournalTitle,
} from "@nooklet/core";
import {
  type Accessor,
  createResource,
  createSignal,
  getOwner,
  type InitializedResource,
  onCleanup,
  type Resource,
} from "solid-js";
import {
  getSyncStatus,
  onChange,
  onSyncStatus,
  queryAs,
  applyOps as workerApplyOps,
  getDeviceId as workerGetDeviceId,
  getJournalStream as workerGetJournalStream,
  getPageTree as workerGetPageTree,
  nextHlc as workerNextHlc,
} from "../db/client.js";
import type { ChangedTable } from "../db/worker-api.js";
import type { Clock } from "../editor/types.js";
import type { SyncStatus } from "../sync/types.js";
import {
  apiClient,
  type BacklinksResult,
  type GraphLinksInput,
  type GraphLinksResult,
  type SearchInput,
  type SearchResult,
} from "./api-client.js";
import { invalidateBlockRefs } from "./block-ref-cache.js";
import { type AliasCandidate, findPageByAlias } from "./page-alias.js";
import type { JournalDayEntry, JournalStreamOptions, PageTreeResult, TaskRow } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Invalidation bus
// ---------------------------------------------------------------------------------------------

type VersionSignal = ReturnType<typeof createSignal<number>>;
const tableVersions = new Map<string, VersionSignal>();
const pageVersions = new Map<string, VersionSignal>();

function versionSignal(map: Map<string, VersionSignal>, key: string): VersionSignal {
  let sig = map.get(key);
  if (!sig) {
    sig = createSignal(0);
    map.set(key, sig);
  }
  return sig;
}

/**
 * Wraps a resource's source value together with the version counters it depends on.
 *
 * Load-bearing, not cosmetic. Solid's `createResource` re-runs its fetcher only when the source
 * *value* changes. Subscribing the source to the change bus makes the source re-run, but every
 * source here then returned a stable scalar — an id, a page name, or literally `true` — so Solid
 * compared the old value to the new one, saw no difference, and never refetched. The symptom was
 * that a local edit reached SQLite and the UI kept rendering the previous query result until a
 * full page reload: text typed into a bullet vanished on blur, and a freshly created journal day
 * rendered an empty outline even though the block existed.
 *
 * Returning a fresh object makes "something changed" observable to Solid, while reading the
 * version signals here is what subscribes the source in the first place.
 */
/** Bumped when the push queue drains — the moment the server catches up with local writes. */
const [syncVersion, setSyncVersion] = createSignal(0);
function bumpSync(): void {
  setSyncVersion((v) => v + 1);
}

function stamped<T>(
  value: T,
  tables: readonly ChangedTable[],
  pageId?: string,
): { value: T; version: number } {
  let version = 0;
  for (const table of tables) version += versionSignal(tableVersions, table)[0]();
  if (pageId !== undefined) version += versionSignal(pageVersions, pageId)[0]();
  return { value, version };
}

function bumpTable(table: ChangedTable): void {
  versionSignal(tableVersions, table)[1]((v) => v + 1);
}

function bumpPage(pageId: string): void {
  versionSignal(pageVersions, pageId)[1]((v) => v + 1);
}

let wired = false;
function ensureWired(): void {
  if (wired) return;
  wired = true;
  onChange((e) => {
    for (const table of e.tables) bumpTable(table);
    for (const pageId of e.pageIds) bumpPage(pageId);
    // A block's text is cached wherever it is referenced; drop it so `((id))` re-renders rather
    // than showing what the block used to say.
    if (e.tables.includes("block")) invalidateBlockRefs();
  });
}

// ---------------------------------------------------------------------------------------------
// "Give me this page's block tree"
// ---------------------------------------------------------------------------------------------

export function usePageTree(
  pageId: Accessor<string | undefined>,
): Resource<PageTreeResult | undefined> {
  ensureWired();
  const [resource] = createResource(
    () => {
      const id = pageId();
      if (!id) return undefined;
      return stamped(id, ["block", "block_prop"], id);
    },
    ({ value: id }) => workerGetPageTree(id),
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// "Give me the journal stream"
// ---------------------------------------------------------------------------------------------

export function useJournalStream(
  opts: Accessor<JournalStreamOptions>,
): Resource<JournalDayEntry[] | undefined> {
  ensureWired();
  const [resource] = createResource(
    () => {
      return stamped(opts(), ["page", "block", "block_prop"]);
    },
    ({ value: o }) => workerGetJournalStream(o),
  );
  return resource;
}

/** One specific day, real content if a page already exists for it, virtual (`page: null`)
 * otherwise — regardless of `useJournalStream`'s `maxDays` window. Backs the journal calendar
 * (`views/Calendar.tsx`): PLAN.md §8's "a calendar opens any day as a virtual page" needs to reach
 * a day that may be well outside (or, for a future date, ahead of) the normal scroll window. */
export function usePinnedJournalDay(
  day: Accessor<number | undefined>,
): Resource<JournalDayEntry | undefined> {
  ensureWired();
  const [resource] = createResource(
    () => {
      const d = day();
      if (d === undefined) return undefined;
      return stamped(d, ["page", "block", "block_prop"]);
    },
    async ({ value: d }) => {
      const rows = await queryAs<PageSqlRow>(
        "SELECT * FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
        [d],
      );
      const page = rows[0] ? toPageRow(rows[0]) : null;
      if (!page) return { day: d, page: null, blocks: [] };
      const tree = await workerGetPageTree(page.id);
      return { day: d, page, blocks: tree?.blocks ?? [] };
    },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// "Apply these ops"
// ---------------------------------------------------------------------------------------------

export function applyOps(ops: Op[]): Promise<ApplyOpsResult> {
  return workerApplyOps(ops);
}

// ---------------------------------------------------------------------------------------------
// Sync status (for a status indicator; not required reading for the views/editor agents)
// ---------------------------------------------------------------------------------------------

export function useSyncStatus(): Accessor<SyncStatus | undefined> {
  const [status, setStatus] = createSignal<SyncStatus | undefined>(undefined);
  void getSyncStatus().then(setStatus);
  const unsubscribe = onSyncStatus((s) => {
    // A push landing is a change the SERVER can now see. Server-computed views (backlinks) that
    // were fetched while a local write was still queued must ask again once it is there — or a
    // tag page created straight after typing the tag showed no reference until a reload (B-83).
    const prev = status();
    if (prev && prev.pendingCount > 0 && s.pendingCount === 0) bumpSync();
    setStatus(s);
  });
  // Every caller subscribes separately (the shell's indicator, the diagnostics panel), so a
  // panel that closes must let go of its subscription.
  if (getOwner()) onCleanup(unsubscribe);
  return status;
}

// ---------------------------------------------------------------------------------------------
// Additions below this line (views milestone). Everything above is the seam as handed off;
// everything below follows the same "one use* function per kind of read, one signal-tracked
// createResource" pattern, added because the views (journal stream / page / search / tasks) need
// reads the original seam did not yet expose. See apps/web/README.md's invalidation model.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Building and applying a single op from a view (page rename, task checkbox toggle, materializing
// a virtual journal day on first write).
//
// Every HLC comes from the worker's ONE `SyncClient` clock, via `db/client.ts`'s `nextHlc()`.
// This is not incidental: an op's id IS its HLC, and `applyOps` treats an id it has already seen
// as already-applied. So a second clock instance carrying this same device id — one per tab, or a
// fresh unseeded one after a reload — can mint an id twice and make the second write vanish
// silently. There must be exactly one clock per device, it must persist `hlc_last` on every mint,
// and everything that builds an op must go through it.
// ---------------------------------------------------------------------------------------------

let deviceIdPromise: Promise<string> | undefined;
function getLocalDeviceId(): Promise<string> {
  if (!deviceIdPromise) deviceIdPromise = workerGetDeviceId();
  return deviceIdPromise;
}

/** Build one op (fresh hlc + this device's id) and apply it via the normal `applyOps` path. Use
 * this from view code instead of hand-assembling `Op` objects. */
export async function applyOp(entity: string, payload: OpPayload): Promise<ApplyOpsResult> {
  const [hlc, device] = await Promise.all([workerNextHlc(), getLocalDeviceId()]);
  return applyOps([makeOp(hlc, device, entity, payload)]);
}

/** A `Clock` (`../editor/types.js`) over the worker's clock, so view code can reuse the editor's
 * pure op builders (`../editor/task.ts`'s `toggleDone`/`cycleMarker`/`completeTask`) and go
 * through exactly the same op path as the editor's own marker pill.
 *
 * `Clock.next` is synchronous by design (the editor's builders are pure and synchronous), but the
 * real clock lives behind an async worker boundary, so this pre-fetches a small pool of HLCs and
 * hands them out synchronously. Minting a few extra that go unused is harmless — HLCs are
 * monotonic, not gapless — whereas minting from a second local clock is NOT: an op's id is its
 * HLC, so two clocks on one device can produce the same id twice and `applyOps` would silently
 * treat the second write as already applied.
 */
export async function getOpClock(poolSize = 16): Promise<Clock> {
  const device = await getLocalDeviceId();
  const pool = await Promise.all(Array.from({ length: poolSize }, () => workerNextHlc()));
  pool.sort();
  let i = 0;
  return {
    next: () => {
      const hlc = pool[i++];
      if (hlc === undefined) {
        throw new Error(
          `getOpClock: exhausted its pool of ${poolSize} HLCs; request a larger pool for this batch`,
        );
      }
      return hlc;
    },
    device,
  };
}

// ---------------------------------------------------------------------------------------------
// "Give me this page's id by name" (PageRoute/:name resolution, PLAN.md §8/ADR 004:
// case-insensitive identity via normalizePageName)
// ---------------------------------------------------------------------------------------------

interface PageSqlRow {
  id: string;
  graph_id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  name_hlc: string;
  deleted_hlc: string | null;
}

function toPageRow(r: PageSqlRow): PageRow {
  return {
    id: r.id,
    graphId: r.graph_id,
    name: r.name,
    key: r.key,
    journalDay: r.journal_day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    nameHlc: r.name_hlc,
    deletedHlc: r.deleted_hlc,
  };
}

/** Resolve a page name to its row, case/whitespace-insensitively (`normalizePageName`). `null`
 * means "no such page" (distinct from `undefined` = still loading / no name given yet). */
export function usePageByName(
  name: Accessor<string | undefined>,
): Resource<PageRow | null | undefined> {
  ensureWired();
  const [resource] = createResource(
    () => {
      const n = name();
      if (n === undefined) return undefined;
      // `page_prop` too: an alias added or removed changes what this name resolves to (B-104).
      return stamped(n, ["page", "page_prop"]);
    },
    async ({ value: n }, { value: previous }): Promise<PageRow | null> => {
      // The same object back when nothing about the row changed (B-201). Every refetch built a
      // fresh row, and a resource whose value is a new object notifies every reader — so a page
      // created or renamed ANYWHERE re-ran `PageView`'s title-draft effect and threw away a title
      // being typed. Same fields, same reference, no notification.
      const row = await findPageRowByName(n);
      return row && previous && samePageRow(row, previous) ? previous : row;
    },
  );
  return resource;
}

async function findPageRowByName(n: string): Promise<PageRow | null> {
  const rows = await queryAs<PageSqlRow>(
    "SELECT * FROM page WHERE key = ? AND deleted_at IS NULL LIMIT 1",
    [normalizePageName(n)],
  );
  if (rows[0]) return toPageRow(rows[0]);

  // A journal day can be addressed by ANY of its title formats, while the page itself is
  // stored under whichever format the graph was written with — "Mon, 07.09.2026" in a Logseq
  // graph using that pattern. Search results and block references both hand out the ISO date
  // (`journal_date`), so a name lookup alone reported "This page doesn't exist yet" for a
  // journal that plainly did exist. Resolve through the day number, which is format-agnostic.
  const day = parseJournalTitle(n);
  if (day !== null) {
    const byDay = await queryAs<PageSqlRow>(
      "SELECT * FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
      [day],
    );
    if (byDay[0]) return toPageRow(byDay[0]);
  }
  // Last: a page that lists this name as an `alias::` (B-104; `./page-alias.ts`).
  const aliased = await findPageByAlias<PageSqlRow & AliasCandidate>(n);
  if (aliased) return toPageRow(aliased);
  return null;
}

function samePageRow(a: PageRow, b: PageRow): boolean {
  return (Object.keys(a) as Array<keyof PageRow>).every((k) => a[k] === b[k]);
}

/** Every live page, journals included — the page switcher (`views/PageFinder.tsx`) fuzzy-matches
 * over this in memory rather than one query per keystroke. Journals are included deliberately
 * (unlike `page.list`'s MCP default, docs/spec/mcp-tools.md §4.3.2): `nav.switchPage`
 * (docs/spec/commands-and-keymap.md R41) is documented as the fast path to a journal day too,
 * since journals are the primary capture surface (PLAN.md §2). */
export function useAllPages(): InitializedResource<PageRow[]> {
  ensureWired();
  const [resource] = createResource(
    () => {
      return stamped(true, ["page"]);
    },
    async () => {
      const rows = await queryAs<PageSqlRow>(
        "SELECT * FROM page WHERE deleted_at IS NULL ORDER BY name",
      );
      return rows.map(toPageRow);
    },
    { initialValue: [] },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// "Give me this page's properties" (page properties panel, PLAN.md §8)
// ---------------------------------------------------------------------------------------------

export function usePageProperties(
  pageId: Accessor<string | undefined>,
): InitializedResource<Record<string, string>> {
  ensureWired();
  const [resource] = createResource(
    () => {
      const id = pageId();
      if (!id) return undefined;
      return stamped(id, ["page_prop"], id);
    },
    async ({ value: id }) => {
      const rows = await queryAs<{ key: string; value: string | null }>(
        "SELECT key, value FROM page_prop WHERE page_id = ? ORDER BY key",
        [id],
      );
      const props: Record<string, string> = {};
      for (const r of rows) if (r.value !== null) props[r.key] = r.value;
      return props;
    },
    { initialValue: {} },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// "Give me this page's open tasks" and "give me the whole graph's open tasks" (Tasks view,
// PLAN.md §8, docs/spec/sql-schema.md rule 9's query verbatim). Fully local: marker/scheduled/
// deadline/due_day are shared-schema block columns, no server round trip needed.
// ---------------------------------------------------------------------------------------------

interface TaskSqlRow {
  id: string;
  graph_id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  due_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  place_hlc: string;
  content_hlc: string;
  marker_hlc: string | null;
  priority_hlc: string | null;
  collapsed_hlc: string | null;
  scheduled_hlc: string | null;
  deadline_hlc: string | null;
  repeat_hlc: string | null;
  done_hlc: string | null;
  deleted_hlc: string | null;
  page_name: string;
  page_journal_day: number | null;
}

function toTaskRow(r: TaskSqlRow): TaskRow {
  return {
    id: r.id,
    graphId: r.graph_id,
    pageId: r.page_id,
    parentId: r.parent_id,
    order: r.order_key,
    content: r.content,
    marker: r.marker as TaskRow["marker"],
    priority: r.priority as TaskRow["priority"],
    collapsed: r.collapsed !== 0,
    scheduledDay: r.scheduled_day,
    scheduledTime: r.scheduled_time,
    deadlineDay: r.deadline_day,
    deadlineTime: r.deadline_time,
    repeat: r.repeat,
    doneAt: r.done_at,
    dueDay: r.due_day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    placeHlc: r.place_hlc,
    contentHlc: r.content_hlc,
    markerHlc: r.marker_hlc,
    priorityHlc: r.priority_hlc,
    collapsedHlc: r.collapsed_hlc,
    scheduledHlc: r.scheduled_hlc,
    deadlineHlc: r.deadline_hlc,
    repeatHlc: r.repeat_hlc,
    doneHlc: r.done_hlc,
    deletedHlc: r.deleted_hlc,
    pageName: r.page_name,
    pageJournalDay: r.page_journal_day,
  };
}

const OPEN_MARKERS = ["TODO", "DOING", "LATER", "NOW", "WAITING"] as const;

/** All open tasks across the graph (docs/spec/sql-schema.md rule 9's query, joined to `page` for
 * display/grouping). Filtering/sorting by state/tag/window happens client-side in
 * `views/taskFilters.ts` — this just hands over every open task once, reactively. */
/**
 * Pages marked as favourites, name-sorted.
 *
 * Stored as a page property rather than in `localStorage`, so the list syncs to every device and
 * an agent can see and set it like any other property — a favourite is a fact about the graph,
 * not about this browser.
 */
export function useFavoritePages(): InitializedResource<PageRow[]> {
  ensureWired();
  const [resource] = createResource(
    () => stamped(true, ["page", "page_prop"]),
    async () => {
      const rows = await queryAs<PageSqlRow>(
        `SELECT p.* FROM page p
         JOIN page_prop pp ON pp.page_id = p.id AND pp.key = 'favorite'
         WHERE p.deleted_at IS NULL AND pp.value NOT IN ('', 'false')
         ORDER BY p.name`,
      );
      return rows.map(toPageRow);
    },
    { initialValue: [] },
  );
  return resource;
}

/** Toggle a page's favourite flag. `null` clears the property rather than storing "false", so the
 * mirror stays clean for pages that were never favourited. */
export async function setPageFavorite(pageId: string, favorite: boolean): Promise<void> {
  await applyOp(pageId, { kind: "page.prop", key: "favorite", value: favorite ? "true" : null });
}

/**
 * Every page's icon at once, keyed by page id — one query for the sidebar and All Pages rather
 * than a `usePageProperties` per row. The `icon` property is the same one Logseq writes, so an
 * imported graph's icons appear without any migration.
 */
export function usePageIcons(): InitializedResource<Map<string, string>> {
  ensureWired();
  const [resource] = createResource(
    () => stamped(true, ["page_prop"]),
    async () => {
      const rows = await queryAs<{ page_id: string; value: string }>(
        "SELECT page_id, value FROM page_prop WHERE key = 'icon' AND value IS NOT NULL AND value != ''",
      );
      return new Map(rows.map((r) => [r.page_id, r.value]));
    },
    { initialValue: new Map<string, string>() },
  );
  return resource;
}

/** `null` clears the property rather than storing an empty string, so the mirror stays clean. */
export async function setPageIcon(pageId: string, icon: string | null): Promise<void> {
  await applyOp(pageId, { kind: "page.prop", key: "icon", value: icon });
}

export function useOpenTasks(): InitializedResource<TaskRow[]> {
  ensureWired();
  const [resource] = createResource(
    () => {
      return stamped(true, ["block", "page"]);
    },
    async () => {
      const placeholders = OPEN_MARKERS.map(() => "?").join(",");
      const rows = await queryAs<TaskSqlRow>(
        `SELECT b.*, p.name AS page_name, p.journal_day AS page_journal_day
         FROM block b
         JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
         WHERE b.deleted_at IS NULL AND b.marker IN (${placeholders})
         ORDER BY b.due_day IS NULL, b.due_day, b.id`,
        [...OPEN_MARKERS],
      );
      return rows.map(toTaskRow);
    },
    { initialValue: [] },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// "Give me this namespace's child pages" (PLAN.md §8 / docs/spec/sql-schema.md rule 3's query
// verbatim — a namespace is never stored, only computed at read time from `page.key`).
// ---------------------------------------------------------------------------------------------

/** Direct and indirect children of namespace `name` ("A" matches "A/B" and "A/B/C"), live pages
 * only, name-sorted. Empty (not loading) for a page with no namespace children. */
export function useNamespaceChildren(
  name: Accessor<string | undefined>,
): InitializedResource<PageRow[]> {
  ensureWired();
  const [resource] = createResource(
    () => {
      const n = name();
      if (!n) return undefined;
      return stamped(n, ["page"]);
    },
    async ({ value: n }) => {
      const ns = normalizePageName(n);
      const rows = await queryAs<PageSqlRow>(
        `SELECT * FROM page
         WHERE deleted_at IS NULL AND journal_day IS NULL AND key != ? AND key GLOB ?
         ORDER BY name`,
        [ns, `${ns}/*`],
      );
      return rows.map(toPageRow);
    },
    { initialValue: [] },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------------
// Server-backed reads: linked/unlinked references and search. The client-only schema has no
// ref/path_ref/FTS/embedding tables (docs/spec/sql-schema.md rule 1: those are server-only
// derived tables), so these two go over HTTP to `/api/v1/*` via `./api-client.ts` instead of the
// worker/SqlDriver seam. Not wired into the table/page invalidation bus above (the server, not a
// local write, is the source of truth here); each exposes `refetch` for a manual "refresh" instead.
// ---------------------------------------------------------------------------------------------

/** Linked references (grouped by source page, most-recently-updated page first — the API already
 * returns rows in that order, views/referenceGrouping.ts does the grouping) and unlinked mentions
 * of `target` (a page name/date or a block id, docs/spec/mcp-tools.md §4.3.6). */
export function useLinkedReferences(
  target: Accessor<string | undefined>,
): [Resource<BacklinksResult | undefined>, { refetch: () => void }] {
  ensureWired();
  const [resource, { refetch }] = createResource(
    () => {
      const t = target();
      if (t === undefined) return undefined;
      // Backlinks are computed server-side, but what invalidates them is a LOCAL edit: typing
      // `[[Some Page]]` must update that page's panel without navigating away. Stamping on the
      // same version signals local writes already bump makes this refetch when the graph changes.
      // Text edits are coalesced into one op per ~500 ms pause upstream (`editor/BlockTree.tsx`),
      // so this costs roughly one request per pause rather than one per keystroke.
      // …and on `syncVersion`: a push landing means the server can see a write it could not
      // when this was last fetched (B-83).
      syncVersion();
      // …and on `page_prop`: "Pages tagged X" comes from other pages' `tags::`, and a page's
      // `alias::` decides which links count. Another device changing either arrives as a pulled
      // `page.prop` op, which bumps `page_prop` and nothing else — the list stayed stale (B-202).
      return stamped(t, ["block", "page", "page_prop"]);
    },
    ({ value: t }) => apiClient.pageBacklinks(t),
  );
  return [resource, { refetch: () => void refetch() }];
}

/** The page-to-page link graph behind `views/GraphView.tsx` (`graph.links`). Server-side for the
 * same reason as backlinks above — `ref` is a server-only derived table — and stamped on the same
 * local-write signals, so writing `[[Some Page]]` adds that edge without a reload.
 *
 * Unlike backlinks, this refetches the WHOLE graph, so it deliberately does not run per keystroke:
 * the view passes options that only change when a toggle is flipped, and text edits reach here
 * only through the coalesced one-op-per-pause path the editor already batches on. */
export function useGraphLinks(
  input: Accessor<GraphLinksInput>,
): [Resource<GraphLinksResult | undefined>, { refetch: () => void }] {
  ensureWired();
  const [resource, { refetch }] = createResource(
    () => stamped(input(), ["block", "page"]),
    ({ value: i }) => apiClient.graphLinks(i),
  );
  return [resource, { refetch: () => void refetch() }];
}

/** Full-text/semantic/hybrid search (docs/spec/mcp-tools.md §4.3.5). `undefined` query means "no
 * search yet" — kept distinct from an empty-string query, which the server would reject. */
export function useSearchResults(
  input: Accessor<SearchInput | undefined>,
): [Resource<SearchResult | undefined>, { refetch: () => void }] {
  const [resource, { refetch }] = createResource(input, (i) => apiClient.search(i));
  return [resource, { refetch: () => void refetch() }];
}

// ---------------------------------------------------------------------------------------------
// One-shot lookup (not a `use*` resource: called imperatively from a navigate handler, not read
// during render) for resolving a `NavigateTarget` of kind "block" — the promised `onNavigate`
// shape only carries a block id, but the router (`/page/:name?block=:id`, BUILD item 3) needs the
// block's page name too. Block/page are both in the client-only schema, so this stays local.
// ---------------------------------------------------------------------------------------------

/** A page's name from its id — what `nav.openPage(id)` needs to build a name-addressed route.
 * Not `resolveBlockPageName`: that takes a BLOCK id, and handing it a page id resolved nothing, so
 * picking a page in the palette silently went nowhere (B-82). */
export async function resolvePageName(pageId: string): Promise<string | undefined> {
  const rows = await queryAs<{ name: string }>(
    "SELECT name FROM page WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [pageId],
  );
  return rows[0]?.name;
}

export async function resolveBlockPageName(blockId: string): Promise<string | undefined> {
  const rows = await queryAs<{ name: string; journal_day: number | null }>(
    `SELECT p.name AS name, p.journal_day AS journal_day
     FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE b.id = ? AND b.deleted_at IS NULL
     LIMIT 1`,
    [blockId],
  );
  return rows[0]?.name;
}

// ---------------------------------------------------------------------------------------------
// The stamping idiom, for resources that live outside this file (`./queries.ts`, the ```query
// fence evaluator). `db/client.ts` fans the worker's single change listener out to any number of
// subscribers (B-130), so another module may subscribe itself; reading the version signals
// through here is still the simpler way to get the same invalidation as every view above.
// ---------------------------------------------------------------------------------------------

/** `stamped(value, tables, pageId)` for callers outside this module, wiring the bus on first use
 * the way every `use*` above does. Use as a `createResource` source. */
export function stampedFor<T>(
  value: T,
  tables: readonly ChangedTable[],
  pageId?: string,
): { value: T; version: number } {
  ensureWired();
  return stamped(value, tables, pageId);
}
