/**
 * Rules about the client's source that a behaviour test cannot hold on its own, because what they
 * forbid is the NEXT copy of something: each one below was fixed once, and then re-grown on a
 * parallel branch before the fix was merged (B-330).
 *
 * The behaviour behind each rule is tested where it lives — see each `describe`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(srcRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** `file:line: text` for every line of `files` matching `pattern`. */
function offenders(files: readonly string[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    readFileSync(join(srcRoot, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) found.push(`${relative(".", file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

/** The UI: everything that puts text on screen. `data/` builds errors; these render them. */
const UI = ["views", "app", "shell", "editor"].flatMap(sourceFiles);

describe("server calls and their failures (B-330)", () => {
  it("a shown error goes through describeError, never a formatter of its own", () => {
    // Each of these drops an `ApiError`'s hint, and `String(err)` adds "ApiError: " / "TypeError: ".
    // Behaviour: `views/server-errors.test.tsx`, `data/api-client.test.ts`.
    const handRolled =
      /instanceof Error \? \w+\.message : String\(|String\(\w+(\(\))?\.error\)|function errorText\b/;
    expect(offenders(UI, handRolled)).toEqual([]);
  });

  it("batch.undo has one wrapper, refactor-api.ts#undoBatch", () => {
    const all = ["views", "app", "shell", "editor", "data", "commands", "plugins"].flatMap(
      sourceFiles,
    );
    expect(offenders(all, /["']batch\.undo["']/).map((o) => o.split(":")[0])).toEqual([
      "data/refactor-api.ts",
    ]);
  });
});
