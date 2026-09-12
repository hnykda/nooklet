/**
 * The CLI's argument grammar, on its own so it can be tested without importing `cli.ts` (whose
 * module body runs `main()`).
 *
 *   positional        -> `_`
 *   --flag            -> flags.flag = true
 *   --flag value      -> flags.flag = "value"   (any next token not starting with `--`)
 *   --no-flag         -> flags.flag = false
 */

export interface Args {
  _: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      _.push(a);
      continue;
    }
    const key = a.slice(2);
    // `--no-<flag>` is the flag set to false. It used to land as a key called "no-mirror" that
    // nothing read, so `--no-mirror` did nothing (B-109) — unnoticed while `serve` never wrote the
    // mirror, a live bug the moment B-95 made it write.
    if (key.startsWith("no-")) {
      flags.set(key.slice(3), false);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { _, flags };
}
