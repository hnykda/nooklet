/**
 * Row shapes for the five in-scope tables (`schema.ts`) and the `applyOps`/`rebuild` result
 * types. These extend, but do not replace, `model.ts`'s `Page`/`Block` (the live-view domain
 * types) the same way `docs/spec/sql-schema.md`'s server-side `PageRow`/`BlockRow` do: a `Row`
 * carries every `_hlc` column and the tombstone columns; the domain type does not.
 */

import type { Priority, TaskMarker } from "../model.js";
import type { OpKind, OpPayload } from "../ops.js";

export interface PageRow {
  id: string;
  graphId: string;
  name: string;
  key: string;
  journalDay: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  nameHlc: string;
  deletedHlc: string | null;
}

export interface BlockRow {
  id: string;
  graphId: string;
  pageId: string;
  parentId: string | null;
  order: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  collapsed: boolean;
  scheduledDay: number | null;
  scheduledTime: string | null;
  deadlineDay: number | null;
  deadlineTime: string | null;
  repeat: string | null;
  doneAt: number | null;
  dueDay: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  placeHlc: string;
  contentHlc: string;
  markerHlc: string | null;
  priorityHlc: string | null;
  collapsedHlc: string | null;
  scheduledHlc: string | null;
  deadlineHlc: string | null;
  repeatHlc: string | null;
  doneHlc: string | null;
  deletedHlc: string | null;
}

export interface PropRow {
  key: string;
  value: string | null;
  hlc: string;
}

export interface OpRow {
  seq: number;
  id: string;
  hlc: string;
  deviceId: string;
  kind: OpKind;
  entity: string;
  payload: OpPayload;
  status: "applied" | "noop" | "rejected";
}

/** Why an op did not change state; present when `status !== 'applied'`. */
export type ApplyReason =
  | "stale"
  | "no-such-page"
  | "no-such-block"
  | "page-key-collision"
  | "cycle"
  | "invalid-marker"
  | "invalid-priority"
  | "invalid-scheduled"
  | "invalid-deadline"
  | "invalid-done"
  | "id-not-writable"
  | "already-recorded";

export interface AppliedOpResult {
  id: string;
  hlc: string;
  kind: OpKind;
  entity: string;
  status: "applied" | "noop" | "rejected";
  reason?: ApplyReason;
}

export interface ApplyOpsResult {
  results: AppliedOpResult[];
  applied: number;
  noop: number;
  rejected: number;
}
