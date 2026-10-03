/**
 * B-607, end to end through the real CLI: on a fresh data dir, a command run BEFORE the first
 * `nooklet serve` (the owner's runbook: mint tokens, import a graph, then serve) used to leave
 * `graphs/default/graph.sqlite` without `graph.json`, and `serve` then died with
 * `a graph called "default" already exists`. Spawns `tsx src/cli.ts` exactly as `pnpm nooklet`
 * does, because the bug lived in how separate CLI processes leave the data dir for each other.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkgDir, "node_modules", ".bin", "tsx");
const cli = join(pkgDir, "src", "cli.ts");

function run(dataDir: string, ...args: string[]): string {
  return execFileSync(tsx, [cli, ...args, "--data", dataDir], {
    cwd: pkgDir,
    env: { ...process.env, NOOKLET_DATA: dataDir, NODE_ENV: "production" },
    encoding: "utf8",
  });
}

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGTERM");
  child = undefined;
});

/** Starts `serve` on an OS-picked port; resolves with the port once it prints its banner, rejects
 * with its stderr if it exits first (which is what B-607 looked like). */
function serve(dataDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      tsx,
      [cli, "serve", "--data", dataDir, "--port", "0", "--no-mirror", "--no-web"],
      { cwd: pkgDir, env: { ...process.env, NODE_ENV: "production" } },
    );
    child = proc;
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) resolve(Number(m[1]));
    });
    proc.stderr?.on("data", (d) => {
      err += d;
    });
    proc.on("exit", (code) => reject(new Error(`serve exited ${code}: ${err}`)));
  });
}

describe("first run: a command before the first serve (B-607)", () => {
  it("token create, then serve: serve starts and the token works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-first-run-"));
    const token = run(dir, "token", "create", "--label", "phone", "--scope", "write", "--sync")
      .split("\n")[0]
      ?.trim();
    expect(token).toMatch(/^nk/);
    const port = await serve(dir);
    const res = await fetch(`http://127.0.0.1:${port}/g/default/api/v1/graph.overview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  }, 60_000);

  it("token create --link prints a pairing link carrying that token (B-603), and a bad --link mints nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-first-run-"));
    const out = run(
      dir,
      "token",
      "create",
      "--label",
      "phone",
      "--scope",
      "write",
      "--sync",
      "--link",
      "http://192.168.1.5:6100",
    );
    const token = out.split("\n")[0]?.trim();
    const link = /nooklet:\/\/connect\?\S+/.exec(out)?.[0];
    expect(link).toBeDefined();
    const parsed = new URL(link as string);
    expect(parsed.searchParams.get("url")).toBe("http://192.168.1.5:6100/g/default");
    expect(parsed.searchParams.get("token")).toBe(token);

    expect(() => run(dir, "token", "create", "--label", "x", "--link", "ftp://h")).toThrow();
    const list = run(dir, "token", "list");
    expect(list).toContain("phone");
    expect(list).not.toMatch(/ x\n/);
  }, 60_000);

  it("import, then serve: serve starts and the imported page is there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nooklet-first-run-"));
    const graph = mkdtempSync(join(tmpdir(), "nooklet-first-run-graph-"));
    mkdirSync(join(graph, "pages"));
    writeFileSync(join(graph, "pages", "Imported Page.md"), "- hello from the import\n");
    run(dir, "import", graph);
    const token = run(dir, "token", "create", "--label", "t", "--scope", "read")
      .split("\n")[0]
      ?.trim();
    const port = await serve(dir);
    const res = await fetch(`http://127.0.0.1:${port}/g/default/api/v1/page.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { name: string }[] };
    expect(body.items.map((p) => p.name)).toContain("Imported Page");
  }, 60_000);
});
