/**
 * The CLI's argument grammar, on its own so it can be tested without importing `cli.ts` (whose
 * module body runs `main()`).
 *
 *   positional        -> `_`
 *   --flag            -> flags.flag = true
 *   --flag=value      -> flags.flag = "value"   (split at the first `=`)
 *   --flag value      -> flags.flag = "value"   (any next token not starting with `--`)
 *   --no-flag         -> flags.flag = false
 *
 * Destructive commands also map their flags here (`parseGcFlags`) rather than inline in `cli.ts`,
 * so the wiring is tested: B-109's `--no-flag` change left `gc` reading a `no-backup` key that no
 * longer existed, and nothing noticed because nothing could run it.
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
    // `--flag=value`. Unsplit, `nooklet gc --dry-run=true` was a flag named "dry-run=true", so gc
    // saw no --dry-run and ran for real: the flag meant to make it safe did the opposite.
    const eq = key.indexOf("=");
    if (eq > 0) {
      flags.set(key.slice(0, eq), key.slice(eq + 1));
      continue;
    }
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

/** A flag the command cannot use as given; `cli.ts` prints the message and exits 1. */
export class CliArgError extends Error {}

/** Throws `CliArgError` naming every flag outside `known`. For commands where a typo must stop
 * the run instead of being ignored (`gc`, `restore`). */
export function checkFlags(args: Args, known: readonly string[]): void {
  const unknown = [...args.flags.keys()].filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new CliArgError(
      `unknown flag${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `--${k}`).join(", ")}`,
    );
  }
}

/** A yes/no flag: bare, `--no-x`, or `--x=true|false` (also yes/no, 1/0). Anything else throws. */
export function booleanFlag(args: Args, name: string, fallback: boolean): boolean {
  const v = args.flags.get(name);
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  const s = v.toLowerCase();
  if (s === "true" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "no" || s === "0") return false;
  throw new CliArgError(`--${name} is a yes/no flag; got "${v}"`);
}

export interface GcFlags {
  dryRun: boolean;
  noBackup: boolean;
  assetGraceDays: number | undefined;
}

/**
 * What every single-graph command reads through `cli.ts`'s `dataDir()` / `graphIdFlag()` (and so
 * through `open()`): `--data <dir>` and `--graph <id>` (ADR 025). Every strict allowlist below
 * starts from these. B-671: `RESTORE_FLAGS` was written before ADR 025 added `--graph`, so
 * `restore --graph <id>` was refused as an unknown flag even though the restore case reads it —
 * and per-graph nightly backups could only be restored into `default`. `gc` and `repair` had the
 * same hole. `cli-flag-audit.test.ts` now cross-checks each allowlist against what its case reads.
 */
export const GRAPH_COMMAND_FLAGS = ["data", "graph"] as const;

export const GC_FLAGS = [...GRAPH_COMMAND_FLAGS, "dry-run", "backup", "asset-grace"] as const;
export const RESTORE_FLAGS = [...GRAPH_COMMAND_FLAGS, "force"] as const;
/** `nooklet graph <sub>`: each subcommand's own flags (B-713). `graph` takes `--data` only, never
 * `--graph`: the graph is the positional argument. A typo must stop a command that moves folders. */
export const GRAPH_SUBCOMMAND_FLAGS = {
  create: ["data", "label"],
  list: ["data", "retired"],
  retire: ["data", "force"],
  unretire: ["data", "as"],
  replace: ["data", "from"],
} as const satisfies Record<string, readonly string[]>;
/** Every flag any `graph` subcommand reads; what `cli-flag-audit.test.ts` checks the case against. */
export const GRAPH_FLAGS = [...new Set(Object.values(GRAPH_SUBCOMMAND_FLAGS).flat())] as const;

/** `nooklet pair` (B-655). */
export const PAIR_FLAGS = [...GRAPH_COMMAND_FLAGS, "link", "scope", "sync", "minutes"] as const;

/** `nooklet gc [--dry-run] [--no-backup] [--asset-grace <days>] [--data <dir>]`. */
export function parseGcFlags(args: Args): GcFlags {
  checkFlags(args, GC_FLAGS);
  const grace = args.flags.get("asset-grace");
  let assetGraceDays: number | undefined;
  if (grace !== undefined) {
    assetGraceDays = typeof grace === "string" && grace.trim() !== "" ? Number(grace) : Number.NaN;
    if (!(Number.isFinite(assetGraceDays) && assetGraceDays >= 0)) {
      throw new CliArgError("--asset-grace takes a number of days (0 or more)");
    }
  }
  return {
    dryRun: booleanFlag(args, "dry-run", false),
    noBackup: !booleanFlag(args, "backup", true),
    assetGraceDays,
  };
}

export const REPAIR_FLAGS = [...GRAPH_COMMAND_FLAGS, "apply", "dry-run"] as const;

export interface RepairFlags {
  what: "org-dates";
  apply: boolean;
}

/** `nooklet repair org-dates [--apply] [--data <dir>]`. A dry run unless `--apply` says otherwise.
 * A typo'd flag, an unknown repair, or `--apply` together with `--dry-run` stops the run before
 * the database is opened: a command that rewrites blocks must do exactly what was asked. */
export function parseRepairFlags(args: Args): RepairFlags {
  checkFlags(args, REPAIR_FLAGS);
  const [, what, ...extra] = args._;
  if (what !== "org-dates" || extra.length > 0) {
    throw new CliArgError(
      `unknown repair "${args._.slice(1).join(" ")}" (expected: nooklet repair org-dates [--apply])`,
    );
  }
  const apply = booleanFlag(args, "apply", false);
  const dryRun = booleanFlag(args, "dry-run", !apply);
  if (apply === dryRun) {
    throw new CliArgError(
      apply
        ? "--apply and --dry-run contradict each other; pass one"
        : "--no-dry-run does not write; pass --apply to write",
    );
  }
  return { what, apply };
}

/** True for `--help`, `-h` or `help` in any position — checked before any command opens a graph
 * (B-146). `-h` is not a `--` flag, so `parseArgs` would file it as a positional; look at argv. */
export function wantsHelp(args: Args, argv: readonly string[]): boolean {
  return args.flags.has("help") || argv.includes("-h") || args._[0] === "help";
}
