/**
 * The M7 refactor ops (`block.to_page`, `block.move_to_page`, `page.merge`, `graph.replace`) and
 * `batch.undo`, called the way `./api-client.ts` calls `search`: `POST /api/v1/<op>` with this
 * device's token. These are server ops rather than locally-minted op batches on purpose (ADR 020
 * §1): a merge and a graph-wide replace need the `ref` index, which only the server has, and the
 * context-menu item and the MCP tool must be the same code. After any of the writes the caller
 * pulls (`forceSync`) so the local replica — and every view on it — catches up at once instead of
 * on the next poke.
 */

import { apiBaseUrl, authToken } from "./bootstrap.js";

export class RefactorApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "RefactorApiError";
  }
}

async function post<TOut>(opName: string, body: unknown): Promise<TOut> {
  const token = authToken();
  const res = await fetch(`${apiBaseUrl()}/api/v1/${opName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => undefined)) as
    | TOut
    | { error: { code: string; message: string; hint?: string } }
    | undefined;
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    const err = (json as { error?: { code: string; message: string; hint?: string } } | undefined)
      ?.error;
    throw new RefactorApiError(err?.code ?? "internal", err?.message ?? res.statusText, err?.hint);
  }
  return json as TOut;
}

export interface BlockToPageResult {
  page: string;
  pageId: string;
  pageCreated: boolean;
  moved: number;
  batchId?: string;
}

export interface MoveToPageResult {
  page: string;
  pageCreated: boolean;
  moved: number;
  batchId?: string;
}

export interface MergeResult {
  source: string;
  target: string;
  blocksMoved: number;
  refsRewritten: number;
  batchId?: string;
}

export interface ReplaceMatch {
  blockId: string;
  page: string;
  before: string;
  after: string;
  count: number;
}

export interface ReplaceInput {
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  dryRun: boolean;
  limit?: number;
}

export interface ReplaceResult {
  matches: ReplaceMatch[];
  blocksMatched: number;
  occurrences: number;
  truncated: boolean;
  batchId?: string;
}

export const refactorApi = {
  async blockToPage(blockId: string): Promise<BlockToPageResult> {
    const out = await post<{
      page: string;
      page_id: string;
      page_created: boolean;
      moved: number;
      batch_id?: string;
    }>("block.to_page", { id: blockId });
    return {
      page: out.page,
      pageId: out.page_id,
      pageCreated: out.page_created,
      moved: out.moved,
      batchId: out.batch_id,
    };
  },

  async moveBlockToPage(blockId: string, page: string): Promise<MoveToPageResult> {
    const out = await post<{
      page: string;
      page_created: boolean;
      moved: number;
      batch_id?: string;
    }>("block.move_to_page", { id: blockId, page });
    return {
      page: out.page,
      pageCreated: out.page_created,
      moved: out.moved,
      batchId: out.batch_id,
    };
  },

  async mergePage(source: string, target: string): Promise<MergeResult> {
    const out = await post<{
      source: string;
      target: { name: string };
      blocks_moved: number;
      refs_rewritten: number;
      batch_id?: string;
    }>("page.merge", { source, target });
    return {
      source: out.source,
      target: out.target.name,
      blocksMoved: out.blocks_moved,
      refsRewritten: out.refs_rewritten,
      batchId: out.batch_id,
    };
  },

  async replace(input: ReplaceInput): Promise<ReplaceResult> {
    const out = await post<{
      matches: Array<{
        block_id: string;
        page: string;
        before: string;
        after: string;
        count: number;
      }>;
      blocks_matched: number;
      occurrences: number;
      truncated: boolean;
      batch_id?: string;
    }>("graph.replace", {
      query: input.query,
      replacement: input.replacement,
      regex: input.regex,
      case_sensitive: input.caseSensitive,
      dry_run: input.dryRun,
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return {
      matches: out.matches.map((m) => ({
        blockId: m.block_id,
        page: m.page,
        before: m.before,
        after: m.after,
        count: m.count,
      })),
      blocksMatched: out.blocks_matched,
      occurrences: out.occurrences,
      truncated: out.truncated,
      batchId: out.batch_id,
    };
  },

  /** Reverse a previous write by its `batch_id`. Returns the undo's own batch id. */
  async undoBatch(batchId: string): Promise<string | undefined> {
    const out = await post<{ batch_id?: string }>("batch.undo", { batch_id: batchId });
    return out.batch_id;
  },
};

export type RefactorApi = typeof refactorApi;
