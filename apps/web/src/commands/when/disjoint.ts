/**
 * R11 / R67: the conflict detector's conservative "provably disjoint" test. This is NOT a general
 * SAT-style decision procedure (R67 says that's undecidable in general and the checker is
 * deliberately conservative) — it only special-cases the one known mutually-exclusive pair,
 * `(editorFocused, blockSelected)`.
 */
import type { WhenNode } from "../types.js";

/** Known mutually-exclusive `WhenContext` variable pairs (R11). Extend here if a future revision
 * adds more (see spec Open issue 8 re: `isCollapsed`/`!isCollapsed`). */
const EXCLUSIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["editorFocused", "blockSelected"],
];

/**
 * The set of bare identifiers a `when` AST asserts unconditionally at its top level, i.e. every
 * branch of every top-level `&&` chain. We deliberately do NOT descend into `||` (a term inside
 * an OR branch isn't asserted unconditionally by the whole expression) or `!`/`==`/`!=` (negating
 * or comparing a term is not the same as asserting the bare term) — per R11's precise wording:
 * "one clause's top-level conjunction includes the bare identifier X".
 */
function topLevelAndTerms(node: WhenNode): Set<string> {
  if (node.t === "and") {
    const left = topLevelAndTerms(node.left);
    const right = topLevelAndTerms(node.right);
    for (const t of right) left.add(t);
    return left;
  }
  if (node.t === "ident") {
    return new Set([node.name]);
  }
  return new Set();
}

/**
 * Two `when` ASTs are "provably disjoint" (R11) iff one's top-level conjunction contains one side
 * of a known-exclusive pair and not the other, while the other's top-level conjunction contains
 * the other side and not the first — i.e. each clause commits unconditionally to a different,
 * mutually-exclusive mode, with neither clause hedging by also containing the other's term.
 */
export function areProvablyDisjoint(a: WhenNode, b: WhenNode): boolean {
  const termsA = topLevelAndTerms(a);
  const termsB = topLevelAndTerms(b);
  for (const [x, y] of EXCLUSIVE_PAIRS) {
    if (termsA.has(x) && !termsA.has(y) && termsB.has(y) && !termsB.has(x)) return true;
    if (termsA.has(y) && !termsA.has(x) && termsB.has(x) && !termsB.has(y)) return true;
  }
  return false;
}
