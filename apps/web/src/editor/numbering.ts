/**
 * Numbered-block display ordinals (`docs/spec/markdown-grammar.md` OUT-17): a block's ordinal is
 * 1 plus the count of *immediately preceding* siblings that also carry `list:: number`
 * contiguously — a non-numbered sibling resets the count. This is purely a rendering rule (never
 * stored), recomputed at render time from sibling order, so it is a plain, DOM-free function over
 * a list of siblings in order.
 *
 * NOTE (data-seam gap, not a bug here): `list:: number` lives in the generic `block_prop` bag,
 * which `@nooklet/core`'s `BlockRow`/`getPageTree` do not yet project to the client (only the
 * reserved columns — marker/priority/collapsed/scheduled/deadline/repeat/done — are exposed,
 * per markdown-grammar's Open issue 6: "list is NOT reserved"). `EditableBlock.listNumber`
 * (`types.ts`) is threaded through end to end and this function is fully correct against it, but
 * until the data seam exposes generic block properties, `BlockTree.tsx` has no source to populate
 * it from and every block renders as `listNumber: false`.
 */

/** Ordinals for one sibling group, in order. `siblingIds[i]` is numbered iff `isNumbered(i)`. */
export function deriveNumbering(
  siblingIds: readonly string[],
  isNumbered: (id: string) => boolean,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  let run = 0;
  for (const id of siblingIds) {
    if (isNumbered(id)) {
      run += 1;
      out.set(id, run);
    } else {
      run = 0;
    }
  }
  return out;
}
