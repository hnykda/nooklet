/**
 * B-671: a command's strict flag allowlist (`checkFlags`) and the flags its `cli.ts` case actually
 * reads drifted apart. `restore` read `--graph` through `graphIdFlag(args)` while `RESTORE_FLAGS`
 * lacked it, so `nooklet restore --graph alpha` was refused as an unknown flag; `gc` and `repair`
 * had the same hole through `open(args)`. Nothing caught it because the allowlist is a literal in
 * one file and the reads are scattered through another.
 *
 * This reads the source of `cli.ts` and `cli-args.ts` and cross-checks, in both directions, every
 * command that validates its flags: each flag the case reads must be allowed, and each allowed flag
 * must be read somewhere (a dead entry is a flag the usage text promises and nothing honours).
 * A source scan rather than a runtime spy because `cli.ts` runs `main()` on import.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GC_FLAGS, PAIR_FLAGS, REPAIR_FLAGS, RESTORE_FLAGS } from "./cli-args.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliSrc = readFileSync(join(here, "cli.ts"), "utf8");
const argsSrc = readFileSync(join(here, "cli-args.ts"), "utf8");

/** The body of `case "<cmd>": { ... }` in `main()`'s switch: up to the next top-level case. */
function caseBody(cmd: string): string {
  const start = cliSrc.indexOf(`    case "${cmd}": {`);
  if (start < 0) throw new Error(`no case "${cmd}" in cli.ts`);
  const rest = cliSrc.slice(start + 1);
  const next = rest.search(/\n {4}(case "|default:)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The body of `export function <name>(` in cli-args.ts, up to the next top-level declaration. */
function argsFunctionBody(name: string): string {
  const start = argsSrc.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`no ${name} in cli-args.ts`);
  const rest = argsSrc.slice(start + 1);
  const next = rest.search(/\n(export |\/\*\*|function )/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Flags a piece of source reads, directly or through the helpers that read them. */
function flagsRead(src: string): Set<string> {
  const read = new Set<string>();
  for (const m of src.matchAll(/flags\.(?:get|has)\("([^"]+)"\)/g)) read.add(m[1] as string);
  for (const m of src.matchAll(/booleanFlag\(args, "([^"]+)"/g)) read.add(m[1] as string);
  if (/\bdataDir\(args\)/.test(src)) read.add("data");
  if (/\bgraphIdFlag\(args\)/.test(src)) read.add("graph");
  // `open(args)` reads `--data` and `--graph`. It also builds `baseServerConfig(args)` (`--port`,
  // `--host`, ...), but only `serve` acts on those, so they are not part of a command's grammar.
  if (/\bopen\(args\b/.test(src)) {
    read.add("data");
    read.add("graph");
  }
  for (const parser of ["parseGcFlags", "parseRepairFlags"]) {
    if (src.includes(`${parser}(args)`)) {
      for (const f of flagsRead(argsFunctionBody(parser))) read.add(f);
    }
  }
  return read;
}

const STRICT: Record<string, readonly string[]> = {
  restore: RESTORE_FLAGS,
  gc: GC_FLAGS,
  repair: REPAIR_FLAGS,
  pair: PAIR_FLAGS,
};

describe("strict CLI flag allowlists match what each command reads (B-671)", () => {
  for (const [cmd, allowed] of Object.entries(STRICT)) {
    it(`${cmd}: every flag read is allowed, and every allowed flag is read`, () => {
      const read = flagsRead(caseBody(cmd));
      expect([...read].filter((f) => !allowed.includes(f)).sort()).toEqual([]);
      expect(allowed.filter((f) => !read.has(f)).sort()).toEqual([]);
    });
  }

  it("covers every case in cli.ts that validates its flags", () => {
    const strictCases = [...cliSrc.matchAll(/\n {4}case "([^"]+)": \{/g)]
      .map((m) => m[1] as string)
      .filter((cmd) => /checkFlags\(|parseGcFlags\(|parseRepairFlags\(/.test(caseBody(cmd)));
    expect(strictCases.sort()).toEqual(Object.keys(STRICT).sort());
  });

  it("the scan itself sees --graph through open(), graphIdFlag() and dataDir()", () => {
    // Guards the regexes: if `open(args)` were renamed, the checks above would pass vacuously.
    expect(flagsRead(caseBody("restore"))).toContain("graph");
    expect(flagsRead(caseBody("gc"))).toEqual(new Set([...GC_FLAGS]));
  });
});
