/**
 * Tracked source files are plain text: no raw control characters.
 *
 * A literal NUL byte in a string (`${lang}<NUL>${code}` in `editor/render/highlight.ts`, meant as
 * `"\u0000"`) made git, grep and every PR view treat the file as binary — "Bin 0 -> 5168 bytes",
 * "Binary file matches" — so one of the renderer's three `innerHTML` seams could not be reviewed
 * or searched with ordinary tools. Two more had crept into `packages/core/src/query.test.ts` and
 * `packages/server/src/verify.ts` the same way. Write the escape (`\u0000`) instead; it is the same
 * string at runtime. Repo-wide on purpose, from here because this is the suite that caught it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TEXT = /\.(?:[cm]?[jt]sx?|css|html|json|md|ya?ml|toml|sql|rs|swift|sh)$/;
// Tab, line feed and carriage return are text; every other C0 control character is not.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

describe("tracked source files", () => {
  it("contain no raw control characters", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter((f) => TEXT.test(f));
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(repoRoot, file), "latin1");
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      const m = CONTROL.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${file}:${line} (0x${m[0].charCodeAt(0).toString(16).padStart(2, "0")})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
