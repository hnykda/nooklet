/**
 * One process, N graphs (ADR 025): a lazily-built, in-memory cache of `graphId -> GraphHandle`,
 * where a handle bundles the graph's `ServerContext` with its own, otherwise-completely-unmodified
 * `createAppWithPlugins()`-built `Hono` app. `graphs/mount.ts` is what dispatches HTTP requests to
 * the right handle; this file only knows how to open, list, and create graphs on disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import type { OpRegistry } from "../ops/registry.js";
import { createAppWithPlugins } from "../plugins/bootstrap.js";
import { type BaseServerConfig, openGraph } from "./open-graph.js";
import {
  type GraphMeta,
  graphDbPath,
  graphMetaPath,
  graphsRootDir,
  isValidGraphId,
} from "./paths.js";
import { pluginDirsFor } from "./plugin-dirs.js";

export type { GraphMeta } from "./paths.js";

export interface GraphHandle {
  id: string;
  ctx: ServerContext;
  config: ReturnType<typeof openGraph>["config"];
  app: Hono;
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
}

export class GraphRegistry {
  #dataDir: string;
  #opts: GraphRegistryOptions;
  #handles = new Map<string, Promise<GraphHandle>>();

  constructor(dataDir: string, opts: GraphRegistryOptions) {
    this.#dataDir = dataDir;
    this.#opts = opts;
  }

  /** `undefined` when no such graph exists — becomes a 404 in `graphs/mount.ts`, never an
   * auto-create (that's `create()`'s job, deliberately a separate, explicit call). */
  async resolve(graphId: string): Promise<GraphHandle | undefined> {
    const cached = this.#handles.get(graphId);
    if (cached) return cached;
    if (!existsSync(graphDbPath(this.#dataDir, graphId))) return undefined;
    const promise = this.#open(graphId);
    this.#handles.set(graphId, promise);
    return promise;
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
    // Written before `#open()` (which creates the SQLite file): `list()` should see a graph the
    // instant it's created, and a crash between the two leaves an orphaned directory `list()` will
    // simply skip (no `graph.json`) rather than a phantom entry with no database.
    mkdirSync(graphsRootDir(this.#dataDir), { recursive: true });
    const meta: GraphMeta = { id: graphId, label: label ?? graphId, createdAt: Date.now() };
    const promise = this.#open(graphId).then((handle) => {
      // `graph.json` is written only once the database itself opened successfully — see above.
      writeFileSync(graphMetaPath(this.#dataDir, graphId), JSON.stringify(meta, null, 2));
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
      const metaPath = graphMetaPath(this.#dataDir, id);
      if (!existsSync(metaPath)) continue; // no graph.json: not a real graph (see create()'s note)
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
    const dirs = pluginDirsFor(config.dataDir);
    const { app } = await createAppWithPlugins({
      serverCtx: ctx,
      registry: this.#opts.registry,
      config,
      version: this.#opts.version,
      pluginDirs: dirs.dirs,
      bundledPluginDirs: dirs.bundled,
      webClientDir: this.#opts.webClientDir,
    });
    const handle: GraphHandle = { id: graphId, ctx, config, app };
    await this.#opts.onOpen?.(handle);
    return handle;
  }
}
