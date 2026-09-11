/**
 * Builds the client, boots a real `nooklet serve` on a throwaway data directory, and waits for it
 * to answer. Deliberately the *production* build served by the *real* server, because that
 * combination is exactly where the bugs the unit suites missed actually live.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.NOOKLET_E2E_PORT ?? 6188);
const STATE = join(tmpdir(), "nooklet-e2e-state.json");

function run(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: repoRoot, stdio: "pipe" });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (${code}):\n${err}`)),
    );
  });
}

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became healthy at ${url}: ${last}`);
}

export default async function globalSetup(): Promise<void> {
  // The served client is a build artifact; stale output would silently test yesterday's code.
  await run("pnpm", ["--filter", "@nooklet/web", "build"], "client build");

  const dataDir = mkdtempSync(join(tmpdir(), "nooklet-e2e-"));
  const log = join(dataDir, "server.log");

  const server = spawn(
    "pnpm",
    [
      "--filter",
      "@nooklet/server",
      "exec",
      "tsx",
      "src/cli.ts",
      "serve",
      "--data",
      dataDir,
      "--port",
      String(PORT),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let out = "";
  const capture = (d: Buffer) => {
    out += d.toString();
    writeFileSync(log, out);
  };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/healthz`);
  } catch (e) {
    server.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`${e}\n--- server output ---\n${out}`);
  }

  writeFileSync(STATE, JSON.stringify({ pid: server.pid, dataDir, port: PORT }));
  server.unref();
}
