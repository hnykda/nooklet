/**
 * `compileWhen` = grammar parse (parser.ts) + the R6 registration-time semantic check ("a bare
 * Identifier is an error ... for a non-boolean variable such as `platform` used bare") + the R10
 * per-process cache ("parsing happens once per distinct `when` string; the resulting AST is
 * cached in a `Map<string, CompiledWhen>` for the process lifetime").
 */
import { WHEN_CONTEXT_FIELD_TYPES, type WhenNode } from "../types.js";
import { WhenClauseError } from "./errors.js";
import { parseWhen } from "./parser.js";

/** Walk the AST for bare `{ t: 'ident' }` nodes and reject one that names a *known* `WhenContext`
 * field whose type is not boolean (R6). An identifier this build doesn't recognize at all is NOT
 * an error here — R8 says unknown identifiers are valid and simply evaluate falsy at runtime. */
function validateBareIdentifiers(node: WhenNode, src: string): void {
  switch (node.t) {
    case "or":
    case "and":
      validateBareIdentifiers(node.left, src);
      validateBareIdentifiers(node.right, src);
      return;
    case "not":
      validateBareIdentifiers(node.node, src);
      return;
    case "eq":
    case "neq":
      // Identifier used in a Comparison is never bare-truthy-tested, so it's exempt: `platform ==
      // 'mac'` is valid even though `platform` alone would not be.
      return;
    case "ident": {
      if (node.name === "true" || node.name === "false") return;
      const type = (WHEN_CONTEXT_FIELD_TYPES as Record<string, string | undefined>)[node.name];
      if (type !== undefined && type !== "boolean") {
        throw new WhenClauseError(
          `bare identifier '${node.name}' is a non-boolean context variable (type '${type}') and ` +
            "cannot be used without a comparison (e.g. write `platform == 'mac'`, not `platform`)",
          src,
          0,
        );
      }
      return;
    }
  }
}

const cache = new Map<string, WhenNode>();

/** Parse + validate `src`, memoized for the process lifetime (R10). Throws `WhenClauseError` for
 * either a syntax error or the bare-non-boolean-identifier error; never returns a partial/invalid
 * AST. Call sites (command registration, keybinding load) are responsible for attaching "which
 * command/row" context to a caught error, per R10's "a diagnostic naming the offending command or
 * keybinding row." */
export function compileWhen(src: string): WhenNode {
  const cached = cache.get(src);
  if (cached) return cached;
  const node = parseWhen(src);
  validateBareIdentifiers(node, src);
  cache.set(src, node);
  return node;
}

/** Test-only: clear the compile cache so tests don't leak `when` strings across each other via a
 * shared module-level Map (a syntax error on `"x"` in one test must not be masked by another
 * test's earlier valid compile of the same string, and vice versa — the cache never expires
 * within a process otherwise). */
export function __clearWhenCompileCacheForTests(): void {
  cache.clear();
}
