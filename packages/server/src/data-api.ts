/**
 * Server-side `DataApi` (`docs/spec/api-and-plugin-types.md` §3): the isomorphic block/page/
 * query/transact facade that op handlers and plugins (`ServerPluginContext.data`) are written
 * against. The interfaces here are the server's own copy of the shapes `@nooklet/plugin-api`
 * publishes in `data.ts`; `packages/plugin-api/src/assignability.test.ts` keeps the two in step.
 *
 * Every write method goes through `serverApplyOps` (ADR 003/008: "every write is an op") — never
 * a raw INSERT/UPDATE of `page`/`block`/`block_prop`/`page_prop`. Reads query the state tables
 * directly (`ctx.db` in op handlers is the same escape hatch for cross-table queries this file
 * itself does not expose, e.g. `search`, `page.backlinks`). Row shapes and the row → `Page`/`Block`
 * mappers live in `./rows.ts`, shared with `apply-ops.ts`.
 */

import {
  type Block,
  type BlockId,
  canonicalRefName,
  DEFAULT_JOURNAL_TITLE_FORMAT,
  isoJournalName,
  isValidJournalDay,
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
  splitList,
  templateInsertOps,
  todayJournalDay,
} from "@nooklet/core";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "./apply-ops.js";
import {
  checkSemanticAvailability,
  distanceToScore,
  embedQueryVector,
  semanticCandidates,
} from "./embeddings/semantic-search.js";
import { suggestedJournalTitleFormat } from "./journal-format.js";
import { journalTemplateNode } from "./journal-template.js";
import { ftsPhrase } from "./ops/fts-query.js";
import { pageLookupKeys, resolvePageIdForKey } from "./page-aliases.js";
import { unclaimedReferencePageForKey } from "./ref-pages.js";
import {
  BLOCK_COLUMNS,
  type BlockRow,
  getBlockRow,
  getPageRow,
  type PageRow,
  rowToBlock,
  rowToPage,
} from "./rows.js";

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
  /** Blocks on other pages that mention the page's name in plain text without linking to it. */
  unlinkedRefs(page: PageId): Promise<Array<{ page: Page; blocks: Block[] }>>;
  /** Nearest blocks by embedding (ADR 010). Empty when no embedding model is active, the query
   * could not be embedded (provider down), or nothing is indexed yet — never an error. */
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

/**
 * The `block.place` ops that move a whole subtree: the root to `place`, and — only when the page
 * changes — every descendant to the same page with its parent and order untouched.
 *
 * `@nooklet/core`'s `applyBlockPlace` updates exactly the row the op names, so a cross-page
 * `block.place` on a parent alone leaves its children with the OLD `page_id` and a parent on
 * another page: neither page's tree query finds them and they vanish (docs/BUGS.md B-85). The
 * reducer is right to stay one-op-one-row (that is what keeps replay trivial), so the subtree is
 * spelled out here, at the op layer. Descendants are emitted parent-first because the reducer
 * nulls a `parentId` whose block is not (yet) on the same page (rule 24's fallback) — a child
 * placed before its parent would land at the new page's top level.
 */
export function subtreePlaceOps(
  driver: SqlDriver,
  mint: (entity: string, payload: OpPayload) => Op,
  rootId: string,
  place: { pageId: string; parentId: string | null; order: string },
): Op[] {
  const root = getBlockRow(driver, rootId);
  if (!root) throw new Error(`no such block: ${rootId}`);
  const ops: Op[] = [mint(rootId, { kind: "block.place", place })];
  if (root.page_id === place.pageId) return ops;
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of siblingRows(driver, root.page_id, parentId)) {
      ops.push(
        mint(child.id, {
          kind: "block.place",
          place: { pageId: place.pageId, parentId, order: child.order_key },
        }),
      );
      queue.push(child.id);
    }
  }
  return ops;
}

/** Every live block id in a subtree, root first — the count a move reports. */
export function subtreeBlockIds(driver: SqlDriver, rootId: string): string[] {
  const root = getBlockRow(driver, rootId);
  if (!root) return [];
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of siblingRows(driver, root.page_id, parentId)) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
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
      // The whole subtree, not just the root — see `subtreePlaceOps` (B-85).
      apply(subtreePlaceOps(driver, mint, id, { pageId, parentId, order }));
    },

    async delete(id, opts) {
      const mode = opts?.children ?? "delete";
      const row = requireBlock(id);
      const ops: Op[] = [];
      // ONE instant for the whole action: `trash.restore` recognises what a delete took with it
      // by an equal `deleted_at`, so a per-op `Date.now()` that crossed a millisecond left the
      // descendants behind as separate trash entries (B-121). Same as `ops/block-delete.ts`.
      const now = Date.now();
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
        ops.push(mint(id, { kind: "block.delete", deletedAt: now }));
      } else {
        const stack = [id];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          ops.push(mint(cur, { kind: "block.delete", deletedAt: now }));
          for (const child of siblingRows(driver, row.page_id, cur)) stack.push(child.id);
        }
      }
      apply(ops);
    },
  };

  const pages: PagesApi = {
    async get(ref) {
      // By id, or by name — where "name" includes any alias the page lists (`alias::`), through
      // the same own-key-then-alias rule references resolve with (`../page-aliases.ts`).
      const id =
        typeof ref === "string" ? ref : resolvePageIdForKey(driver, normalizePageName(ref.name));
      const row = id ? getPageRow(driver, id) : undefined;
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
      // An empty page a reference made (ADR 024) is taken over, as `ops/page-create.ts` does: a
      // `page.create` for its name would be refused as a key collision.
      const claim = unclaimedReferencePageForKey(driver, normalizePageName(spec.name));
      const id = claim ?? newId();
      const now = Date.now();
      const ops: Op[] = claim
        ? [
            mint(id, { kind: "page.rename", name: spec.name }),
            ...Object.entries(spec.properties ?? {}).map(([key, value]) =>
              mint(id, { kind: "page.prop", key, value }),
            ),
          ]
        : [
            mint(id, {
              kind: "page.create",
              name: spec.name,
              journalDay: null,
              properties: spec.properties,
              createdAt: now,
            }),
          ];
      // One batch, so the page and its first block land (and are audited, and can be undone)
      // together rather than as two writes the second of which could fail alone.
      if (spec.firstBlock) {
        ops.push(
          mint(newId(), {
            kind: "block.create",
            place: { pageId: id, parentId: null, order: orderBetween(null, null) },
            content: spec.firstBlock,
            createdAt: now,
          }),
        );
      }
      apply(ops);
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
      // One instant for the page and every block, as `ops/page-delete.ts` does: `trash.restore`
      // brings back the blocks whose `deleted_at` equals the page's (B-121).
      const now = Date.now();
      const ops: Op[] = [mint(id, { kind: "page.delete", deletedAt: now })];
      const blockRows = driver.all<{ id: string }>(
        "SELECT id FROM block WHERE page_id = ? AND deleted_at IS NULL",
        [row.id],
      );
      for (const b of blockRows) ops.push(mint(b.id, { kind: "block.delete", deletedAt: now }));
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
      const ops: Op[] = [
        mint(id, {
          kind: "page.create",
          // Stored under the ISO name, never a display format (ADR 018).
          name: isoJournalName(day),
          journalDay: day,
          createdAt: Date.now(),
        }),
      ];
      // ADR 019: a day born through the API starts with the journal template, exactly as a day
      // born on the client's first keystroke does (`views/VirtualJournalDay.tsx`) — same core
      // builder, same blocks. The date tokens are written in the graph's own title format (the
      // one an import brought, else the default): there is no reader here whose preference could
      // be asked, and any format resolves (ADR 018). `today` means this page's day, not the wall
      // clock's — an agent creating tomorrow's page gets tomorrow's date in it.
      const template = journalTemplateNode(driver);
      if (template) {
        ops.push(
          ...templateInsertOps(
            template,
            { pageId: id, parentId: null, lower: null, upper: null },
            {
              day,
              dateFormat: suggestedJournalTitleFormat(driver) ?? DEFAULT_JOURNAL_TITLE_FORMAT,
              now: new Date(),
            },
            mint,
          ).ops,
        );
      }
      apply(ops);
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

    async unlinkedRefs(pageId) {
      const page = getPageRow(driver, pageId);
      if (!page) return [];
      return groupByPage(driver, unlinkedMentionRows(driver, page, 200));
    },

    async semantic(text, opts) {
      const limit = opts?.limit ?? 20;
      const availability = checkSemanticAvailability(driver);
      if (!availability.available || !availability.model) return [];
      const vec = await embedQueryVector(driver, availability.model, text);
      if (!vec) return [];
      // Over-fetch when filtering to one page: the KNN cannot filter itself, and a page's blocks
      // are a small share of the graph's vectors.
      const k = opts?.page ? Math.min(limit * 10, 500) : limit;
      const out: Array<{ block: Block; score: number }> = [];
      for (const hit of semanticCandidates(driver, availability.model, vec, "block", k)) {
        const row = getBlockRow(driver, hit.unitId);
        if (!row || (opts?.page && row.page_id !== opts.page)) continue;
        out.push({ block: rowToBlock(driver, row), score: distanceToScore(hit.distance) });
        if (out.length >= limit) break;
      }
      return out;
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

/**
 * Unlinked mentions of a page (PLAN §4: "full-text hits for the page name in blocks that do not
 * already reference P"): blocks on OTHER pages whose text contains the page's short name as a
 * phrase and whose path refs do not already reach the page by its key or any alias. Shared by
 * `QueryApi.unlinkedRefs` and `page.backlinks`. Names shorter than three characters produce
 * nothing: a two-letter phrase matches half the graph and none of it is a mention.
 */
export function unlinkedMentionRows(
  driver: SqlDriver,
  page: { id: string; name: string; key: string },
  limit: number,
): Array<{ block_id: string; page_id: string; content: string }> {
  const plainName = page.name.split("/").pop() ?? page.name;
  if (plainName.length < 3) return [];
  const keys = pageLookupKeys(driver, page);
  return driver.all(
    `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
     FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
     WHERE block_fts MATCH ? AND b.deleted_at IS NULL AND b.page_id != ?
       AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key IN (${keys.map(() => "?").join(",")}))
     LIMIT ?`,
    [ftsPhrase(plainName), page.id, ...keys, limit],
  );
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

/** Shape of a wire date, whether or not it names a real day. */
export const WIRE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` or `today`/`yesterday`/`tomorrow` -> internal `YYYYMMDD` int, or `null` if neither.
 * A string shaped like a date that is not one (`2026-13-45`) is also `null` — the caller decides
 * whether that is an error (`ops/resolve.ts`) or simply "not a journal".
 */
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
  const m = WIRE_DATE_RE.exec(ref.trim());
  if (!m) return null;
  const day = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  return isValidJournalDay(day) ? day : null;
}

// ---------------------------------------------------------------------------------------------
// Reference rewriting (page rename, page merge)
// ---------------------------------------------------------------------------------------------

/** The key a reference to `name` is indexed under — `apply-ops.ts`'s `normalizeKey`, which folds
 * case/whitespace and collapses any recognised journal title to its ISO name (ADR 018). */
function refKey(name: string): string {
  return normalizePageName(canonicalRefName(name));
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** `refs.ts`'s tag delimiters, mirrored: a `#tag` runs until one of these. */
const TAG_STOP = new Set([" ", "\t", "\n", ",", ";", ")", "]", "}", "'", '"']);
const TAG_PRECEDER = new Set([" ", "\t", "\n", "(", ",", ";", "[", "{", '"', "'"]);
const TAG_TRAILING = /[.!?:]+$/;

/** Whether `name` can be written as a bare `#tag` and still be read back as exactly that name. */
function isBareTagSafe(name: string): boolean {
  if (name === "" || name.startsWith("[") || name.startsWith("#") || name.startsWith("+"))
    return false;
  for (const ch of name) if (TAG_STOP.has(ch)) return false;
  return !TAG_TRAILING.test(name);
}

function findClosingBrackets(line: string, from: number): number {
  let depth = 1;
  for (let i = from; i < line.length - 1; i++) {
    if (line[i] === "[" && line[i + 1] === "[") {
      depth++;
      i++;
    } else if (line[i] === "]" && line[i + 1] === "]") {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

function findBacktickRun(line: string, from: number, len: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (run === len) return i;
      i += run;
    } else i++;
  }
  return -1;
}

/** Index of the first `|` at bracket depth 0 inside a wikilink's interior, or -1. */
function findTopLevelPipe(inner: string): number {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "[" && inner[i + 1] === "[") {
      depth++;
      i++;
    } else if (inner[i] === "]" && inner[i + 1] === "]") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (inner[i] === "|" && depth === 0) return i;
  }
  return -1;
}

/**
 * Rewrite every `[[X]]`, `[[X|label]]`, `#X` and `#[[X]]` in one line whose `refKey(X)` is in
 * `keys`, to name `toName` instead. The scan mirrors `refs.ts#scanLine` — the reader that built
 * the `ref` index this rewrite is answering for — so it skips inline code and honours the same
 * tag delimiters, and it rewrites exactly what that reader would have indexed. A label after a
 * pipe is kept (`[[Old|the old one]]` -> `[[New|the old one]]`): it is the person's wording. A
 * bare `#old` becomes `#[[New Name]]` when the new name cannot be written bare.
 */
function rewriteRefsInLine(
  line: string,
  keys: ReadonlySet<string>,
  toName: string,
): { text: string; count: number } {
  let out = "";
  let count = 0;
  let i = 0;
  const n = line.length;
  const matches = (name: string): boolean => name.trim() !== "" && keys.has(refKey(name));

  while (i < n) {
    const ch = line[i] as string;

    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = findBacktickRun(line, i + run, run);
      const end = close === -1 ? i + run : close + run;
      out += line.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "[" && line[i + 1] === "[") {
      const end = findClosingBrackets(line, i + 2);
      if (end !== -1) {
        const inner = line.slice(i + 2, end);
        const pipe = findTopLevelPipe(inner);
        const target = pipe === -1 ? inner : inner.slice(0, pipe);
        const label = pipe === -1 ? "" : inner.slice(pipe);
        if (matches(target)) {
          out += `[[${toName}${label}]]`;
          count++;
        } else if (target.includes("[[")) {
          // Nested `[[a [[b]]]]`: the outer name is not ours, but an inner one may be.
          const nested = rewriteRefsInLine(target, keys, toName);
          out += `[[${nested.text}${label}]]`;
          count += nested.count;
        } else {
          out += line.slice(i, end + 2);
        }
        i = end + 2;
        continue;
      }
    }

    if (ch === "#" && (i === 0 || TAG_PRECEDER.has(line[i - 1] as string))) {
      const next = line[i + 1];
      if (next === "[" && line[i + 2] === "[") {
        const end = findClosingBrackets(line, i + 3);
        if (end !== -1) {
          const inner = line.slice(i + 3, end);
          if (matches(inner)) {
            out += `#[[${toName}]]`;
            count++;
          } else {
            out += line.slice(i, end + 2);
          }
          i = end + 2;
          continue;
        }
      } else if (next !== undefined && next !== "#" && next !== "+" && !TAG_STOP.has(next)) {
        let j = i + 1;
        while (j < n && !TAG_STOP.has(line[j] as string)) j++;
        const raw = line.slice(i + 1, j);
        const tag = raw.replace(TAG_TRAILING, "");
        const trailing = raw.slice(tag.length);
        if (matches(tag)) {
          out += isBareTagSafe(toName) ? `#${toName}${trailing}` : `#[[${toName}]]${trailing}`;
          count++;
        } else {
          out += line.slice(i, j);
        }
        i = j;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return { text: out, count };
}

/** `rewriteRefsInLine` over a whole text, skipping fenced code blocks (`fences` true for block
 * content; a property value has no fences). */
export function rewriteRefsInText(
  text: string,
  keys: ReadonlySet<string>,
  toName: string,
  fences = true,
): { text: string; count: number } {
  let fence: string | null = null;
  let count = 0;
  const lines = text.split("\n").map((line) => {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      return line;
    }
    if (fences) {
      const fm = FENCE_RE.exec(line);
      if (fm) {
        fence = fm[1] as string;
        return line;
      }
    }
    const r = rewriteRefsInLine(line, keys, toName);
    count += r.count;
    return r.text;
  });
  return { text: lines.join("\n"), count };
}

/** `tags::` / `alias::` are comma lists whose items may be bare, `[[wrapped]]` or `#tagged`
 * (`refs.ts#extractRefs`); an item naming one of `keys` is replaced by `toName` in the same form. */
function rewriteRefList(
  value: string,
  keys: ReadonlySet<string>,
  toName: string,
): { text: string; count: number } {
  let count = 0;
  const items = splitList(value).map((item) => {
    const trimmed = item.trim();
    const wrapped = trimmed.startsWith("[[") && trimmed.endsWith("]]");
    const hashed = !wrapped && trimmed.startsWith("#");
    const bare = wrapped ? trimmed.slice(2, -2).trim() : hashed ? trimmed.slice(1).trim() : trimmed;
    if (bare === "" || !keys.has(refKey(bare))) return trimmed;
    count++;
    return wrapped ? `[[${toName}]]` : hashed ? `#${toName}` : toName;
  });
  if (count === 0) return { text: value, count };
  // Dedupe (by key) what the rewrite may have made equal — `tags:: a, b` merged into `b` must
  // not become `tags:: b, b`. Only after a rewrite: an untouched list is returned verbatim.
  const seen = new Set<string>();
  const distinct = items.filter((item) => {
    const key = refKey(item.replace(/^#|^\[\[|\]\]$/g, ""));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { text: distinct.join(", "), count };
}

export interface RefRewriteResult {
  ops: Op[];
  /** Blocks (and pages, for page-level `tags::`) whose text or properties changed. */
  entities: number;
  /** Individual references rewritten. */
  occurrences: number;
}

/**
 * The ops that make every reference to any of `fromKeys` name `toName` instead — `page.update`'s
 * rename and `page.merge`'s consolidation both need exactly this, so it lives once, here.
 *
 * Candidates come from the `ref` index (`dst_page_key IN fromKeys`), never a scan of every block,
 * so this costs what the rename touches. Within each candidate the rewrite is alias- and
 * case-aware: `fromKeys` is whatever set the caller means (a page's own key plus its alias keys,
 * `page-aliases.ts#pageLookupKeys`, for a merge; just the old key for a rename), and the match
 * is on `refKey` so `[[old name]]`, `[[Old Name]]` and a journal date in any title format all
 * count. Block text, block `tags::`/`alias::` lists and other block properties are rewritten
 * with `block.text`/`block.prop` ops; the `tags::` of pages that tag the old page (`page_tag`) with
 * `page.prop` ops. Returns the ops without applying them, so a caller folds them into the one
 * batch that also renames/merges the page. Known gap: a block whose only link is `[[Page|label]]`
 * is not a candidate until B-86 is fixed in `refs.ts`.
 */
export function buildRefRewriteOps(
  driver: SqlDriver,
  mint: (entity: string, payload: OpPayload) => Op,
  fromKeys: readonly string[],
  toName: string,
): RefRewriteResult {
  const keys = new Set(fromKeys.filter((k) => k !== refKey(toName)));
  const result: RefRewriteResult = { ops: [], entities: 0, occurrences: 0 };
  if (keys.size === 0) return result;
  const placeholders = [...keys].map(() => "?").join(",");

  const blocks = driver.all<{ block_id: string; content: string }>(
    `SELECT DISTINCT b.id AS block_id, b.content AS content
     FROM ref r JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
     WHERE r.dst_page_key IN (${placeholders}) AND r.kind IN ('page', 'tag')
     ORDER BY b.id`,
    [...keys],
  );
  for (const row of blocks) {
    let touched = false;
    const text = rewriteRefsInText(row.content, keys, toName);
    if (text.text !== row.content) {
      result.ops.push(mint(row.block_id, { kind: "block.text", content: text.text }));
      result.occurrences += text.count;
      touched = true;
    }
    for (const prop of driver.all<{ key: string; value: string }>(
      "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
      [row.block_id],
    )) {
      const r =
        prop.key === "tags" || prop.key === "alias"
          ? rewriteRefList(prop.value, keys, toName)
          : rewriteRefsInText(prop.value, keys, toName, false);
      if (r.text === prop.value) continue;
      result.ops.push(mint(row.block_id, { kind: "block.prop", key: prop.key, value: r.text }));
      result.occurrences += r.count;
      touched = true;
    }
    if (touched) result.entities++;
  }

  const pages = driver.all<{ page_id: string; value: string }>(
    `SELECT DISTINCT pt.page_id AS page_id, pp.value AS value
     FROM page_tag pt
     JOIN page p ON p.id = pt.page_id AND p.deleted_at IS NULL
     JOIN page_prop pp ON pp.page_id = pt.page_id AND pp.key = 'tags' AND pp.value IS NOT NULL
     WHERE pt.tag_key IN (${placeholders})
     ORDER BY pt.page_id`,
    [...keys],
  );
  for (const row of pages) {
    const r = rewriteRefList(row.value, keys, toName);
    if (r.text === row.value) continue;
    result.ops.push(mint(row.page_id, { kind: "page.prop", key: "tags", value: r.text }));
    result.occurrences += r.count;
    result.entities++;
  }
  return result;
}

/**
 * `page.update`/`PagesApi.rename`'s ref-rewrite (api-and-plugin-types.md §3, `PagesApi.rename`'s
 * doc comment: "rewrites [[refs]] in content in the same tx"): `buildRefRewriteOps` for one old
 * name. Returns the ops (not applied), one per changed block/property/page, so the caller folds
 * them into the same `applyOps` call as the `page.rename` op itself.
 */
export function buildWikilinkRewriteOps(
  driver: SqlDriver,
  mint: (entity: string, payload: OpPayload) => Op,
  oldName: string,
  newName: string,
): Op[] {
  if (oldName === newName) return [];
  return buildRefRewriteOps(driver, mint, [refKey(oldName)], newName).ops;
}
