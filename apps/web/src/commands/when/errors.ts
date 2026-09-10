/** Thrown by `compileWhen` for either a grammar syntax error or the R6 "bare identifier of a
 * non-boolean context variable" semantic error. Both are registration/load-time failures (R10) —
 * never thrown by `evaluateWhen`, which is total. */
export class WhenClauseError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly pos: number,
  ) {
    super(`${message} (at offset ${pos} in \`${source}\`)`);
    this.name = "WhenClauseError";
  }
}
