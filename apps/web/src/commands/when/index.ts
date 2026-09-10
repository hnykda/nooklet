export { __clearWhenCompileCacheForTests, compileWhen } from "./compile.js";
export { areProvablyDisjoint } from "./disjoint.js";
export { WhenClauseError } from "./errors.js";
export { evaluateWhen } from "./evaluate.js";
export { parseWhen } from "./parser.js";

import type { WhenContext } from "../types.js";
import { compileWhen } from "./compile.js";
import { evaluateWhen } from "./evaluate.js";

/** Convenience used throughout the registry/keymap/palette: absent `when` means "always enabled"
 * (R5), otherwise compile (cached) + evaluate. This is the one function most other modules in
 * `commands/` should call rather than reaching for `compileWhen`/`evaluateWhen` directly. */
export function matchesWhen(when: string | undefined, ctx: WhenContext): boolean {
  if (when === undefined) return true;
  return evaluateWhen(compileWhen(when), ctx);
}
