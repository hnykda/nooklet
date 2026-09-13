/**
 * `equals` for `BlockTree`'s per-row memos (B-511's per-row half).
 *
 * Every refresh rebuilds the whole block list, so each row's `row` and `block` memo produced a new
 * object and every `BlockRowView` re-ran its prop reads — the marker and priority, the date chips
 * (re-parsing both dates), the property list (re-sorting it) — for all rows, though at most the
 * blocks that changed differ. Comparing field by field lets an unchanged row's memo keep its old
 * object, so nothing under it runs.
 *
 * One level into plain-object values, because a block's `properties` is a record rebuilt on every
 * read. Anything else that is not `===` — an array, a nested object two levels down, a field only
 * one side has — counts as a change, so a field added to `EditableBlock` later can never be
 * silently ignored; at worst it re-renders as before.
 */
export function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!(key in right)) return false;
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (!isPlainRecord(x) || !isPlainRecord(y) || !sameFlat(x, y)) return false;
  }
  return true;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

function sameFlat(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const key of keys) if (!(key in y) || x[key] !== y[key]) return false;
  return true;
}
