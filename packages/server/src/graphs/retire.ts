/**
 * Retiring, restoring and replacing a graph on disk (B-713): the procedure that was done by hand on
 * a production server on 2026-10-04, encoded so nobody has to `mv` folders under a running server
 * again.
 *
 * Retiring never deletes. `graphs/<id>/` is renamed to `graphs-retired/<id>-<UTC timestamp>/`,
 * whole (database, WAL, mirror, assets, graph.json), on the same filesystem, so it is one atomic
 * rename and the reverse is one too. Deleting a retired graph is left to the operator's own `rm`.
 *
 * These functions only move folders. They do not know whether a server has the graph open: the CLI
 * checks `server-lock.ts` first, and `GraphRegistry#retire` closes its own handle first. Moving a
 * graph a live server still holds open would leave the server writing to the moved file (an open
 * fd follows the inode) while clients think the graph is gone.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type GraphMeta,
  graphDbPath,
  graphDir,
  graphMetaPath,
  graphsRootDir,
  isValidGraphId,
} from "./paths.js";

/** A retire/unretire/replace that cannot be done as asked; the CLI prints it, the API sends it. */
export class GraphRetireError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid_request",
  ) {
    super(message);
  }
}

export function retiredRootDir(dataDir: string): string {
  return join(dataDir, "graphs-retired");
}

/** Where `graph replace` stages the incoming copy: beside `graphs/`, on the same filesystem (so the
 * final step is a rename), and outside it (so `GraphRegistry#list` never sees a half-copied graph). */
function incomingRootDir(dataDir: string): string {
  return join(dataDir, "graphs-incoming");
}

/** `20261004T153012Z`: UTC, sortable, and no `:` (not allowed in a Windows path, awkward in a shell). */
export function retireTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

const RETIRED_NAME = /^(.+)-(\d{8}T\d{6}Z)(?:-(\d+))?$/;

export interface RetiredGraph {
  /** The folder name under `graphs-retired/`; what `unretire` takes. */
  name: string;
  /** The id it was served under. */
  id: string;
  /** When it was retired (from the name), ISO 8601. */
  retiredAt: string;
  label?: string;
  path: string;
}

export function parseRetiredName(name: string): { id: string; retiredAt: string } | undefined {
  const m = RETIRED_NAME.exec(name);
  if (!m) return undefined;
  const ts = m[2] as string;
  const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
  return { id: m[1] as string, retiredAt: iso };
}

function readMeta(dir: string): GraphMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")) as GraphMeta;
  } catch {
    return undefined;
  }
}

export interface RetireResult {
  id: string;
  retiredName: string;
  path: string;
}

export interface RetireOptions {
  /** Allow retiring "default". Off by default: the bare server address redirects to it, so every
   * client stored without `/g/<id>` loses its graph. */
  force?: boolean;
  now?: Date;
}

/** Move `graphs/<id>/` to `graphs-retired/<id>-<timestamp>/`. Throws `GraphRetireError`. */
export function retireGraph(dataDir: string, id: string, opts: RetireOptions = {}): RetireResult {
  if (!isValidGraphId(id)) {
    throw new GraphRetireError(`"${id}" is not a valid graph id`, "invalid_request");
  }
  const from = graphDir(dataDir, id);
  if (!existsSync(from)) {
    throw new GraphRetireError(`no graph called "${id}" in ${dataDir}`, "not_found");
  }
  if (id === "default" && !opts.force) {
    throw new GraphRetireError(
      `refusing to retire "default" without --force: the bare server address redirects to it, so every device that stored the address without /g/<id> loses its graph`,
      "conflict",
    );
  }
  const root = retiredRootDir(dataDir);
  mkdirSync(root, { recursive: true });
  const base = `${id}-${retireTimestamp(opts.now ?? new Date())}`;
  // Two retires of the same id within one second (a scripted swap) must not collide.
  let name = base;
  for (let n = 2; existsSync(join(root, name)); n++) name = `${base}-${n}`;
  const to = join(root, name);
  renameSync(from, to);
  return { id, retiredName: name, path: to };
}

export function listRetired(dataDir: string): RetiredGraph[] {
  const root = retiredRootDir(dataDir);
  if (!existsSync(root)) return [];
  const out: RetiredGraph[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const parsed = parseRetiredName(e.name);
    if (!parsed) continue;
    const path = join(root, e.name);
    out.push({ name: e.name, ...parsed, label: readMeta(path)?.label, path });
  }
  return out.sort((a, b) => a.retiredAt.localeCompare(b.retiredAt) || a.name.localeCompare(b.name));
}

export interface UnretireResult {
  id: string;
  from: string;
  path: string;
}

/** Move `graphs-retired/<name>/` back to `graphs/<as ?? original id>/`. Never overwrites a graph. */
export function unretireGraph(dataDir: string, name: string, as?: string): UnretireResult {
  // A name is one path segment; refuse anything that could step outside `graphs-retired/`.
  const parsed = name.includes("/") || name.includes("\\") ? undefined : parseRetiredName(name);
  const from = join(retiredRootDir(dataDir), name);
  if (!parsed || !existsSync(from)) {
    throw new GraphRetireError(
      `no retired graph called "${name}" (see: nooklet graph list --retired)`,
      "not_found",
    );
  }
  const id = as ?? parsed.id;
  if (!isValidGraphId(id)) {
    throw new GraphRetireError(`"${id}" is not a valid graph id`, "invalid_request");
  }
  const to = graphDir(dataDir, id);
  if (existsSync(to)) {
    throw new GraphRetireError(
      `a graph called "${id}" already exists; retire it first, or bring this one back under another id with --as <id>`,
      "conflict",
    );
  }
  mkdirSync(graphsRootDir(dataDir), { recursive: true });
  renameSync(from, to);
  // graph.json carries the id; a graph brought back under a new one must list as that id.
  const meta = readMeta(to);
  if (meta && meta.id !== id) {
    writeFileSync(graphMetaPath(dataDir, id), JSON.stringify({ ...meta, id }, null, 2));
  }
  return { id, from, path: to };
}

/**
 * The graph folder inside `from`: `from` itself when it holds a `graph.sqlite`, else
 * `from/graphs/<id>/`, else `from/graphs/default/` (a scratch data dir imported with no --graph).
 */
export function resolveSourceGraphDir(from: string, id: string): string {
  const abs = resolve(from);
  for (const dir of [abs, join(graphsRootDir(abs), id), join(graphsRootDir(abs), "default")]) {
    if (existsSync(join(dir, "graph.sqlite"))) return dir;
  }
  throw new GraphRetireError(
    `no graph in ${abs} (expected ${join(abs, "graph.sqlite")}, or graphs/${id}/ or graphs/default/ under it)`,
    "not_found",
  );
}

/**
 * Copy every `token` row from `oldDb` into `newDb` that `newDb` does not already have, so devices
 * paired with the old graph keep working against the replacement. Tokens live inside the graph's
 * own database (ADR 025), so a fresh import starts with none. Columns are matched by name, so a
 * replacement built by a newer nooklet (more columns, defaults) still takes the rows.
 *
 * Device rows are deliberately not carried: they describe replicas of the OLD graph, and every
 * device has to re-sync from scratch anyway (a new graph instance id, B-631/B-633).
 */
export function carryTokens(oldDb: string, newDb: string): number {
  const db = new DatabaseSync(newDb);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("ATTACH DATABASE ? AS old").run(oldDb);
    const cols = (schema: string): string[] =>
      db
        .prepare(`PRAGMA ${schema}.table_info(token)`)
        .all()
        .map((r) => String(r.name));
    const oldCols = new Set(cols("old"));
    const shared = cols("main").filter((c) => oldCols.has(c));
    if (shared.length === 0) return 0;
    const list = shared.map((c) => `"${c}"`).join(", ");
    const r = db
      .prepare(`INSERT OR IGNORE INTO main.token (${list}) SELECT ${list} FROM old.token`)
      .run();
    db.exec("DETACH DATABASE old");
    // Fold the WAL into the main file before the folder moves: no reader of the moved copy should
    // depend on a `-wal` beside it.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Number(r.changes);
  } finally {
    db.close();
  }
}

export interface ReplaceResult {
  id: string;
  tokensCarried: number;
  retired: RetireResult;
  path: string;
  source: string;
}

/**
 * Swap `graphs/<id>/` for the graph in `from` (usually a scratch data dir something was imported
 * into): copy it in beside `graphs/`, carry the token rows over, retire the old one, rename the new
 * one into place. The source is copied, not moved, so it survives as-is (and a scratch dir on
 * another filesystem works). If the final rename fails, the old graph is put back.
 */
export function replaceGraph(
  dataDir: string,
  id: string,
  from: string,
  opts: { now?: Date } = {},
): ReplaceResult {
  if (!isValidGraphId(id)) {
    throw new GraphRetireError(`"${id}" is not a valid graph id`, "invalid_request");
  }
  if (!existsSync(graphDbPath(dataDir, id))) {
    throw new GraphRetireError(
      `no graph called "${id}" in ${dataDir} to replace (to add a new graph, use graph create and import)`,
      "not_found",
    );
  }
  const source = resolveSourceGraphDir(from, id);
  if (resolve(source) === resolve(graphDir(dataDir, id))) {
    throw new GraphRetireError("the replacement is the graph being replaced", "invalid_request");
  }
  const oldMeta = readMeta(graphDir(dataDir, id));
  const now = opts.now ?? new Date();
  const staging = join(incomingRootDir(dataDir), `${id}-${retireTimestamp(now)}`);
  mkdirSync(incomingRootDir(dataDir), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  let tokensCarried: number;
  try {
    tokensCarried = carryTokens(graphDbPath(dataDir, id), join(staging, "graph.sqlite"));
    const newMeta = readMeta(staging);
    const meta: GraphMeta = {
      id,
      label: oldMeta?.label ?? newMeta?.label ?? id,
      createdAt: newMeta?.createdAt ?? now.getTime(),
    };
    writeFileSync(join(staging, "graph.json"), JSON.stringify(meta, null, 2));
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  // `force`: replacing "default" leaves a "default" in place, so the reason retire refuses it
  // (the bare address losing its graph) does not apply.
  const retired = retireGraph(dataDir, id, { force: true, now });
  try {
    renameSync(staging, graphDir(dataDir, id));
  } catch (err) {
    renameSync(retired.path, graphDir(dataDir, id));
    throw err;
  }
  return { id, tokensCarried, retired, path: graphDir(dataDir, id), source };
}
