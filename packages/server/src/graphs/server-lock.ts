/**
 * "Is a `nooklet serve` using this data dir right now?" (B-713), answered with a pid file that
 * `serve` writes once it is listening and removes when it exits.
 *
 * Why not ask SQLite: in WAL mode a second connection opens, reads and writes a database the server
 * holds open without any error, so there is no lock to probe. And why it matters: a CLI that moves
 * `graphs/<id>/` out from under a live server leaves the server's open handle writing into the moved
 * file while clients see the graph vanish (the hand-done swap of 2026-10-04 needed a restart for
 * exactly this reason).
 *
 * Conservative on purpose. A pid file whose process is gone is stale (a crash, a SIGKILL) and is
 * ignored. One whose process exists but is not ours to signal (`EPERM`), or that was written on
 * another host (a container, a network share), counts as live: refusing wrongly costs the operator
 * one `rm`, moving a live graph costs data.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface ServerLock {
  pid: number;
  hostname: string;
  port?: number;
  startedAt: string;
}

export function serverLockPath(dataDir: string): string {
  return join(dataDir, "serve.pid");
}

/** Called by `serve` once it is listening. Returns a remover for the exit path. */
export function writeServerLock(dataDir: string, port?: number): () => void {
  const path = serverLockPath(dataDir);
  const lock: ServerLock = {
    pid: process.pid,
    hostname: hostname(),
    port,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(lock)}\n`);
  return () => {
    // Only our own: a second `serve` on the same dir (which then failed to listen) must not
    // remove the first one's file.
    if (readServerLock(dataDir)?.pid === process.pid) rmSync(path, { force: true });
  };
}

export function readServerLock(dataDir: string): ServerLock | undefined {
  const path = serverLockPath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as ServerLock;
    return typeof lock.pid === "number" ? lock : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live server holding this data dir, if any (see the header for what counts as live). */
export function liveServer(dataDir: string): ServerLock | undefined {
  const lock = readServerLock(dataDir);
  if (!lock) return undefined;
  if (lock.hostname !== hostname()) return lock;
  if (lock.pid === process.pid) return undefined;
  return processAlive(lock.pid) ? lock : undefined;
}

/** The CLI's refusal, in words an operator can act on. */
export function liveServerMessage(dataDir: string, lock: ServerLock): string {
  const where = lock.port ? ` on port ${lock.port}` : "";
  return (
    `a nooklet server (pid ${lock.pid} on ${lock.hostname}${where}, started ${lock.startedAt}) is using ${dataDir}. ` +
    `It keeps each graph's database open, so moving a graph folder underneath it is unsafe. ` +
    `Stop the server, or use the API: DELETE /graphs/<id> with the root token. ` +
    `If no server is running, the file is stale: remove ${serverLockPath(dataDir)}.`
  );
}
