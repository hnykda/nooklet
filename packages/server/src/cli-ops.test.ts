/**
 * Operator-facing CLI behaviour, end to end through the real `tsx src/cli.ts` (as `pnpm nooklet`
 * runs it), in throwaway data dirs:
 *
 *  - B-671: `restore --graph <id>` was refused as an unknown flag, so a per-graph nightly backup
 *    (`backup --graph alpha`) could not be restored. Round trip with two graphs: only the restored
 *    one changes.
 *  - B-685: `serve` on a port in use died with a raw EADDRINUSE stack trace.
 *  - B-696: no `--version`; the version comes from this package's package.json.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkgDir, "node_modules", ".bin", "tsx");
const cli = join(pkgDir, "src", "cli.ts");
const pkgVersion = (
  JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function run(dataDir: string, ...args: string[]): string {
  return execFileSync(tsx, [cli, ...args, "--data", dataDir], {
    cwd: pkgDir,
    env: { ...process.env, NOOKLET_DATA: dataDir, NODE_ENV: "production" },
    encoding: "utf8",
  });
}

/** A one-page Logseq graph to import. */
function logseqGraph(page: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-cli-ops-src-"));
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

describe("backup/restore one graph of several (B-671)", () => {
  it("backup --graph alpha, change alpha, restore --graph alpha --force: alpha is back, default untouched, both verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-cli-ops-"));
    run(dir, "graph", "create", "alpha", "--label", "Alpha");
    run(dir, "import", logseqGraph("Default Page"));
    run(dir, "import", logseqGraph("Alpha Before"), "--graph", "alpha");
    const defaultBefore = pageNames(dir, "default");
    expect(pageNames(dir, "alpha")).toEqual(["Alpha Before"]);

    const archive = join(dir, "alpha.tar.gz");
    run(dir, "backup", "--graph", "alpha", "--out", archive);
    run(dir, "import", logseqGraph("Alpha After"), "--graph", "alpha");
    expect(pageNames(dir, "alpha")).toEqual(["Alpha After", "Alpha Before"]);

    const out = run(dir, "restore", archive, "--graph", "alpha", "--force");
    expect(out).toContain(join("graphs", "alpha"));
    expect(pageNames(dir, "alpha")).toEqual(["Alpha Before"]);
    expect(pageNames(dir, "default")).toEqual(defaultBefore);
    expect(defaultBefore).toContain("Default Page");

    expect(run(dir, "verify", "--graph", "alpha")).toMatch(/ok/i);
    expect(run(dir, "verify")).toMatch(/ok/i);
  }, 120_000);

  it("restore without --force still refuses to clobber the graph it targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-cli-ops-"));
    run(dir, "graph", "create", "alpha");
    const archive = join(dir, "alpha.tar.gz");
    run(dir, "backup", "--graph", "alpha", "--out", archive);
    const r = spawnSync(tsx, [cli, "restore", archive, "--graph", "alpha", "--data", dir], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to restore");
    expect(r.stderr).not.toContain("unknown flag");
  }, 60_000);
});

describe("serve on a port already in use (B-685)", () => {
  let blocker: Server | undefined;
  afterEach(() => {
    blocker?.close();
    blocker = undefined;
  });

  it("prints one line naming the port and --port, and exits 1 — no stack trace", async () => {
    blocker = createServer();
    const port = await new Promise<number>((resolve) => {
      blocker?.listen(0, "127.0.0.1", () => {
        const addr = blocker?.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "nooklet-cli-ops-"));
    const proc = spawn(
      tsx,
      [cli, "serve", "--data", dir, "--port", String(port), "--no-mirror", "--no-web"],
      { cwd: pkgDir, env: { ...process.env, NODE_ENV: "production" } },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
    expect(code).toBe(1);
    const lines = stderr.split("\n").filter((l) => l.startsWith("nooklet: port"));
    expect(lines).toEqual([
      `nooklet: port ${port} on 127.0.0.1 is in use — stop the other server, or pick another with --port <n>`,
    ]);
    expect(stderr).not.toMatch(/EADDRINUSE|\n\s+at /);
  }, 60_000);
});

describe("the version a running server reports (B-696)", () => {
  let child: ReturnType<typeof spawn> | undefined;
  afterEach(() => {
    child?.kill("SIGTERM");
    child = undefined;
  });

  it("serve's banner and MCP initialize's serverInfo both carry the package version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-cli-ops-"));
    const token = run(dir, "token", "create", "--label", "t", "--scope", "read")
      .split("\n")[0]
      ?.trim();
    const proc = spawn(
      tsx,
      [cli, "serve", "--data", dir, "--port", "0", "--no-mirror", "--no-web"],
      {
        cwd: pkgDir,
        env: { ...process.env, NODE_ENV: "production" },
      },
    );
    child = proc;
    let stdout = "";
    const port = await new Promise<number>((resolve, reject) => {
      proc.stdout?.on("data", (d) => {
        stdout += d;
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
        if (m) resolve(Number(m[1]));
      });
      proc.on("exit", (code) => reject(new Error(`serve exited ${code}`)));
    });
    expect(stdout.split("\n")).toContain(`nooklet ${pkgVersion} serving ${dir}`);

    const res = await fetch(`http://127.0.0.1:${port}/g/default/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = text.trimStart().startsWith("{")
      ? text
      : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice("data:".length);
    const body = JSON.parse(json) as { result: { serverInfo: { name: string; version: string } } };
    expect(body.result.serverInfo).toEqual({ name: "nooklet", version: pkgVersion });

    // Not on the unauthenticated probe: an exact version tells a scanner which bugs to try.
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
    expect(health).not.toContain(pkgVersion);
  }, 60_000);
});

describe("nooklet --version (B-696)", () => {
  for (const flag of ["--version", "-V"]) {
    it(`${flag} prints the package version and opens no data dir`, () => {
      const dir = join(mkdtempSync(join(tmpdir(), "nooklet-cli-ops-")), "never-made");
      const out = execFileSync(tsx, [cli, flag], {
        cwd: pkgDir,
        env: { ...process.env, NOOKLET_DATA: dir },
        encoding: "utf8",
      });
      expect(out).toBe(`nooklet ${pkgVersion}\n`);
      expect(existsSync(dir)).toBe(false);
    }, 60_000);
  }
});
