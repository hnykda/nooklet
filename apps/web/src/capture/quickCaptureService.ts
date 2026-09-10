/**
 * Async glue between `quickCapture.ts`'s pure op-builder and the real data seam. Every dependency
 * is injected through `QuickCaptureDeps` so `quickCaptureService.test.ts` can supply a fake
 * in-memory seam instead of crossing the real Comlink/worker boundary — the "fake data seam" this
 * milestone's tests ask for, in the same spirit as `../editor/test-helpers.ts`'s fakes for the
 * editor's pure commands.
 *
 * Deliberately does NOT go through `../data/store.ts`'s `usePageTree`/`useJournalStream` (which
 * fetch a whole page's block tree): PLAN.md §14 calls quick capture "a dedicated lightweight route
 * that appends to today's journal without loading the graph" — this module only ever runs one
 * targeted lookup (does today's journal page exist, and if so what is its last root block's order)
 * before writing, never a full tree fetch.
 */
import {
  type ApplyOpsResult,
  type JournalDay,
  newId,
  type Op,
  todayJournalDay,
} from "@nooklet/core";
import { applyOps, getOpClock } from "../data/store.js";
import { queryAs } from "../db/client.js";
import type { Clock } from "../editor/types.js";
import { buildQuickCaptureOps, type QuickCaptureTarget } from "./quickCapture.js";

export interface QuickCaptureDeps {
  today(): JournalDay;
  findTarget(day: JournalDay): Promise<QuickCaptureTarget | null>;
  getClock(): Promise<Clock>;
  newId(): string;
  applyOps(ops: Op[]): Promise<ApplyOpsResult>;
  now(): number;
}

interface JournalPageRow {
  id: string;
}

interface LastRootBlockRow {
  order_key: string;
}

/** The one targeted lookup this route needs: today's journal page id (if it exists) and its last
 * root block's order key (if it has any root blocks) — never the whole tree. */
async function findJournalTarget(day: JournalDay): Promise<QuickCaptureTarget | null> {
  const pages = await queryAs<JournalPageRow>(
    "SELECT id FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1",
    [day],
  );
  const page = pages[0];
  if (!page) return null;
  const rows = await queryAs<LastRootBlockRow>(
    `SELECT order_key FROM block
     WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL
     ORDER BY order_key DESC LIMIT 1`,
    [page.id],
  );
  return { pageId: page.id, lastRootOrder: rows[0]?.order_key ?? null };
}

/** Real dependencies, wired to the worker/DB. Only two HLCs are ever needed here (page.create +
 * block.create at most), so `getOpClock(2)` avoids `getOpClock`'s default pool of 16 round trips —
 * "fast to open" (BUILD item 3) extends to not over-fetching HLCs for a one-block write. */
export const defaultQuickCaptureDeps: QuickCaptureDeps = {
  today: () => todayJournalDay(),
  findTarget: findJournalTarget,
  getClock: () => getOpClock(2),
  newId,
  applyOps,
  now: () => Date.now(),
};

export interface QuickCaptureResult {
  pageId: string;
}

/**
 * Append `text` to today's journal, creating the page if this is the day's first capture. Returns
 * `null` for blank/whitespace-only text (nothing written, nothing to confirm).
 *
 * Works offline by construction: `deps.applyOps` (in production, `../data/store.ts#applyOps`)
 * writes to the local replica and queues the op in the same outbox every other client write uses
 * (ADR 005) — there is no separate "offline capture" code path to keep in sync with the online one.
 */
export async function submitQuickCapture(
  text: string,
  deps: QuickCaptureDeps = defaultQuickCaptureDeps,
): Promise<QuickCaptureResult | null> {
  const day = deps.today();
  const [target, clock] = await Promise.all([deps.findTarget(day), deps.getClock()]);
  const built = buildQuickCaptureOps({
    target,
    day,
    text,
    clock,
    newId: deps.newId,
    now: deps.now(),
  });
  if (!built) return null;
  await deps.applyOps(built.ops);
  return { pageId: built.pageId };
}
