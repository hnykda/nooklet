/**
 * "Has anything else changed this since?" for `batch.undo`'s `keep_later_edits` (B-251).
 *
 * `batch.undo` writes an entity's before-image back last-writer-wins (ADR 013). That is the right
 * default for an agent undoing its own last write, and wrong for a person restoring an old
 * version: a History walk undoes a graph-wide replace to get one page back and used to overwrite
 * every later edit to the 835 blocks the replace had touched, on every page. What decides whether
 * a field may be written back is whether some OTHER batch changed it after the batch being undone,
 * and the `changes` audit log already holds each such batch's before/after image — so the answer
 * is a diff of those images, per field, not a version check on the whole entity (a later collapse
 * toggle must not stop the text from being restored).
 */

import type { SqlDriver } from "@nooklet/core";
import type { BlockChangeSnapshot, PageChangeSnapshot } from "../rows.js";

/** A field name as `batch.undo` writes it back: `place`, `content`, `marker`, `priority`,
 * `collapsed`, `name`, `deleted`, or `prop:<key>`. */
export type UndoField = string;

type Snapshot = PageChangeSnapshot | BlockChangeSnapshot;

function isBlock(s: Snapshot): s is BlockChangeSnapshot {
  return "content" in s;
}

function propFields(
  a: Record<string, string>,
  b: Record<string, string>,
  out: Set<UndoField>,
): void {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) out.add(`prop:${k}`);
  }
}

/** Every field whose value differs between two images of one entity. A missing image (the entity
 * did not exist on that side) differs in every field the other side has. */
export function changedFields(
  entityType: "page" | "block",
  before: Snapshot | null,
  after: Snapshot | null,
): Set<UndoField> {
  const out = new Set<UndoField>();
  if (before === null || after === null) {
    const only = before ?? after;
    const base: UndoField[] =
      entityType === "block"
        ? ["place", "content", "marker", "priority", "collapsed", "deleted"]
        : ["name", "deleted"];
    for (const f of base) out.add(f);
    if (only) for (const k of Object.keys(only.properties)) out.add(`prop:${k}`);
    return out;
  }
  if (isBlock(before) && isBlock(after)) {
    if (
      before.place.pageId !== after.place.pageId ||
      before.place.parentId !== after.place.parentId ||
      before.place.order !== after.place.order
    )
      out.add("place");
    if (before.content !== after.content) out.add("content");
    if (before.marker !== after.marker) out.add("marker");
    if (before.priority !== after.priority) out.add("priority");
    if (before.collapsed !== after.collapsed) out.add("collapsed");
  } else if (!isBlock(before) && !isBlock(after)) {
    if (before.name !== after.name) out.add("name");
  }
  propFields(before.properties, after.properties, out);
  if (before.deleted_at !== after.deleted_at) out.add("deleted");
  return out;
}

function parse(json: string | null): Snapshot | null {
  return json === null ? null : (JSON.parse(json) as Snapshot);
}

/**
 * The fields of one entity that a batch NOT in `ignored` changed after `afterSeq`. `ignored` holds
 * the batch being undone and, for a walk of undos, every batch the walk undoes plus the undo
 * batches it has already written — those are the walk's own steps, not someone's later edit.
 */
export function fieldsChangedLater(
  db: SqlDriver,
  entityType: "page" | "block",
  entityId: string,
  afterSeq: number,
  ignored: ReadonlySet<string>,
): Set<UndoField> {
  const out = new Set<UndoField>();
  const rows = db.all<{ batch_id: string; before_json: string | null; after_json: string | null }>(
    "SELECT batch_id, before_json, after_json FROM changes WHERE entity_type = ? AND entity_id = ? AND seq > ? ORDER BY seq ASC",
    [entityType, entityId, afterSeq],
  );
  for (const r of rows) {
    if (ignored.has(r.batch_id)) continue;
    for (const f of changedFields(entityType, parse(r.before_json), parse(r.after_json))) {
      out.add(f);
    }
  }
  return out;
}
