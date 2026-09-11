/**
 * Quick capture (PLAN.md §14, research/08-mobile.md §4: "the #1 mobile use case"): pure op-building
 * for "append this text to today's journal," structured the same way as `../editor/commands.ts` —
 * a plain function from (current state, input) to `Op[]`, with an injected clock and id generator
 * so it is unit-testable with zero worker/DB/DOM (`quickCapture.test.ts`).
 * `quickCaptureService.ts` is the thin async glue that looks up whether today's journal page
 * already exists and calls this; `../views/CaptureView.tsx` is the UI.
 *
 * This reuses exactly the ops `../views/VirtualJournalDay.tsx#materialize` builds (`page.create`
 * then `block.create`) for the "page doesn't exist yet" case, and a single `block.create` appended
 * after the last root block otherwise — never a parallel write path.
 */
import { isoJournalName, type JournalDay, makeOp, type Op, orderBetween } from "@nooklet/core";
import type { Clock } from "../editor/types.js";

/** What the caller already knows about today's journal page, or `null` if it does not exist yet
 * (PLAN.md §8: a journal page is virtual until it has a block). */
export interface QuickCaptureTarget {
  pageId: string;
  /** `order_key` of the last root-level (`parent_id IS NULL`) block, or `null` if the page exists
   * but has no root blocks yet. */
  lastRootOrder: string | null;
}

export interface BuildQuickCaptureOpsInput {
  target: QuickCaptureTarget | null;
  day: JournalDay;
  text: string;
  clock: Clock;
  newId: () => string;
  now?: number;
}

export interface QuickCaptureOpsResult {
  ops: Op[];
  pageId: string;
}

/**
 * Builds the ops to append `text` as a new top-level block on today's journal, creating the page
 * first if it does not exist yet. Returns `null` for blank/whitespace-only text — nothing to
 * write, and the caller should not show a "saved" confirmation for it.
 */
export function buildQuickCaptureOps(
  input: BuildQuickCaptureOpsInput,
): QuickCaptureOpsResult | null {
  const text = input.text.trim();
  if (text === "") return null;
  const now = input.now ?? Date.now();
  const ops: Op[] = [];

  const pageId = input.target?.pageId ?? input.newId();
  if (input.target === null) {
    ops.push(
      makeOp(input.clock.next(), input.clock.device, pageId, {
        kind: "page.create",
        name: isoJournalName(input.day),
        journalDay: input.day,
        createdAt: now,
      }),
    );
  }

  const blockId = input.newId();
  const order = orderBetween(input.target?.lastRootOrder ?? null, null);
  ops.push(
    makeOp(input.clock.next(), input.clock.device, blockId, {
      kind: "block.create",
      place: { pageId, parentId: null, order },
      content: text,
      createdAt: now,
    }),
  );

  return { ops, pageId };
}
