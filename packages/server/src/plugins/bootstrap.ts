/**
 * Wires a `PluginHost` and `../http/app.ts`'s `createApp` together in the one order that's safe:
 * build the `Hono` app, load plugins onto it (so `ctx.registerRoute`/`rpc.expose` and the two
 * plugin-discovery routes land on it), THEN hand that same app to `createApp` so its own
 * `mountMcp` call — a `"/"`-mounted sub-app that matches every path — goes on last. Getting this
 * order backwards silently swallows every plugin HTTP route (see `createApp`'s `app` option doc).
 *
 * Kept out of `../http/app.ts`/`../cli.ts` as its own tiny module so both the CLI's `serve` command
 * and this package's plugin tests share exactly one "the right way to boot app + plugins" recipe.
 */
import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { createApp } from "../http/app.js";
import { installRequestGuards } from "../http/guards.js";
import type { OpRegistry, ServerConfig } from "../ops/registry.js";
import { PluginHost } from "./host.js";
import { mountPluginClientRoute, mountPluginListRoute } from "./http.js";

export interface CreateAppWithPluginsOptions {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  version?: string;
  /** Directories scanned for plugins, in order (e.g. `<dataDir>/plugins`, and in dev, the repo
   * root's `plugins/`). Non-existent directories are skipped silently. */
  pluginDirs: string[];
  /** Plugins already bundled, scanned after `pluginDirs` — see `PluginHostDeps.bundledDirs`. */
  bundledPluginDirs?: string[];
  /** Forwarded to `createApp` — serve the built web client on this origin. See ../http/app.ts. */
  webClientDir?: string;
}

export async function createAppWithPlugins(
  opts: CreateAppWithPluginsOptions,
): Promise<{ app: Hono; pluginHost: PluginHost }> {
  const app = new Hono();
  // Before ANY route, plugin routes included: Hono runs handlers in registration order, so a guard
  // added later (inside `createApp`) never ran for routes mounted here (`../http/guards.ts`).
  installRequestGuards(app, opts.serverCtx, opts.config);
  const pluginHost = new PluginHost({
    serverCtx: opts.serverCtx,
    config: opts.config,
    registry: opts.registry,
    app,
    hostVersion: opts.version,
    dirs: opts.pluginDirs,
    bundledDirs: opts.bundledPluginDirs,
  });
  await pluginHost.loadAll();
  mountPluginClientRoute(app, pluginHost); // GET /plugins/:id/:file — unauthenticated, static

  createApp({
    ...opts,
    app,
    // GET /api/v1/plugins: needs createApp's bearerAuth (registered by the time this runs) and
    // must precede createApp's own mountMcp catch-all — see that option's doc in ../http/app.ts.
    mountBeforeMcp: (a) => mountPluginListRoute(a, pluginHost),
  });
  return { app, pluginHost };
}
