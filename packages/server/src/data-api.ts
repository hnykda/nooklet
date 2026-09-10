/**
 * Server-side `DataApi` (`docs/spec/api-and-plugin-types.md` §3): the isomorphic block/page/
 * query/transact facade op handlers and (eventually) plugins are written against. `@vrite/plugin-
 * api` does not exist yet in this repo (only `packages/core` and `packages/server` do), so the
 * `BlockNode`/`PropertyPatch`/`BlocksApi`/`PagesApi`/`QueryApi`/`DataApi` interfaces that spec
 * places in `packages/plugin-api/src/data.ts` are defined here instead, byte-compatible with the
 * spec's shapes; move them verbatim into `@vrite/plugin-api` once that package exists.
 *
 * Every write method goes through `serverApplyOps` (ADR 003/008: "every write is an op") — never
 * a raw INSERT/UPDATE of `page`/`block`/`block_prop`/`page_prop`. Reads query the state tables
 * directly (`ctx.db` in op handlers is the same escape hatch for cross-table queries this file
 * itself does not expose, e.g. `search`, `page.backlinks`).
 */

import {
  type Block,
  type BlockId,
  formatJournalTitle,
  makeOp,
  namespaceParent,
  newId,
  normalizePageName,
  type Op,
  type OpPayload,
  orderBetween,
  ordersBetween,
  type Page,
  type PageId,
  type Properties,
  type SqlDriver,
  todayJournalDay,
} from "@vrite/core";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "./apply-ops.js";

// ---------------------------------------------------------------------------------------------
// Shared types (api-and-plugin-types.md §3)
// ---------------------------------------------------------------------------------------------

export interface BlockNode extends Block {
  children: BlockNode[];
}

/** Server-internal superset of `BlockNode` used by ops that need to know how many children a
 * depth cutoff hid (`page.read`/`block.read`'s `child_count`, mcp-tools.md §3.2 rule 7). Every
 * `ServerBlockNode` is structurally a `BlockNode`, so `BlocksApi.tree()` can return these directly. */
export interface ServerBlockNode extends BlockNode {
  children: ServerBlockNode[];
  /** Present only when children exist beyond the requested depth. */
  childCount?: number;
}

export interface PropertyPatch {
  [key: string]: string | null;
}

export interface BlocksApi {
  get(id: BlockId): Promise<Block | null>;
  children(parent: BlockId | { page: PageId }): Promise<Block[]>;
  tree(root: BlockId | { page: PageId }, opts?: { depth?: number }): Promise<ServerBlockNode[]>;
  insert(spec: {
    content: string;
    properties?: Properties;
    page?: PageId;
    parent?: BlockId;
    after?: BlockId | "first" | "last";
  }): Promise<Block>;
  update(
    id: BlockId,
    patch: { content?: string; properties?: PropertyPatch; collapsed?: boolean },
  ): Promise<Block>;
  move(
    id: BlockId,
    to: { page?: PageId; parent?: BlockId; after?: BlockId | "first" | "last" },
  ): Promise<void>;
  delete(id: BlockId, opts?: { children?: "delete" | "lift" }): Promise<void>;
}

export interface PagesApi {
  get(ref: PageId | { name: string }): Promise<Page | null>;
  list(opts?: {
    namespace?: string;
    kind?: "page" | "journal";
    limit?: number;
    cursor?: string;
  }): Promise<{ items: Page[]; cursor?: string }>;
  create(spec: { name: string; properties?: Properties; firstBlock?: string }): Promise<Page>;
  rename(id: PageId, name: string): Promise<Page>;
  delete(id: PageId): Promise<void>;
  namespaceTree(root: string): Promise<Array<{ page: Page; children: unknown[] }>>;
  journal(date: string, opts?: { create?: boolean }): Promise<Page | null>;
}

export interface QueryApi {
  blocks(q: {
    text?: string;
    page?: PageId | { namespace: string };
    refs?: { to: PageId | BlockId };
    tags?: string[];
    property?: {
      key: string;
      value?: string;
      op?: "eq" | "neq" | "gt" | "lt" | "exists" | "contains";
    };
    updatedAfter?: number;
    limit?: number;
    cursor?: string;
    order?: "updated" | "created" | "page";
  }): Promise<{ items: Block[]; cursor?: string }>;
  linkedRefs(target: PageId | BlockId): Promise<Array<{ page: Page; blocks: Block[] }>>;
  unlinkedRefs(page: PageId): Promise<Array<{ page: Page; blocks: Block[] }>>;
  /** Embeddings ship in M3 (ADR 010); until then this always resolves to `[]`. */
  semantic(
    text: string,
    opts?: { limit?: number; page?: PageId },
  ): Promise<Array<{ block: Block; score: number }>>;
}

export interface DataApi {
  blocks: BlocksApi;
  pages: PagesApi;
  query: QueryApi;
  transact<T>(fn: (tx: DataApi) => Promise<T> | T, opts?: { label?: string }): Promise<T>;
}

export interface WriteMeta {
  origin: "user" | "api" | "mcp" | "sync" | "plugin" | "import" | "mirror" | "system";
  actor: string;
}

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

interface PageRow {
  id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface BlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: Block["marker"];
  priority: Block["priority"];
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const BLOCK_COLUMNS =
  "id, page_id, parent_id, order_key, content, marker, priority, collapsed, " +
  "scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at, " +
  "created_at, updated_at, deleted_at";

/** `YYYYMMDD` + optional `HH:MM` -> `YYYY-MM-DD` / `YYYY-MM-DD HH:MM` (ADR 011 wire format). */
export function formatDayTime(day: number, time: string | null): string {
  const s = String(day);
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return time ? `${iso} ${time}` : iso;
}

/** Epoch ms -> `YYYY-MM-DDTHH:MM:SSZ` (full ISO 8601 UTC, seconds precision, no milliseconds). */
export function formatDoneIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `YYYYMMDD` -> `YYYY-MM-DD` (rule 18: journal pages are addressed by ISO date on the wire). */
export function isoFromJournalDay(day: number): string {
  const s = String(day);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function rowToPage(driver: SqlDriver, row: PageRow): Page {
  const propRows = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM page_prop WHERE page_id = ? AND value IS NOT NULL",
    [row.id],
  );
  const properties: Properties = {};
  for (const p of propRows) if (p.value !== null) properties[p.key] = p.value;
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    journalDay: row.journal_day,
    properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function blockPropertiesOf(driver: SqlDriver, row: BlockRow): Properties {
  const propRows = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
    [row.id],
  );
  const properties: Properties = {};
  for (const p of propRows) if (p.value !== null) properties[p.key] = p.value;
  if (row.scheduled_day !== null)
    properties.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
  if (row.deadline_day !== null)
    properties.deadline = formatDayTime(row.deadline_day, row.deadline_time);
  if (row.repeat !== null) properties.repeat = row.repeat;
  if (row.done_at !== null) properties.done = formatDoneIso(row.done_at);
  return properties;
}

function rowToBlock(driver: SqlDriver, row: BlockRow): Block {
  return {
    id: row.id,
    pageId: row.page_id,
    parentId: row.parent_id,
    order: row.order_key,
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    properties: blockPropertiesOf(driver, row),
    collapsed: row.collapsed !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBlockRow(driver: SqlDriver, id: string): BlockRow | undefined {
  return driver.get<BlockRow>(
    `SELECT ${BLOCK_COLUMNS} FROM block WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

function getBlockRowAny(driver: SqlDriver, id: string): BlockRow | undefined {
  return driver.get<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM block WHERE id = ?`, [id]);
}

function getPageRow(driver: SqlDriver, id: string): PageRow | undefined {
  return driver.get<PageRow>("SELECT * FROM page WHERE id = ? AND deleted_at IS NULL", [id]);
}

// ---------------------------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------------------------

function siblingRows(driver: SqlDriver, pageId: string, parentId: string | null): BlockRow[] {
  return parentId === null
    ? driver.all<BlockRow>(
        `SELECT ${BLOCK_COLUMNS} FROM block WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY order_key`,
        [pageId],
      )
    : driver.all<BlockRow>(
        `SELECT ${BLOCK_COLUMNS} FROM block WHERE page_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY order_key`,
        [pageId, parentId],
      );
}

function orderForAfter(
  driver: SqlDriver,
  pageId: string,
  parentId: string | null,
  after: BlockId | "first" | "last",
): string {
  const siblings = siblingRows(driver, pageId, parentId);
  if (after === "first") return orderBetween(null, siblings[0]?.order_key ?? null);
  if (after === "last") return orderBetween(siblings[siblings.length - 1]?.order_key ?? null, null);
  const idx = siblings.findIndex((s) => s.id === after);
  if (idx === -1) return orderBetween(siblings[siblings.length - 1]?.order_key ?? null, null);
  return orderBetween(siblings[idx]?.order_key ?? null, siblings[idx + 1]?.order_key ?? null);
}

/** Bounds (exclusive) within which N new sibling order keys should be generated. */
export interface OrderBounds {
  pageId: string;
  parentId: string | null;
  lower: string | null;
  upper: string | null;
}

/** Resolve `ref` + a `child_first`/`child_last`/`before`/`after` position into insertion bounds. */
export function resolveInsertionBounds(
  driver: SqlDriver,
  refId: string,
  position: "child_first" | "child_last" | "before" | "after",
): OrderBounds | undefined {
  const ref = getBlockRow(driver, refId);
  if (!ref) return undefined;
  if (position === "child_first" || position === "child_last") {
    const kids = siblingRows(driver, ref.page_id, ref.id);
    return position === "child_first"
      ? { pageId: ref.page_id, parentId: ref.id, lower: null, upper: kids[0]?.order_key ?? null }
      : {
          pageId: ref.page_id,
          parentId: ref.id,
          lower: kids[kids.length - 1]?.order_key ?? null,
          upper: null,
        };
  }
  const siblings = siblingRows(driver, ref.page_id, ref.parent_id);
  const idx = siblings.findIndex((s) => s.id === refId);
  const prev = idx > 0 ? (siblings[idx - 1]?.order_key ?? null) : null;
  const next =
    idx >= 0 && idx + 1 < siblings.length ? (siblings[idx + 1]?.order_key ?? null) : null;
  return position === "before"
    ? { pageId: ref.page_id, parentId: ref.parent_id, lower: prev, upper: ref.order_key }
    : { pageId: ref.page_id, parentId: ref.parent_id, lower: ref.order_key, upper: next };
}

export function boundsForPageEnd(
  driver: SqlDriver,
  pageId: string,
  position: "start" | "end" = "end",
): OrderBounds {
  const top = siblingRows(driver, pageId, null);
  return position === "start"
    ? { pageId, parentId: null, lower: null, upper: top[0]?.order_key ?? null }
    : { pageId, parentId: null, lower: top[top.length - 1]?.order_key ?? null, upper: null };
}

export function boundsForParent(driver: SqlDriver, pageId: string, parentId: string): OrderBounds {
  const kids = siblingRows(driver, pageId, parentId);
  return { pageId, parentId, lower: kids[kids.length - 1]?.order_key ?? null, upper: null };
}

export function newOrderKeys(bounds: OrderBounds, n: number): string[] {
  return ordersBetween(bounds.lower, bounds.upper, n);
}

export function wouldCycle(driver: SqlDriver, movedId: string, newParentId: string): boolean {
  let cur: string | null = newParentId;
  let guard = 0;
  while (cur !== null && guard++ < 1000) {
    if (cur === movedId) return true;
    const parentRow: { parent_id: string | null } | undefined = driver.get(
      "SELECT parent_id FROM block WHERE id = ?",
      [cur],
    );
    cur = parentRow?.parent_id ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Tree loading (shared by BlocksApi.tree and the outline/wire serializer)
// ---------------------------------------------------------------------------------------------

export function loadBlockTree(
  driver: SqlDriver,
  parentId: string | null,
  pageId: string,
  depthRemaining: number,
): ServerBlockNode[] {
  const rows = siblingRows(driver, pageId, parentId);
  return rows.map((row) => {
    const block = rowToBlock(driver, row);
    const node: ServerBlockNode = { ...block, children: [] };
    if (depthRemaining > 0) {
      node.children = loadBlockTree(driver, row.id, pageId, depthRemaining - 1);
    } else {
      const count = driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM block WHERE parent_id = ? AND deleted_at IS NULL",
        [row.id],
      );
      if (count && count.n > 0) node.childCount = count.n;
    }
    return node;
  });
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export function createDataApi(serverCtx: ServerContext, meta: WriteMeta): DataApi {
  const { driver } = serverCtx;

  function mint(entity: string, payload: OpPayload): Op {
    const hlc = serverCtx.hlc.next();
    return makeOp(hlc, SERVER_DEVICE_ID, entity, payload);
  }

  function apply(ops: Op[], batchId?: string) {
    return serverApplyOps(serverCtx, ops, { origin: meta.origin, actor: meta.actor, batchId });
  }

  function requireBlock(id: string): BlockRow {
    const row = getBlockRow(driver, id);
    if (!row) throw new Error(`no such block: ${id}`);
    return row;
  }

  const blocks: BlocksApi = {
    async get(id) {
      const row = getBlockRow(driver, id);
      return row ? rowToBlock(driver, row) : null;
    },

    async children(parent) {
      const rows =
        typeof parent === "string"
          ? (() => {
              const p = requireBlock(parent);
              return siblingRows(driver, p.page_id, p.id);
            })()
          : siblingRows(driver, parent.page, null);
      return rows.map((r) => rowToBlock(driver, r));
    },

    async tree(root, opts) {
      const depth = opts?.depth ?? Number.POSITIVE_INFINITY;
      if (typeof root === "string") {
        const row = getBlockRow(driver, root);
        if (!row) return [];
        const block = rowToBlock(driver, row);
        const node: ServerBlockNode = {
          ...block,
          children: loadBlockTree(driver, root, row.page_id, depth),
        };
        return [node];
      }
      return loadBlockTree(driver, null, root.page, depth);
    },

    async insert(spec) {
      const pageId = spec.page ?? (spec.parent ? requireBlock(spec.parent).page_id : undefined);
      if (!pageId) throw new Error("BlocksApi.insert: one of page/parent is required");
      const parentId = spec.parent ?? null;
      const order = orderForAfter(driver, pageId, parentId, spec.after ?? "last");
      const id = newId();
      apply([
        mint(id, {
          kind: "block.create",
          place: { pageId, parentId, order },
          content: spec.content,
          properties: spec.properties,
          createdAt: Date.now(),
        }),
      ]);
      return rowToBlock(driver, requireBlock(id));
    },

    async update(id, patch) {
      requireBlock(id);
      const ops: Op[] = [];
      if (patch.content !== undefined)
        ops.push(mint(id, { kind: "block.text", content: patch.content }));
      if (patch.collapsed !== undefined) {
        ops.push(
          mint(id, {
            kind: "block.prop",
            key: "collapsed",
            value: patch.collapsed ? "true" : "false",
          }),
        );
      }
      if (patch.properties) {
        for (const [k, v] of Object.entries(patch.properties))
          ops.push(mint(id, { kind: "block.prop", key: k, value: v }));
      }
      if (ops.length > 0) apply(ops);
      return rowToBlock(driver, requireBlock(id));
    },

    async move(id, to) {
      const row = requireBlock(id);
      const pageId = to.page ?? (to.parent ? requireBlock(to.parent).page_id : row.page_id);
      const parentId = to.parent ?? (to.page ? null : row.parent_id);
      const order = orderForAfter(driver, pageId, parentId, to.after ?? "last");
      apply([mint(id, { kind: "block.place", place: { pageId, parentId, order } })]);
    },

    async delete(id, opts) {
      const mode = opts?.children ?? "delete";
      const row = requireBlock(id);
      const ops: Op[] = [];
      if (mode === "lift") {
        for (const child of siblingRows(driver, row.page_id, id)) {
          const order = orderForAfter(driver, row.page_id, row.parent_id, "last");
          ops.push(
            mint(child.id, {
              kind: "block.place",
              place: { pageId: row.page_id, parentId: row.parent_id, order },
            }),
          );
        }
        ops.push(mint(id, { kind: "block.delete", deletedAt: Date.now() }));
      } else {
        const stack = [id];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          ops.push(mint(cur, { kind: "block.delete", deletedAt: Date.now() }));
          for (const child of siblingRows(driver, row.page_id, cur)) stack.push(child.id);
        }
      }
      apply(ops);
    },
  };

  const pages: PagesApi = {
    async get(ref) {
      if (typeof ref === "string") {
        const row = getPageRow(driver, ref);
        return row ? rowToPage(driver, row) : null;
      }
      const key = normalizePageName(ref.name);
      let row = driver.get<PageRow>("SELECT * FROM page WHERE key = ? AND deleted_at IS NULL", [
        key,
      ]);
      if (!row) {
        row = driver.get<PageRow>(
          `SELECT p.* FROM page_alias pa JOIN page p ON p.id = pa.page_id
           WHERE pa.alias_key = ? AND p.deleted_at IS NULL`,
          [key],
        );
      }
      return row ? rowToPage(driver, row) : null;
    },

    async list(opts) {
      const limit = opts?.limit ?? 50;
      const offset = opts?.cursor
        ? Number.parseInt(Buffer.from(opts.cursor, "base64").toString("utf8"), 10)
        : 0;
      const conditions: string[] = ["deleted_at IS NULL"];
      const params: unknown[] = [];
      if (opts?.kind === "journal") conditions.push("journal_day IS NOT NULL");
      else if (opts?.kind === "page" || opts?.kind === undefined)
        conditions.push("journal_day IS NULL");
      if (opts?.namespace) {
        const ns = normalizePageName(opts.namespace);
        conditions.push("(key = ? OR key LIKE ?)");
        params.push(ns, `${ns}/%`);
      }
      const rows = driver.all<PageRow>(
        `SELECT * FROM page WHERE ${conditions.join(" AND ")} ORDER BY name LIMIT ? OFFSET ?`,
        [...params, limit + 1, offset],
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => rowToPage(driver, r));
      return {
        items,
        cursor: hasMore ? Buffer.from(String(offset + limit)).toString("base64") : undefined,
      };
    },

    async create(spec) {
      const id = newId();
      apply([
        mint(id, {
          kind: "page.create",
          name: spec.name,
          journalDay: null,
          properties: spec.properties,
          createdAt: Date.now(),
        }),
      ]);
      if (spec.firstBlock) {
        const bid = newId();
        apply([
          mint(bid, {
            kind: "block.create",
            place: { pageId: id, parentId: null, order: orderBetween(null, null) },
            content: spec.firstBlock,
            createdAt: Date.now(),
          }),
        ]);
      }
      const row = getPageRow(driver, id);
      if (!row) throw new Error("page.create: failed to read back created page");
      return rowToPage(driver, row);
    },

    async rename(id, name) {
      const before = getPageRow(driver, id);
      if (!before) throw new Error(`no such page: ${id}`);
      const renameOp = mint(id, { kind: "page.rename", name });
      // Rewrite [[Old Name]] -> [[New Name]] wherever it appears verbatim (see buildWikilinkRewriteOps
      // below for the documented v1 simplification: exact-name substring match, not full alias parsing).
      const rewriteOps = buildWikilinkRewriteOps(driver, mint, before.name, name);
      apply([renameOp, ...rewriteOps]);
      const row = getPageRow(driver, id);
      if (!row) throw new Error("page.rename: failed to read back renamed page");
      return rowToPage(driver, row);
    },

    async delete(id) {
      const row = requireBlockPage(driver, id);
      const ops: Op[] = [mint(id, { kind: "page.delete", deletedAt: Date.now() })];
      const blockRows = driver.all<{ id: string }>(
        "SELECT id FROM block WHERE page_id = ? AND deleted_at IS NULL",
        [row.id],
      );
      for (const b of blockRows)
        ops.push(mint(b.id, { kind: "block.delete", deletedAt: Date.now() }));
      apply(ops);
    },

    async namespaceTree(root) {
      const rootKey = normalizePageName(root);
      const rows = driver.all<PageRow>(
        `SELECT * FROM page WHERE deleted_at IS NULL AND (key = ? OR key LIKE ?) ORDER BY length(name), name`,
        [rootKey, `${rootKey}/%`],
      );
      const nodes = new Map<string, { page: Page; children: unknown[] }>();
      const roots: Array<{ page: Page; children: unknown[] }> = [];
      for (const row of rows) {
        const page = rowToPage(driver, row);
        const node = { page, children: [] as unknown[] };
        nodes.set(page.key, node);
        const parentName = namespaceParent(page.name);
        const parent = parentName ? nodes.get(normalizePageName(parentName)) : undefined;
        if (parent) (parent.children as Array<typeof node>).push(node);
        else roots.push(node);
      }
      return roots;
    },

    async journal(date, opts) {
      const day = journalDayFromWire(date);
      if (day === null) throw new Error(`invalid journal date: ${date}`);
      const row = driver.get<PageRow>(
        "SELECT * FROM page WHERE journal_day = ? AND deleted_at IS NULL",
        [day],
      );
      if (row) return rowToPage(driver, row);
      if (!opts?.create) return null;
      const id = newId();
      const title = formatJournalTitle(day);
      apply([
        mint(id, { kind: "page.create", name: title, journalDay: day, createdAt: Date.now() }),
      ]);
      const created = getPageRow(driver, id);
      if (!created) throw new Error("journal: failed to read back created page");
      return rowToPage(driver, created);
    },
  };

  const query: QueryApi = {
    async blocks(q) {
      const limit = q.limit ?? 50;
      const offset = q.cursor
        ? Number.parseInt(Buffer.from(q.cursor, "base64").toString("utf8"), 10)
        : 0;
      const conditions: string[] = ["b.deleted_at IS NULL"];
      const params: unknown[] = [];
      if (q.text) {
        conditions.push("b.content LIKE ?");
        params.push(`%${q.text}%`);
      }
      if (q.page) {
        if (typeof q.page === "string") {
          conditions.push("b.page_id = ?");
          params.push(q.page);
        } else {
          const ns = normalizePageName(q.page.namespace);
          conditions.push(
            "EXISTS (SELECT 1 FROM page p WHERE p.id = b.page_id AND (p.key = ? OR p.key LIKE ?))",
          );
          params.push(ns, `${ns}/%`);
        }
      }
      if (q.updatedAfter !== undefined) {
        conditions.push("b.updated_at > ?");
        params.push(q.updatedAfter);
      }
      const order =
        q.order === "created"
          ? "b.created_at"
          : q.order === "page"
            ? "b.page_id, b.order_key"
            : "b.updated_at DESC";
      const rows = driver.all<BlockRow>(
        `SELECT ${BLOCK_COLUMNS.replace(/(^|, )/g, "$1b.")} FROM block b WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...params, limit + 1, offset],
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => rowToBlock(driver, r));
      return {
        items,
        cursor: hasMore ? Buffer.from(String(offset + limit)).toString("base64") : undefined,
      };
    },

    async linkedRefs(target) {
      const rows = driver.all<{ block_id: string; page_id: string }>(
        `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id
         FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
         WHERE pr.page_key = (SELECT key FROM page WHERE id = ?) OR pr.block_id IN
           (SELECT src_block_id FROM ref WHERE dst_block_id = ?)`,
        [target, target],
      );
      return groupByPage(driver, rows);
    },

    async unlinkedRefs(_page) {
      return [];
    },

    async semantic() {
      // Embeddings ship in M3 (ADR 010); v1 always returns no semantic hits.
      return [];
    },
  };

  function transact<T>(fn: (tx: DataApi) => Promise<T> | T): Promise<T> {
    return Promise.resolve(driver.transaction(() => fn(api)));
  }

  const api: DataApi = { blocks, pages, query, transact };
  return api;
}

function requireBlockPage(driver: SqlDriver, id: string): PageRow {
  const row = getPageRow(driver, id);
  if (!row) throw new Error(`no such page: ${id}`);
  return row;
}

function groupByPage(
  driver: SqlDriver,
  rows: Array<{ block_id: string; page_id: string }>,
): Array<{ page: Page; blocks: Block[] }> {
  const byPage = new Map<string, string[]>();
  for (const r of rows) {
    const list = byPage.get(r.page_id) ?? [];
    list.push(r.block_id);
    byPage.set(r.page_id, list);
  }
  const out: Array<{ page: Page; blocks: Block[] }> = [];
  for (const [pageId, blockIds] of byPage) {
    const pageRow = getPageRow(driver, pageId);
    if (!pageRow) continue;
    const blocks = blockIds
      .map((id) => getBlockRow(driver, id))
      .filter((r): r is BlockRow => r !== undefined);
    out.push({
      page: rowToPage(driver, pageRow),
      blocks: blocks.map((r) => rowToBlock(driver, r)),
    });
  }
  return out;
}

/** `YYYY-MM-DD` or `today`/`yesterday`/`tomorrow` -> internal `YYYYMMDD` int, or `null` if neither. */
export function journalDayFromWire(ref: string): number | null {
  const lower = ref.trim().toLowerCase();
  const now = new Date();
  if (lower === "today") return todayJournalDay(now);
  if (lower === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return todayJournalDay(d);
  }
  if (lower === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return todayJournalDay(d);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ref.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/**
 * `page.update`/`page.rename`'s ref-rewrite (api-and-plugin-types.md §3, `PagesApi.rename`'s doc
 * comment: "rewrites [[refs]] in content in the same tx"). v1 SIMPLIFICATION (explicitly allowed
 * by the task): a case-sensitive substring replace of the literal `[[OldName]]` and `[[OldName|`
 * occurrences, found via the `ref` table's already-indexed `dst_page_key` (so we only scan blocks
 * that actually reference the old name) rather than a fully alias/case-aware wikilink parser. Good
 * enough for v1; a real rename that also needs to handle `#OldName`/casing variants can follow up.
 * Returns the `block.text` ops to apply (does not apply them itself), so a caller — `PagesApi.rename`
 * here, or `page.update`'s op handler, which also needs the rewritten-count — can fold them into
 * one atomic `applyOps` call alongside the `page.rename` op itself.
 */
export function buildWikilinkRewriteOps(
  driver: SqlDriver,
  mint: (entity: string, payload: OpPayload) => Op,
  oldName: string,
  newName: string,
): Op[] {
  if (oldName === newName) return [];
  const oldKey = normalizePageName(oldName);
  const candidates = driver.all<{ block_id: string; content: string }>(
    `SELECT DISTINCT b.id AS block_id, b.content AS content
     FROM ref r JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
     WHERE r.dst_page_key = ? AND r.kind = 'page'`,
    [oldKey],
  );
  const bracket = `[[${oldName}]]`;
  const aliasOpen = `[[${oldName}|`;
  const ops: Op[] = [];
  for (const row of candidates) {
    if (!row.content.includes(bracket) && !row.content.includes(aliasOpen)) continue;
    const next = row.content
      .split(aliasOpen)
      .join(`[[${newName}|`)
      .split(bracket)
      .join(`[[${newName}]]`);
    if (next === row.content) continue;
    ops.push(mint(row.block_id, { kind: "block.text", content: next }));
  }
  return ops;
}

export type { BlockRow, PageRow };
export { getBlockRow, getBlockRowAny, getPageRow, rowToBlock, rowToPage };
