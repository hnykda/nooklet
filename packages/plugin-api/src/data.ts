/**
 * The shared `DataApi` (`docs/spec/api-and-plugin-types.md` §3): the isomorphic block/page/query/
 * transact facade both plugin halves see as `ctx.data`. Matches `packages/server/src/data-api.ts`
 * field-for-field (that file is the real server implementation this type must not drift from).
 *
 * One intentional, structurally-harmless difference: the server's `BlocksApi.tree()` actually
 * returns `ServerBlockNode[]` (a `BlockNode` plus an optional `childCount`, used internally by
 * `page.read`/`block.read` to report how many children a depth cutoff hid). `childCount` is a
 * server/MCP-tools-internal concern, not part of the public plugin surface, so it is omitted here
 * — `ServerBlockNode[]` is still assignable to `BlockNode[]` (an extra optional field is a
 * structural subtype), so nothing breaks; see `assignability.test.ts`.
 *
 * References `packages/core/src/model.ts` (`Block`, `Page`, `BlockId`, `PageId`, `Properties`)
 * and `packages/core/src/ops.ts` (`Op`, used only transitively via `DataApi`'s callers) directly —
 * this module does not redefine those; import them from `@nooklet/core` directly.
 */
import type { Block, BlockId, Page, PageId, Properties } from "@nooklet/core";

export interface BlockNode extends Block {
  children: BlockNode[];
}

export interface PropertyPatch {
  /** `null` unsets the key (`api-and-plugin-types.md` rule 17: property values crossing this
   * boundary are always `string`, or `null` to unset — never a richer typed union). */
  [key: string]: string | null;
}

export interface BlocksApi {
  get(id: BlockId): Promise<Block | null>;
  children(parent: BlockId | { page: PageId }): Promise<Block[]>;
  tree(root: BlockId | { page: PageId }, opts?: { depth?: number }): Promise<BlockNode[]>;
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
  /** Rewrites `[[refs]]` in content in the same tx. */
  rename(id: PageId, name: string): Promise<Page>;
  delete(id: PageId): Promise<void>;
  namespaceTree(root: string): Promise<Array<{ page: Page; children: unknown[] }>>;
  /** `date` is `YYYY-MM-DD` (rule 18), or `"today"` | `"yesterday"` | `"tomorrow"`. */
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
  /** One atomic write, one change-event batch. */
  transact<T>(fn: (tx: DataApi) => Promise<T> | T, opts?: { label?: string }): Promise<T>;
}
