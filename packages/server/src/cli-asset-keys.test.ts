/**
 * B-737 / ADR 036 through the real CLI (`tsx src/cli.ts`, as `pnpm nooklet` runs it): a Logseq
 * import gives every imported asset its own URL key, and `nooklet asset rotate-key` replaces one
 * asset's key or every asset's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkgDir, "node_modules", ".bin", "tsx");
const cli = join(pkgDir, "src", "cli.ts");

function env(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, NOOKLET_DATA: dataDir, NODE_ENV: "production" };
}

function run(dataDir: string, ...args: string[]): string {
  return execFileSync(tsx, [cli, ...args, "--data", dataDir], {
    cwd: pkgDir,
    env: env(dataDir),
    encoding: "utf8",
  });
}

function fail(dataDir: string, ...args: string[]): string {
  const r = spawnSync(tsx, [cli, ...args, "--data", dataDir], {
    cwd: pkgDir,
    env: env(dataDir),
    encoding: "utf8",
  });
  expect(r.status, r.stdout).toBe(1);
  return r.stderr;
}

/** A tiny Logseq file graph with three pictures in `assets/`, as an import would find it. */
function graphWithAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-asset-keys-src-"));
  mkdirSync(join(dir, "pages"));
  mkdirSync(join(dir, "assets"));
  const lines: string[] = [];
  for (const name of ["one", "two", "three"]) {
    writeFileSync(join(dir, "assets", `${name}.png`), `not really a png: ${name}`);
    lines.push(`- ![${name}](../assets/${name}.png)`);
  }
  writeFileSync(join(dir, "pages", "Garden photos.md"), `${lines.join("\n")}\n`);
  return dir;
}

function keys(dataDir: string): Map<string, string> {
  const db = new DatabaseSync(join(dataDir, "graphs", "default", "graph.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = db.prepare("SELECT id, url_key FROM asset ORDER BY id").all();
    return new Map(rows.map((r) => [String(r.id), String(r.url_key)]));
  } finally {
    db.close();
  }
}

describe("nooklet asset rotate-key (B-737)", () => {
  it("an import keys every asset; rotate-key <id> changes one, --all changes every one", () => {
    const data = mkdtempSync(join(tmpdir(), "nooklet-asset-keys-"));
    run(data, "import", graphWithAssets());
    const before = keys(data);
    expect(before.size).toBe(3);
    for (const k of before.values()) expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(before.values()).size).toBe(3);

    const [first, second] = [...before.keys()] as [string, string];
    expect(run(data, "asset", "rotate-key", first)).toMatch(/rotated the URL key of 1 asset/);
    const once = keys(data);
    expect(once.get(first)).not.toBe(before.get(first));
    expect(once.get(second)).toBe(before.get(second));

    expect(run(data, "asset", "rotate-key", "--all")).toMatch(/rotated the URL key of 3 asset/);
    const all = keys(data);
    for (const [id, k] of all) expect(k, id).not.toBe(once.get(id));
  }, 60_000);

  it("refuses a missing or ambiguous target, an unknown id, and an unknown flag", () => {
    const data = mkdtempSync(join(tmpdir(), "nooklet-asset-keys-"));
    run(data, "import", graphWithAssets());
    const id = [...keys(data).keys()][0] as string;
    expect(fail(data, "asset", "rotate-key")).toMatch(/exactly one of/);
    expect(fail(data, "asset", "rotate-key", id, "--all")).toMatch(/exactly one of/);
    expect(fail(data, "asset", "rotate-key", "zzzzzzzzzzzzzz")).toMatch(/no live asset/);
    expect(fail(data, "asset", "rotate-key", "--every")).toMatch(/every/);
    expect(fail(data, "asset", "spin")).toMatch(/unknown asset subcommand/);
  }, 60_000);
});
