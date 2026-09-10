/**
 * `evaluateWhen` (R8-R9): pure and total — given a compiled `WhenNode` and a `WhenContext`
 * snapshot, always returns `true`/`false` and never throws, even for a node built from a `when`
 * string that references a field this build doesn't know about (a typo, or a plugin targeting a
 * future context var).
 */
import type { WhenContext, WhenNode } from "../types.js";

/** Look up an identifier in `ctx`, tolerating names `WhenContext` doesn't declare (R8: unknown
 * identifiers evaluate to `undefined`). `true`/`false` are grammar keywords, not context fields
 * (see tokenizer.ts's note) — resolved directly rather than via context lookup. */
function resolveIdent(name: string, ctx: WhenContext): unknown {
  if (name === "true") return true;
  if (name === "false") return false;
  return (ctx as unknown as Record<string, unknown>)[name];
}

export function evaluateWhen(node: WhenNode, ctx: WhenContext): boolean {
  switch (node.t) {
    case "or":
      return evaluateWhen(node.left, ctx) || evaluateWhen(node.right, ctx);
    case "and":
      return evaluateWhen(node.left, ctx) && evaluateWhen(node.right, ctx);
    case "not":
      return !evaluateWhen(node.node, ctx);
    case "ident":
      // Bare identifier is truthy-tested (R6): "isTask" means "isTask == true" for a boolean
      // field. Using strict `===` against the literal `true` also gives R9's unknown-identifier
      // rule for free: `resolveIdent` returns `undefined` for an unrecognized name, and
      // `undefined === true` is `false`.
      return resolveIdent(node.name, ctx) === true;
    case "eq":
      return resolveIdent(node.ident, ctx) === node.literal;
    case "neq":
      return !(resolveIdent(node.ident, ctx) === node.literal);
    default: {
      // Exhaustiveness guard: WhenNode is a closed union, so this is unreachable for any
      // well-typed AST. Never throw (R8) — fail closed instead.
      return false;
    }
  }
}
