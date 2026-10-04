/**
 * B-713 through the real CLI (`tsx src/cli.ts`, as `pnpm nooklet` runs it), in throwaway data dirs:
 * `graph retire`, `graph list --retired`, `graph unretire [--as]`, `graph replace --from`, and the
 * refusals that matter: "default" without --force, and any of them while a `serve` holds the dir.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkgDir, "node_modules", ".bin", "tsx");
const cli = join(pkgDir, "src", "cli.ts");
/** Inside the 6560-6564 range this repo's agents may use. */
const SERVE_PORT = 6561;

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

/** Runs a command expected to fail; returns its stderr. */
function fail(dataDir: string, ...args: string[]): string {
  const r = spawnSync(tsx, [cli, ...args, "--data", dataDir], {
    cwd: pkgDir,
    env: env(dataDir),
    encoding: "utf8",
  });
  expect(r.status, r.stdout).toBe(1);
  return r.stderr;
}

function logseqGraph(page: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-src-"));
  mkdirSync(join(dir, "pages"));
  writeFileSync(join(dir, "pages", `${page}.md`), `- a block on ${page}\n`);
  return dir;
}

function pageNames(dataDir: string, graph: string): string[] {
  const db = new DatabaseSync(join(dataDir, "graphs", graph, "graph.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT name FROM page WHERE journal_day IS NULL ORDER BY name").all();
    return rows.map((r) => String(r.name));
  } finally {
    db.close();
  }
}

describe("nooklet graph retire / unretire / list --retired (B-713)", () => {
  it("retires a graph, lists it, brings it back with its data, and verify is clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-cli-"));
    run(dir, "graph", "create", "work", "--label", "Work");
    run(dir, "import", logseqGraph("Work Page"), "--graph", "work");

    const out = run(dir, "graph", "retire", "work");
    const name = /graph unretire (work-\d{8}T\d{6}Z)/.exec(out)?.[1] as string;
    expect(name).toBeDefined();
    expect(out).toContain(join(dir, "graphs-retired", name));
    expect(out).toMatch(/Nothing was deleted/);
    expect(existsSync(join(dir, "graphs", "work"))).toBe(false);
    expect(run(dir, "graph", "list")).not.toMatch(/^work\t/m);
    expect(run(dir, "graph", "list", "--retired")).toMatch(
      new RegExp(`^${name}\\twork\\t\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z\\tWork$`, "m"),
    );

    run(dir, "graph", "unretire", name);
    expect(pageNames(dir, "work")).toEqual(["Work Page"]);
    expect(run(dir, "graph", "list")).toMatch(/^work\tWork$/m);
    expect(run(dir, "graph", "list", "--retired")).toBe("");
    expect(run(dir, "verify", "--graph", "work")).toMatch(/ok/i);
  }, 120_000);

  it("refuses default without --force, unknown flags, and unretire over an existing graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-cli-"));
    run(dir, "graph", "create", "work");
    expect(fail(dir, "graph", "retire", "default")).toMatch(/refusing to retire "default"/);
    expect(existsSync(join(dir, "graphs", "default", "graph.sqlite"))).toBe(true);
    expect(fail(dir, "graph", "retire", "work", "--as", "x")).toMatch(/unknown flag --as/);
    expect(fail(dir, "graph", "retire", "nope")).toMatch(/no graph called "nope"/);

    const name = /unretire (\S+)/.exec(run(dir, "graph", "retire", "work"))?.[1] as string;
    run(dir, "graph", "create", "work");
    expect(fail(dir, "graph", "unretire", name)).toMatch(/already exists/);
    expect(run(dir, "graph", "unretire", name, "--as", "work-old")).toMatch(/restored "work-old"/);
    expect(run(dir, "graph", "list")).toMatch(/^work-old\t/m);

    expect(run(dir, "graph", "retire", "default", "--force")).toMatch(/retired "default"/);
  }, 120_000);

  it("refuses retire/replace while a serve holds the data dir; the API retires instead, and unretire works live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-cli-"));
    run(dir, "graph", "create", "work");
    run(dir, "import", logseqGraph("Live Page"), "--graph", "work");
    const proc = spawn(
      tsx,
      [cli, "serve", "--data", dir, "--port", String(SERVE_PORT), "--no-mirror", "--no-web"],
      { cwd: pkgDir, env: env(dir) },
    );
    try {
      const lock = join(dir, "serve.pid");
      for (let i = 0; i < 200 && !existsSync(lock); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(lock)).toBe(true);
      for (const args of [
        ["graph", "retire", "work"],
        ["graph", "replace", "work", "--from", dir],
      ]) {
        const err = fail(dir, ...args);
        expect(err).toMatch(/nooklet server \(pid \d+/);
        expect(err).toMatch(/Stop the server, or use the API: DELETE \/graphs\/<id>/);
      }
      expect(existsSync(join(dir, "graphs", "work"))).toBe(true);

      // The real server, retiring through its own API.
      const base = `http://127.0.0.1:${SERVE_PORT}`;
      const root = readFileSync(join(dir, "root.token"), "utf8").trim();
      expect((await fetch(`${base}/g/work/healthz`)).status).toBe(200);
      const res = await fetch(`${base}/graphs/work`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${root}` },
      });
      expect(res.status).toBe(200);
      const { retired } = (await res.json()) as { retired: string };
      expect((await fetch(`${base}/g/work/healthz`)).status).toBe(404);

      // Bringing it back needs no restart.
      expect(run(dir, "graph", "unretire", retired)).toMatch(/restored "work"/);
      expect((await fetch(`${base}/g/work/healthz`)).status).toBe(200);
      expect(pageNames(dir, "work")).toEqual(["Live Page"]);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
    // A clean stop removes the file.
    for (let i = 0; i < 50 && existsSync(join(dir, "serve.pid")); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(join(dir, "serve.pid"))).toBe(false);
    // A serve that died without cleaning up (SIGKILL) leaves a pid nobody has: stale, ignored.
    writeFileSync(
      join(dir, "serve.pid"),
      JSON.stringify({ pid: 2 ** 22 + 7, hostname: hostname(), startedAt: "x" }),
    );
    expect(run(dir, "graph", "retire", "work")).toMatch(/retired "work"/);
  }, 120_000);

  it("graph replace --from: swaps in a re-import, keeps the old tokens, retires the old graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-retire-cli-"));
    run(dir, "graph", "create", "work", "--label", "Work");
    run(dir, "import", logseqGraph("Before"), "--graph", "work");
    run(dir, "token", "create", "--label", "phone", "--sync", "--graph", "work");

    const scratch = mkdtempSync(join(tmpdir(), "nooklet-retire-scratch-"));
    run(scratch, "import", logseqGraph("After"));

    const out = run(dir, "graph", "replace", "work", "--from", scratch);
    expect(out).toMatch(/replaced "work" .* \(1 token carried over\)/);
    expect(out).toMatch(/Discard the local copy and re-sync/);
    expect(pageNames(dir, "work")).toEqual(["After"]);
    expect(run(dir, "token", "list", "--graph", "work")).toMatch(/phone/);
    expect(run(dir, "graph", "list")).toMatch(/^work\tWork$/m);
    expect(run(dir, "graph", "list", "--retired")).toMatch(/^work-\d{8}T\d{6}Z\twork\t/m);
    expect(run(dir, "verify", "--graph", "work")).toMatch(/ok/i);
  }, 120_000);
});
