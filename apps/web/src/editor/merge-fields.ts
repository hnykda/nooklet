/**
 * What a Backspace/Delete merge (`commands.ts#mergeWithPrevious`/`#deleteForwardMerge`, R20/R21)
 * must carry from the block that disappears into the block that stays, so the merge never throws
 * data away (B-340).
 *
 * The merges used to write only `block.text` (the two contents joined) and delete the other
 * block. Everything else it held went with it: its task marker, priority, scheduled/deadline/
 * repeat dates and every generic property (`owner:: dan`, `list:: number`). An empty block was
 * deleted outright even when it carried properties. Nothing warned, and only an immediate Cmd+Z
 * brought the data back.
 *
 * The rule: the staying block takes every field it does not have yet — the same thing Logseq's
 * raw-text merge ends up with for properties and dates, since the second block's property lines
 * travel with its text. The marker is carried as a marker, not as the literal word `TODO` at the
 * join point: joined onto an empty block that word would be line 1 of the content, which the
 * markdown mirror writes as `- TODO …` and a re-import reads back as a task, so the database and
 * the file would disagree (the B-342 class of mismatch). When both blocks set the same field to
 * different values there is no value to keep without losing the other, so the merge is refused and
 * the caller says why (`mergeRefusedMessage`). `done` is the exception: a completion timestamp,
 * not something anyone set, so the staying block's own one wins and it never refuses a merge.
 * `collapsed` is view state and stays as it was.
 */
import { formatDoneIso, type OpPayload } from "@nooklet/core";
import type { EditableBlock } from "./types.js";

export interface MergeConflict {
  /** `marker`, `priority`, `scheduled`, `deadline`, `repeat`, or a generic property key. */
  field: string;
  kept: string;
  merged: string;
}

export type CarryResult =
  | { ok: true; payloads: OpPayload[] }
  | { ok: false; conflicts: MergeConflict[] };

const TYPED_FIELDS = ["marker", "priority", "scheduled", "deadline", "repeat"] as const;

/** The `block.prop` payloads that give `into` every field of `from` it lacks, or the fields both
 * set differently. Only ever writes keys `into` does not have, so it can never overwrite. */
export function carryFields(into: EditableBlock, from: EditableBlock): CarryResult {
  const payloads: OpPayload[] = [];
  const conflicts: MergeConflict[] = [];
  const take = (field: string, kept: string | null | undefined, merged: string | null): void => {
    if (merged === null || kept === merged) return;
    if (kept === null || kept === undefined) {
      payloads.push({ kind: "block.prop", key: field, value: merged });
    } else {
      conflicts.push({ field, kept, merged });
    }
  };
  for (const field of TYPED_FIELDS) take(field, into[field], from[field]);
  for (const [key, value] of Object.entries(from.properties)) {
    take(key, Object.hasOwn(into.properties, key) ? into.properties[key] : null, value);
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  if (from.doneAt !== null && into.doneAt === null) {
    payloads.push({ kind: "block.prop", key: "done", value: formatDoneIso(from.doneAt) });
  }
  return { ok: true, payloads };
}

const FIELD_LABEL: Record<string, string> = {
  marker: "task marker",
  priority: "priority",
  scheduled: "scheduled date",
  deadline: "deadline",
  repeat: "repeat",
};

/** The notice for a refused merge: which field, and both values, so the user knows what to change. */
export function mergeRefusedMessage(conflicts: readonly MergeConflict[]): string {
  const parts = conflicts.map(
    (c) => `${FIELD_LABEL[c.field] ?? `${c.field}::`} (${c.kept} / ${c.merged})`,
  );
  return `Not merged: the two blocks have a different ${parts.join(", ")}. Change or remove one first.`;
}
