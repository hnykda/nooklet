/**
 * Numbered-block display ordinals (`docs/spec/markdown-grammar.md` OUT-17): a block's ordinal is
 * 1 plus the count of *immediately preceding* siblings that also carry `list:: number`
 * contiguously — a non-numbered sibling resets the count. This is purely a rendering rule (never
 * stored), recomputed at render time from sibling order, so it is a plain, DOM-free function over
 * a list of siblings in order.
 *
 * `list:: number` lives in the generic `block_prop` bag ("list is NOT reserved"). For a long time
 * nothing projected that bag to the client, so `BlockTree.tsx` hard-coded "not numbered" and 700
 * numbered lines in the owner's graph rendered as plain bullets (B-100). The worker's page tree
 * now carries `properties`, and `isNumbered` below reads it.
 */
import type { EditableBlock } from "./types.js";

/** OUT-17: only the value `number` means anything in v1; other `list` values are kept verbatim
 * for future list styles but render as ordinary bullets. */
export function isNumbered(block: Pick<EditableBlock, "properties"> | undefined): boolean {
  return block?.properties.list === "number";
}

/** Ordinals for one sibling group, in order. `siblingIds[i]` is numbered iff `numbered(id)`. */
export function deriveNumbering(
  siblingIds: readonly string[],
  numbered: (id: string) => boolean,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  let run = 0;
  for (const id of siblingIds) {
    if (numbered(id)) {
      run += 1;
      out.set(id, run);
    } else {
      run = 0;
    }
  }
  return out;
}
