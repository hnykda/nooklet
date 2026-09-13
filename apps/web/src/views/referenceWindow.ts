/**
 * How much of a long references list the panel renders, and what its heading count says (B-253).
 *
 * The panel now holds every reference (the client follows `page.backlinks`'s cursor), so counts
 * and filters are true — but rendering 1,074 rows of inline Markdown on every graph change is not
 * free: the resource refetches after each edit, and `<For>` is keyed by reference, so every row is
 * rebuilt each time. The panel therefore shows a window of rows, grown by a "Show more" button,
 * and the heading counts what is there rather than what is drawn. Pure, for `referenceWindow.test.ts`.
 */

/** Rows rendered initially and added per "Show more": the old silent cap, now an honest one. */
export const REFERENCE_ROWS_STEP = 200;

export interface WindowedGroups<G> {
  groups: G[];
  /** Rows in `groups`. */
  shown: number;
  /** Rows in all groups. */
  total: number;
}

/** The first `maxRows` rows across `groups`, in order; the group the limit falls in is cut short
 * rather than dropped, so the rows shown are exactly the first `maxRows`. */
export function firstRows<R, G extends { refs: readonly R[] }>(
  groups: readonly G[],
  maxRows: number,
): WindowedGroups<G> {
  let total = 0;
  for (const g of groups) total += g.refs.length;
  const out: G[] = [];
  let shown = 0;
  for (const g of groups) {
    if (shown >= maxRows) break;
    const room = maxRows - shown;
    if (g.refs.length <= room) {
      out.push(g);
      shown += g.refs.length;
    } else {
      out.push({ ...g, refs: g.refs.slice(0, room) });
      shown += room;
    }
  }
  return { groups: out, shown, total };
}

/** A heading count: the number, with "+" when the list it counts is known to be partial. */
export function countLabel(count: number, partial: boolean): string {
  return partial ? `${count}+` : String(count);
}
