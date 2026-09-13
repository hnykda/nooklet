/**
 * The M7 refactor ops (`block.to_page`, `block.move_to_page`, `page.merge`, `graph.replace`) and
 * `batch.undo` — its one wrapper, `undoBatch` — through `./api-client.ts#callOp`. These are
 * server ops rather than locally-minted op batches on purpose (ADR 020 §1): a merge and a graph-wide replace need the `ref` index, which only the server has, and the
 * context-menu item and the MCP tool must be the same code. After any of the writes the caller
 * pulls (`forceSync`) so the local replica — and every view on it — catches up at once instead of
 * on the next poke.
 */

import { callOp } from "./api-client.js";

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

/**
 * `batch.undo` — reverses one batch; the result's `batchId` is the undo's own (undo it to redo).
 *
 * The ONE wrapper for it (B-330): History, Find & Replace and the References panel's Link all undo
 * through here. There were three, and only History's knew about `kept`.
 */
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
    const out = await callOp<{
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
    const out = await callOp<{
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
    const out = await callOp<{
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
    const out = await callOp<{
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

  undoBatch,
};

export type RefactorApi = typeof refactorApi;
