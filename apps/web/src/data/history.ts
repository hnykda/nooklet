/**
 * Server-backed reads and writes behind the Trash view and a page's History view (M7 item 8,
 * ADR 022): `trash.list`, `trash.restore`, `page.history` and `batch.undo`. All four live on the
 * server because they read the `changes` audit log and the tombstones' attribution, which the
 * client replica does not carry (docs/spec/sql-schema.md rule 1) — so these go over HTTP to
 * `/api/v1/*`, the same way `./store.ts`'s backlinks and search do.
 *
 * Invalidation follows `./store.ts`'s `stamped` idiom with its own counters, because it also
 * bumps on the push queue draining (`onSyncStatus` below) where `store.ts`'s `stampedFor` does
 * not: a resource's source reads one version counter per table it depends on (bumped by the
 * worker's `ChangeEvent`, which fires for local writes and for pulled ones alike) and returns a
 * fresh object, so Solid sees "something changed" and refetches. Subscribing here is safe only
 * because `db/client.ts` fans the worker's single listener slot out — before it did, this module's
 * subscription replaced `store.ts`'s and every other view stopped refreshing (B-130). A restore or an undo is a SERVER write; it reaches this replica as a pulled
 * change moments later and bumps the same counters — plus each write here calls `refetch` on
 * completion so the view does not wait for the round trip.
 */

import { type Accessor, createResource, createSignal, type Resource } from "solid-js";
import { onChange, onSyncStatus } from "../db/client.js";
import type { ChangedTable } from "../db/worker-api.js";
import { callOp } from "./api-client.js";

// ---------------------------------------------------------------------------------------------
// Invalidation bus (see header)
// ---------------------------------------------------------------------------------------------

type VersionSignal = ReturnType<typeof createSignal<number>>;
const tableVersions = new Map<string, VersionSignal>();
const [syncVersion, setSyncVersion] = createSignal(0);
let wired = false;

function versionSignal(table: string): VersionSignal {
  let sig = tableVersions.get(table);
  if (!sig) {
    sig = createSignal(0);
    tableVersions.set(table, sig);
  }
  return sig;
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  onChange((e) => {
    for (const table of e.tables) versionSignal(table)[1]((v) => v + 1);
  });
  let pending = 0;
  onSyncStatus((s) => {
    // The push queue draining means the server now knows about a local write — a server-computed
    // view fetched before that was answered from an older graph (the B-83 shape).
    if (pending > 0 && s.pendingCount === 0) setSyncVersion((v) => v + 1);
    pending = s.pendingCount;
  });
}

function stamped<T>(value: T, tables: readonly ChangedTable[]): { value: T; version: number } {
  let version = syncVersion();
  for (const table of tables) version += versionSignal(table)[0]();
  return { value, version };
}

// ---------------------------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------------------------

export interface TrashItem {
  kind: "page" | "block";
  id: string;
  /** The page's name, or the block's first line. */
  title: string;
  /** The page this is (or is on), by wire name. */
  page: string;
  blockCount: number;
  /** ISO-8601. */
  deletedAt: string;
  deletedBy?: { origin: string; actor: string; batchId: string };
}

interface TrashWireItem {
  kind: "page" | "block";
  id: string;
  title: string;
  page: string;
  block_count: number;
  deleted_at: string;
  deleted_by?: { origin: string; actor: string; batch_id: string };
}

/** Everything in the trash, newest first — drained through the cursor, capped well above what a
 * person will scroll through. */
export async function fetchTrash(): Promise<TrashItem[]> {
  const items: TrashItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const out = await callOp<{ items: TrashWireItem[]; cursor?: string; has_more: boolean }>(
      "trash.list",
      { limit: 200, cursor },
    );
    for (const i of out.items) {
      items.push({
        kind: i.kind,
        id: i.id,
        title: i.title,
        page: i.page,
        blockCount: i.block_count,
        deletedAt: i.deleted_at,
        deletedBy: i.deleted_by
          ? {
              origin: i.deleted_by.origin,
              actor: i.deleted_by.actor,
              batchId: i.deleted_by.batch_id,
            }
          : undefined,
      });
    }
    if (!out.has_more || !out.cursor) break;
    cursor = out.cursor;
  }
  return items;
}

export interface RestoreResult {
  kind: "page" | "block";
  /** The page the restored thing is on, after the restore. */
  page: string;
  restored: string[];
  batchId?: string;
}

/** `trash.restore`. `newName` restores a page under another name — what a `conflict` (the name is
 * taken by a live page, or is another page's alias) asks for. */
export async function restoreFromTrash(id: string, newName?: string): Promise<RestoreResult> {
  const out = await callOp<{
    kind: "page" | "block";
    page: string;
    restored: string[];
    batch_id?: string;
  }>("trash.restore", newName === undefined ? { id } : { id, new_name: newName });
  return { kind: out.kind, page: out.page, restored: out.restored, batchId: out.batch_id };
}

export function useTrash(): [Resource<TrashItem[] | undefined>, { refetch: () => void }] {
  ensureWired();
  const [resource, { refetch }] = createResource(
    () => stamped(true, ["page", "block"]),
    () => fetchTrash(),
  );
  return [resource, { refetch: () => void refetch() }];
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

export type HistoryEntryKind =
  | "created"
  | "edited"
  | "moved"
  | "deleted"
  | "restored"
  | "renamed"
  | "updated";

export interface HistorySnapshot {
  content?: string;
  marker?: string | null;
  priority?: string | null;
  collapsed?: boolean;
  parentId?: string | null;
  pageId?: string;
  name?: string;
  properties?: Record<string, string>;
  deletedAt: number | null;
}

export interface HistoryEntry {
  entityType: "page" | "block";
  entityId: string;
  kind: HistoryEntryKind;
  before: HistorySnapshot | null;
  after: HistorySnapshot | null;
}

export interface HistoryBatch {
  batchId: string;
  seq: number;
  /** ISO-8601. */
  at: string;
  origin: string;
  actor: string;
  summary: string;
  entries: HistoryEntry[];
}

export interface HistoryPage {
  page: string;
  pageId: string;
  batches: HistoryBatch[];
  cursor?: string;
  hasMore: boolean;
}

interface WireSnapshot {
  content?: string;
  marker?: string | null;
  priority?: string | null;
  collapsed?: boolean;
  parent_id?: string | null;
  page_id?: string;
  name?: string;
  properties?: Record<string, string>;
  deleted_at: number | null;
}

interface WireBatch {
  batch_id: string;
  seq: number;
  at: string;
  origin: string;
  actor: string;
  summary: string;
  entries: Array<{
    entity_type: "page" | "block";
    entity_id: string;
    kind: HistoryEntryKind;
    before: WireSnapshot | null;
    after: WireSnapshot | null;
  }>;
}

function fromWireSnapshot(s: WireSnapshot | null): HistorySnapshot | null {
  if (s === null) return null;
  return {
    content: s.content,
    marker: s.marker,
    priority: s.priority,
    collapsed: s.collapsed,
    parentId: s.parent_id,
    pageId: s.page_id,
    name: s.name,
    properties: s.properties,
    deletedAt: s.deleted_at,
  };
}

export async function fetchPageHistory(page: string, cursor?: string): Promise<HistoryPage> {
  const out = await callOp<{
    page: string;
    page_id: string;
    batches: WireBatch[];
    cursor?: string;
    has_more: boolean;
  }>("page.history", { page, cursor, limit: 25 });
  return {
    page: out.page,
    pageId: out.page_id,
    cursor: out.cursor,
    hasMore: out.has_more,
    batches: out.batches.map((b) => ({
      batchId: b.batch_id,
      seq: b.seq,
      at: b.at,
      origin: b.origin,
      actor: b.actor,
      summary: b.summary,
      entries: b.entries.map((e) => ({
        entityType: e.entity_type,
        entityId: e.entity_id,
        kind: e.kind,
        before: fromWireSnapshot(e.before),
        after: fromWireSnapshot(e.after),
      })),
    })),
  };
}

/** Something an undo left as it is because another batch changed it afterwards (B-251). */
export interface KeptEdit {
  entityType: "page" | "block";
  id: string;
  /** The page it is on now. */
  page: string;
  fields: string[];
}

export interface UndoOptions {
  /** Leave alone every field another batch changed after the one being undone. The History view
   * always passes it: a person undoing an old change must not lose what was written since. */
  keepLaterEdits?: boolean;
  /** Changes by these batches do not count as later edits — a walk's own batches and undos. */
  ignoreBatches?: readonly string[];
}

/** `batch.undo` — reverses one batch; the result's `batchId` is the undo's own (undo it to redo). */
export async function undoBatch(
  batchId: string,
  options: UndoOptions = {},
): Promise<{ batchId?: string; kept: KeptEdit[] }> {
  const out = await callOp<{
    batch_id?: string;
    kept?: Array<{ entity_type: "page" | "block"; id: string; page: string; fields: string[] }>;
  }>("batch.undo", {
    batch_id: batchId,
    ...(options.keepLaterEdits ? { keep_later_edits: true } : {}),
    ...(options.ignoreBatches?.length ? { ignore_batches: [...options.ignoreBatches] } : {}),
  });
  return {
    batchId: out.batch_id,
    kept: (out.kept ?? []).map((k) => ({
      entityType: k.entity_type,
      id: k.id,
      page: k.page,
      fields: k.fields,
    })),
  };
}

export interface PageHistoryStore {
  /** The first page of batches, refetched whenever the graph changes; `undefined` while loading
   * for the first time. Calling it while `first.error` is set THROWS — read `firstPage` instead. */
  first: Resource<HistoryPage | undefined>;
  /** `first()`, or `undefined` while loading or errored; safe to read anywhere. */
  firstPage: Accessor<HistoryPage | undefined>;
  /** Every batch loaded so far, newest first (the first page plus any "older" pages). */
  batches: Accessor<HistoryBatch[]>;
  hasMore: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  loadMore: () => Promise<void>;
  refetch: () => void;
}

/**
 * A page's history with "load older" pagination. The first page is a resource stamped on the
 * graph's change counters (so a write anywhere refreshes the top of the timeline); older pages
 * are appended on demand and dropped whenever the first page reloads, since their cursor was
 * relative to a timeline that has since grown.
 */
export function usePageHistory(name: Accessor<string | undefined>): PageHistoryStore {
  ensureWired();
  const [extra, setExtra] = createSignal<HistoryBatch[]>([]);
  const [tailCursor, setTailCursor] = createSignal<string | undefined>(undefined);
  const [tailHasMore, setTailHasMore] = createSignal<boolean | undefined>(undefined);
  const [loadingMore, setLoadingMore] = createSignal(false);
  // Which first page the appended older pages belong to. Bumped whenever a first page lands and
  // the appended ones are dropped, so a `loadMore` that was already in flight can tell that its
  // page no longer lines up (B-132, below).
  let generation = 0;

  const [first, { refetch }] = createResource(
    () => {
      const n = name();
      if (n === undefined) return undefined;
      return stamped(n, ["page", "block", "block_prop", "page_prop"]);
    },
    async ({ value: n }) => {
      const page = await fetchPageHistory(n);
      // A fresh first page invalidates whatever older pages were appended under the previous one.
      generation++;
      setExtra([]);
      setTailCursor(undefined);
      setTailHasMore(undefined);
      return page;
    },
  );

  // Reading an errored resource re-throws, so an unguarded `first()` here threw inside the view's
  // render and a failed load stayed on "Loading…" (B-131). Every read of `first` goes through this.
  const firstPage = (): HistoryPage | undefined =>
    first.error !== undefined ? undefined : first();
  const batches = (): HistoryBatch[] => [...(firstPage()?.batches ?? []), ...extra()];
  const hasMore = (): boolean => tailHasMore() ?? firstPage()?.hasMore ?? false;

  async function loadMore(): Promise<void> {
    const n = name();
    const cursor = tailCursor() ?? firstPage()?.cursor;
    if (n === undefined || cursor === undefined || loadingMore()) return;
    setLoadingMore(true);
    const requestedFor = generation;
    try {
      const page = await fetchPageHistory(n, cursor);
      // The first page reloaded while this was in flight. Its cursor ("older than seq X") was taken
      // from the previous first page; appending under the new one — which ends higher, because it
      // refetched precisely because batches were added — leaves the batches in between listed
      // nowhere, and Restore this version would silently skip undoing them (B-132). Drop it; the
      // next click pages on from the new first page.
      if (requestedFor !== generation) return;
      setExtra((prev) => [...prev, ...page.batches]);
      setTailCursor(page.cursor);
      setTailHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  return {
    first,
    firstPage,
    batches,
    hasMore,
    loadingMore,
    loadMore,
    refetch: () => void refetch(),
  };
}
