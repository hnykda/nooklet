/**
 * One process, N graphs (ADR 025): a lazily-built, in-memory cache of `graphId -> GraphHandle`,
 * where a handle bundles the graph's `ServerContext` with its own, otherwise-completely-unmodified
 * `createAppWithPlugins()`-built `Hono` app. `graphs/mount.ts` is what dispatches HTTP requests to
 * the right handle; this file only knows how to open, list, and create graphs on disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { closeGraphSockets, GRAPH_RETIRED_CLOSE_CODE } from "../auth/token-sockets.js";
import { closeDb } from "../db.js";
import type { OpRegistry } from "../ops/registry.js";
import { createAppWithPlugins } from "../plugins/bootstrap.js";
import type { PluginHost } from "../plugins/host.js";
import { type BaseServerConfig, type OpenGraphOptions, openGraph } from "./open-graph.js";
import {
  type GraphMeta,
  graphDbPath,
  graphMetaPath,
  graphsRootDir,
  isValidGraphId,
} from "./paths.js";
import { pluginDirsFor } from "./plugin-dirs.js";
import { GraphRetireError, type RetireOptions, type RetireResult, retireGraph } from "./retire.js";

export type { GraphMeta } from "./paths.js";

export interface GraphHandle {
  id: string;
  ctx: ServerContext;
  config: ReturnType<typeof openGraph>["config"];
  app: Hono;
  pluginHost: PluginHost;
}

export interface GraphRegistryOptions {
  registry: OpRegistry;
  version?: string;
  webClientDir?: string;
  /** Settings shared by every graph this process hosts — one bind port/host, not one per graph. */
  baseConfig: BaseServerConfig;
  /** Forwarded to `openGraph` for every graph this registry opens — see its own doc for why this
   * is opt-in (real serving wants it, a routing test or a read-only inspection does not). */
  migrate?: boolean;
  /** Called once, the first time a graph is actually opened (never on a cache hit) — the seam a
   * caller uses to layer real-serving concerns (data migrations, the live mirror, the embedding
   * indexer) onto "open the database and build the app," which is all this registry does on its
   * own. Kept out of here so a one-shot CLI command, or a routing test, isn't forced to pay for a
   * mirror watcher or an indexer it will never use. */
  onOpen?: (handle: GraphHandle) => void | Promise<void>;
  /** `onOpen`'s counterpart: called when a handle is dropped (the graph was retired, or its folder
   * was replaced underneath this process, B-713) before its database is closed, so whatever
   * `onOpen` started (mirror, indexer) stops instead of writing to a closed or moved graph. */
  onClose?: (handle: GraphHandle) => void | Promise<void>;
}

/** The identity of the database file a handle opened: what `resolve()` compares against to notice
 * that the folder was moved or replaced underneath it. */
function fileIdentity(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Writes `graph.json` for a graph whose database exists but has none, and never overwrites one.
 *
 * `graph.json` is what makes a directory a graph to `list()`. B-607: `nooklet import` or
 * `nooklet token create` on a fresh data dir opened `graphs/default/graph.sqlite` directly, so the
 * database existed with no `graph.json`; `serve` then saw zero graphs, called `create("default")`,
 * and died with `a graph called "default" already exists`. Every path that creates a database now
 * calls this (`openGraphForCommand`, `create()`), and `list()` calls it too, so a data dir already
 * left in that state recovers on the next `serve`.
 */
export function ensureGraphMeta(dataDir: string, graphId: string, label?: string): void {
  const metaPath = graphMetaPath(dataDir, graphId);
  if (existsSync(metaPath)) return;
  const dbPath = graphDbPath(dataDir, graphId);
  if (!existsSync(dbPath)) return;
  // An adopted graph's creation time is best approximated by its database file's own.
  const createdAt = Math.round(statSync(dbPath).birthtimeMs || statSync(dbPath).mtimeMs);
  const meta: GraphMeta = { id: graphId, label: label ?? graphId, createdAt };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/** `openGraphForCommand` was asked for a graph it may not open or create; the CLI prints it. */
export class GraphSelectionError extends Error {}

/**
 * The one-shot CLI commands' way into a graph (`import`, `export`, `token`, `backup`, ...): opens
 * it like `openGraph`, without the per-graph app and plugins a `GraphRegistry` handle builds, and
 * keeps the registry's invariant that a database always has its `graph.json` beside it (B-607).
 *
 * Only "default" may be created here, the zero-config graph a fresh data dir starts with. Any
 * other id must exist already: a typo in `--graph` should fail, not quietly make a new graph.
 * Other graphs are created through `POST /graphs` (ADR 025).
 */
export function openGraphForCommand(
  dataDir: string,
  graphId: string,
  base: BaseServerConfig,
  opts: OpenGraphOptions = {},
): ReturnType<typeof openGraph> {
  if (!isValidGraphId(graphId)) {
    throw new GraphSelectionError(`"${graphId}" is not a valid graph id`);
  }
  if (graphId !== "default" && !existsSync(graphDbPath(dataDir, graphId))) {
    throw new GraphSelectionError(
      `no graph called "${graphId}" in ${dataDir} (create one with POST /graphs, or from the app)`,
    );
  }
  const opened = openGraph(dataDir, graphId, base, opts);
  ensureGraphMeta(dataDir, graphId);
  return opened;
}

/**
 * `nooklet graph create` — the same thing `POST /graphs` does, without a running server or the root
 * token: the desktop app uses it to make a new graph on This Mac's own data dir (B-643,
 * `apps/desktop/src-tauri/src/main.rs#create_local_graph`), whether or not its server is running
 * (a running `serve` opens a graph lazily, on its first request, so a database created beside it
 * is picked up with no restart).
 *
 * On a data dir with no graphs at all, "default" is created first: `serve` only adds its
 * zero-config "default" when it finds no graphs, so without this a fresh install whose first graph
 * came from here would have no default graph, and its bare address (which redirects to
 * `/g/default`) would answer 404.
 */
export function createGraphForCommand(
  dataDir: string,
  graphId: string,
  base: BaseServerConfig,
  label?: string,
): GraphMeta {
  if (!isValidGraphId(graphId)) {
    throw new GraphSelectionError(
      `"${graphId}" is not a valid graph id (lowercase letters, digits, hyphens, 1-64 chars, not starting/ending with a hyphen)`,
    );
  }
  if (existsSync(graphDbPath(dataDir, graphId))) {
    throw new GraphSelectionError(`a graph called "${graphId}" already exists`);
  }
  mkdirSync(graphsRootDir(dataDir), { recursive: true });
  const hasAnyGraph = readdirSync(graphsRootDir(dataDir), { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(graphDbPath(dataDir, e.name)),
  );
  if (!hasAnyGraph && graphId !== "default") {
    openGraphForCommand(dataDir, "default", base);
  }
  // `SqlDriver` has no close: a one-shot command's process exits right after, like every other.
  openGraph(dataDir, graphId, base, { migrate: true, log: () => {} });
  ensureGraphMeta(dataDir, graphId, label);
  return JSON.parse(readFileSync(graphMetaPath(dataDir, graphId), "utf8")) as GraphMeta;
}

export class GraphRegistry {
  #dataDir: string;
  #opts: GraphRegistryOptions;
  #handles = new Map<string, Promise<GraphHandle>>();
  /** `graphId -> fileIdentity()` of the database each cached handle opened. */
  #identities = new Map<string, string | undefined>();
  /** Graphs mid-retire: `resolve()` answers "no such graph" for them, so a request arriving while
   * the handle is being closed cannot reopen the graph a moment before its folder moves. */
  #retiring = new Set<string>();

  constructor(dataDir: string, opts: GraphRegistryOptions) {
    this.#dataDir = dataDir;
    this.#opts = opts;
  }

  /** `undefined` when no such graph exists — becomes a 404 in `graphs/mount.ts`, never an
   * auto-create (that's `create()`'s job, deliberately a separate, explicit call). */
  async resolve(graphId: string): Promise<GraphHandle | undefined> {
    if (this.#retiring.has(graphId)) return undefined;
    const cached = this.#handles.get(graphId);
    if (cached) {
      // B-713: a cached handle keeps the database it opened, and an open file follows its inode,
      // not its path. So if `graphs/<id>/` was moved aside (and maybe replaced) by hand while this
      // process runs, the cache would go on serving, and writing to, the moved-away graph. One
      // stat per request notices it: drop the stale handle, then open whatever is there now.
      const handle = await cached;
      const now = fileIdentity(graphDbPath(this.#dataDir, graphId));
      if (now !== undefined && now === this.#identities.get(graphId)) return handle;
      await this.#evict(graphId, cached, "graph folder replaced");
      return this.resolve(graphId);
    }
    if (!existsSync(graphDbPath(this.#dataDir, graphId))) return undefined;
    const promise = this.#open(graphId);
    this.#handles.set(graphId, promise);
    return promise;
  }

  /**
   * `DELETE /graphs/<id>` (B-713): stop serving the graph and move its folder to
   * `graphs-retired/` (`retire.ts`). In order: refuse new requests for it, close its sockets
   * (4410) and its database, then move the folder. Throws `GraphRetireError`.
   */
  async retire(graphId: string, opts: RetireOptions = {}): Promise<RetireResult> {
    if (this.#retiring.has(graphId)) {
      throw new GraphRetireError(`"${graphId}" is already being retired`, "conflict");
    }
    if (graphId === "default" && !opts.force) {
      // Refused before anything is closed: `retireGraph` throws the explanation.
      return retireGraph(this.#dataDir, graphId, opts);
    }
    this.#retiring.add(graphId);
    try {
      const cached = this.#handles.get(graphId);
      if (cached) await this.#evict(graphId, cached, "graph retired");
      return retireGraph(this.#dataDir, graphId, opts);
    } finally {
      this.#retiring.delete(graphId);
    }
  }

  /** Drop a cached handle and release everything it holds. Only if `expected` is still the cached
   * one: two requests that both noticed a replaced folder must not close the fresh handle the
   * first of them opened. */
  async #evict(graphId: string, expected: Promise<GraphHandle>, reason: string): Promise<void> {
    if (this.#handles.get(graphId) !== expected) return;
    this.#handles.delete(graphId);
    this.#identities.delete(graphId);
    const handle = await expected;
    // Logged, not thrown: the handle is already out of the cache, so a retire that stopped here
    // would leave the graph neither served by this handle nor moved.
    try {
      await this.#opts.onClose?.(handle);
      await handle.pluginHost.deactivateAll();
    } catch (err) {
      process.stderr.write(`nooklet: [${graphId}] closing the graph: ${(err as Error).message}\n`);
    }
    closeGraphSockets(handle.ctx.driver, GRAPH_RETIRED_CLOSE_CODE, reason);
    closeDb(handle.ctx.driver);
  }

  async create(graphId: string, label?: string): Promise<GraphHandle> {
    if (!isValidGraphId(graphId)) {
      throw new Error(
        `"${graphId}" is not a valid graph id (lowercase letters, digits, hyphens, 1-64 chars, not starting/ending with a hyphen)`,
      );
    }
    if (existsSync(graphDbPath(this.#dataDir, graphId))) {
      throw new Error(`a graph called "${graphId}" already exists`);
    }
    // A crash between `#open()` creating the SQLite file and `graph.json` being written leaves a
    // database with no metadata; `list()` adopts that (B-607) rather than hiding it, and never
    // lists a `graph.json` with no database behind it.
    mkdirSync(graphsRootDir(this.#dataDir), { recursive: true });
    const promise = this.#open(graphId).then((handle) => {
      // `graph.json` is written only once the database itself opened successfully — see above.
      ensureGraphMeta(this.#dataDir, graphId, label);
      return handle;
    });
    this.#handles.set(graphId, promise);
    return promise;
  }

  async list(): Promise<GraphMeta[]> {
    if (!existsSync(graphsRootDir(this.#dataDir))) return [];
    const ids = readdirSync(graphsRootDir(this.#dataDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const metas: GraphMeta[] = [];
    for (const id of ids) {
      // A database with no graph.json is adopted (B-607). A directory with neither is not a graph.
      if (isValidGraphId(id)) ensureGraphMeta(this.#dataDir, id);
      const metaPath = graphMetaPath(this.#dataDir, id);
      if (!existsSync(metaPath)) continue;
      try {
        metas.push(JSON.parse(readFileSync(metaPath, "utf8")) as GraphMeta);
      } catch {
        // Corrupt graph.json: skip rather than fail the whole listing over one bad entry.
      }
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt);
  }

  async #open(graphId: string): Promise<GraphHandle> {
    const { ctx, config } = openGraph(this.#dataDir, graphId, this.#opts.baseConfig, {
      migrate: this.#opts.migrate,
      log: (message) => process.stderr.write(message),
    });
    // After the open, because `create()` comes through here too and its file did not exist before.
    this.#identities.set(graphId, fileIdentity(graphDbPath(this.#dataDir, graphId)));
    const dirs = pluginDirsFor(config.dataDir);
    const { app, pluginHost } = await createAppWithPlugins({
      serverCtx: ctx,
      // Per graph, like every other plugin registry (they key on the graph's `ServerContext`):
      // each graph activates its own copy of every plugin, so each needs room for its plugin ops
      // (B-617). Core ops are shared definitions, copied in.
      registry: this.#opts.registry.forkCore(),
      config,
      version: this.#opts.version,
      pluginDirs: dirs.dirs,
      bundledPluginDirs: dirs.bundled,
      webClientDir: this.#opts.webClientDir,
    });
    const handle: GraphHandle = { id: graphId, ctx, config, app, pluginHost };
    await this.#opts.onOpen?.(handle);
    return handle;
  }
}
