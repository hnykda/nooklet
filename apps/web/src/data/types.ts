import type { BlockRow, PageRow, Properties } from "@nooklet/core";

export interface BlockTreeNode extends BlockRow {
  /** The block's generic `block_prop` rows with a value (`list:: number`, `author:: …`) — never the
   * reserved keys, which are `BlockRow` columns. Core's `BlockRow` does not carry these (the server
   * shares that type and reads properties its own way), so the client tree adds them: without
   * them numbered lists could not render and property chips had nothing to show (B-100, B-101). */
  properties: Readonly<Properties>;
  children: BlockTreeNode[];
}

export interface PageTreeResult {
  page: PageRow;
  blocks: BlockTreeNode[];
}

export interface JournalDayEntry {
  day: number;
  /** `null` for today when it has no page yet (PLAN.md §8: "a journal page is created only when
   * it gets a block" — today is still shown, virtual, at the top of the stream). */
  page: PageRow | null;
  blocks: BlockTreeNode[];
}

/** The `onNavigate` payload shape promised by `../editor/BlockTree.jsx`/`InlineContent.jsx`'s
 * interface (task brief's "Interfaces already promised to you"). Defined once here so views,
 * routes, and the editor stub all agree on it without duplicating the union. */
export type NavigateTarget = { kind: "page"; name: string } | { kind: "block"; id: string };

export interface JournalStreamOptions {
  /** YYYYMMDD, always included even if empty (the "virtual until the first block" today page). */
  today: number;
  /** How many earlier non-empty days to include below today. */
  maxDays: number;
}

/** One open task row for the Tasks view (views/TasksView.tsx), joined with its page for grouping
 * and display. Sourced from the local replica: `marker`/`scheduled_day`/`deadline_day`/`due_day`
 * are shared-schema block columns (docs/spec/sql-schema.md rule 1), so — unlike search/backlinks —
 * the Tasks view needs no server round trip. */
export interface TaskRow extends BlockRow {
  pageName: string;
  pageJournalDay: number | null;
}
