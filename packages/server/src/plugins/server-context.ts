/**
 * Builds the REAL `ServerPluginContext` (`@nooklet/plugin-api`) handed to a plugin's server
 * `activate(ctx)`. Every `register*`/`on`/`beforeWrite`/`ops.register` call is backed by one of
 * this package's small per-concern modules (`./change-events.ts`, `./before-write.ts`, `./kv.ts`,
 * `./settings.ts`, `./jobs.ts`, `./mcp-registry.ts`, `./routes.ts`, `./registries.ts`,
 * `./provider-registries.ts`, `./ops-bridge.ts`) and, per rule 12, every one of those calls is
 * pushed onto this plugin's own `DisposableTracker` (`./disposables.ts`) — `./host.ts` calls
 * `tracker.disposeAll()` on disable/reload/shutdown, which is the whole auto-cleanup promise of
 * the API.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Disposable,
  HttpMethod,
  Json,
  McpResourceReader,
  McpToolDef,
  McpToolHandler,
  OpDef as PluginOpDef,
  PluginPermission,
  RouteInfo,
  ServerChangeEvents,
  ServerPluginContext,
} from "@nooklet/plugin-api";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerContext } from "../apply-ops.js";
import { createDataApi } from "../data-api.js";
import type { Logger, OpRegistry, ServerConfig } from "../ops/registry.js";
import { registerBeforeWrite } from "./before-write.js";
import { onChange } from "./change-events.js";
import { DisposableTracker } from "./disposables.js";
import { scheduleJob } from "./jobs.js";
import { kvDelete, kvGet, kvList, kvSet } from "./kv.js";
import { registerPluginMcpResource, registerPluginMcpTool } from "./mcp-registry.js";
import { wrapPluginOp } from "./ops-bridge.js";
import { registerEmbeddingProvider, registerSearchProvider } from "./provider-registries.js";
import {
  registerCommand as registerCommandReg,
  registerExporter as registerExporterReg,
  registerImporter as registerImporterReg,
} from "./registries.js";
import { mountPluginRoute } from "./routes.js";
import { settingsGet, settingsOnChange, settingsSet } from "./settings.js";

export interface PluginServerContextDeps {
  serverCtx: ServerContext;
  config: ServerConfig;
  registry: OpRegistry;
  app: Hono;
  hostVersion: string;
}

export interface PluginDescriptorLite {
  id: string;
  version: string;
  dir: string;
  permissions: PluginPermission[];
}

function makePluginLogger(pluginId: string): Logger {
  const tag = `[plugin:${pluginId}]`;
  return {
    debug: (...a) => console.debug(tag, ...a),
    info: (...a) => console.info(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
  };
}

/** Builds one plugin's `ServerPluginContext` plus the `DisposableTracker` that owns every
 * `Disposable` it hands out — `./host.ts` keeps the tracker, not the context, once `activate()`
 * returns, since only the tracker is needed again (on disable/reload). */
export function createPluginServerContext(
  deps: PluginServerContextDeps,
  descriptor: PluginDescriptorLite,
): { ctx: ServerPluginContext; tracker: DisposableTracker } {
  const { serverCtx, config, registry, app, hostVersion } = deps;
  const pluginId = descriptor.id;
  const tracker = new DisposableTracker();
  const log = makePluginLogger(pluginId);

  const dataDir = join(config.dataDir, "plugin-data", pluginId);
  mkdirSync(dataDir, { recursive: true });

  // Plugin writes via `ctx.data` are attributed to origin "plugin" (00-conventions.md vocabulary),
  // distinct from "user"/"api"/"mcp" — this is what lets a FUTURE `ctx.on(...)` handler, or a
  // human reading the audit log, tell "the user typed this" apart from "a plugin wrote this".
  const data = createDataApi(serverCtx, { origin: "plugin", actor: `plugin:${pluginId}` });

  const registerRouteImpl = ((...args: unknown[]): Disposable => {
    if (args.length <= 2 && typeof args[1] !== "string") {
      const [subApp, opts] = args as [Hono, { auth?: "required" | "none" } | undefined];
      const dispose = mountPluginRoute(app, serverCtx, pluginId, {
        kind: "app",
        app: subApp,
        auth: opts?.auth ?? "required",
      });
      return tracker.track({ dispose });
    }
    const [method, path, handler, opts] = args as [
      HttpMethod,
      string,
      (req: Request, info: RouteInfo) => Response | Promise<Response>,
      { auth?: "required" | "none" } | undefined,
    ];
    const dispose = mountPluginRoute(app, serverCtx, pluginId, {
      kind: "handler",
      method,
      path,
      handler,
      auth: opts?.auth ?? "required",
    });
    return tracker.track({ dispose });
  }) as ServerPluginContext["registerRoute"];

  const ctx: ServerPluginContext = {
    plugin: {
      id: pluginId,
      version: descriptor.version,
      dir: descriptor.dir,
      dataDir,
      permissions: descriptor.permissions,
    },
    host: { version: hostVersion, apiVersion: "1" },
    data,

    on<E extends keyof ServerChangeEvents>(
      event: E,
      handler: (payload: ServerChangeEvents[E]) => void | Promise<void>,
    ): Disposable {
      const unsub = onChange(serverCtx, (name, payload) => {
        if (name !== (event as string)) return;
        Promise.resolve(handler(payload as ServerChangeEvents[E])).catch((e: unknown) =>
          log.error(`"${String(event)}" handler failed:`, e),
        );
      });
      return tracker.track({ dispose: unsub });
    },

    beforeWrite(handler, opts) {
      const unsub = registerBeforeWrite(serverCtx, handler, opts);
      return tracker.track({ dispose: unsub });
    },

    registerCommand(cmd) {
      const { qualifiedId, dispose: disposeCommand } = registerCommandReg(serverCtx, pluginId, cmd);
      let disposeMcp: (() => void) | undefined;
      if (cmd.mcp) {
        const mcpName = qualifiedId.replace(/\./g, "_");
        const toolHandler: McpToolHandler = async (args, extra) => {
          const result = await cmd.run(args, extra);
          return {
            content: [
              { type: "text", text: result === undefined ? "(no result)" : JSON.stringify(result) },
            ],
            structuredContent: result === undefined ? undefined : (result as Json),
          };
        };
        disposeMcp = registerPluginMcpTool(
          serverCtx,
          pluginId,
          mcpName,
          {
            description: cmd.description ?? cmd.title,
            inputSchema: z.record(z.string(), z.unknown()),
          },
          toolHandler,
        );
      }
      return tracker.track({
        dispose() {
          disposeCommand();
          disposeMcp?.();
        },
      });
    },

    rpc: {
      expose(name, fn) {
        // A plugin's own client<->server bridge (distinct from ctx.data, per api-and-plugin-
        // types.md §5). It was mounted unauthenticated on the reasoning that only the plugin's own
        // client half calls it "over localhost" — but with `--host` set it is reachable by anyone
        // on the network, and the client half holds the app's token anyway. Bearer required.
        const dispose = mountPluginRoute(app, serverCtx, pluginId, {
          kind: "handler",
          method: "POST",
          path: `/rpc/${name}`,
          auth: "required",
          async handler(req) {
            let args: Json[] = [];
            try {
              const body: unknown = await req.json();
              if (Array.isArray(body)) args = body as Json[];
            } catch {
              // empty body -> no args
            }
            const result = await fn(...args);
            return new Response(JSON.stringify(result ?? null), {
              headers: { "content-type": "application/json" },
            });
          },
        });
        return tracker.track({ dispose });
      },
    },

    registerRoute: registerRouteImpl,

    registerMcpTool(name: string, def: McpToolDef, handler: McpToolHandler) {
      const dispose = registerPluginMcpTool(serverCtx, pluginId, name, def, handler);
      return tracker.track({ dispose });
    },
    registerMcpResource(
      name: string,
      uriTemplate: string,
      def: { description?: string; mimeType?: string },
      read: McpResourceReader,
    ) {
      const dispose = registerPluginMcpResource(serverCtx, pluginId, name, uriTemplate, def, read);
      return tracker.track({ dispose });
    },

    registerJob(job) {
      const handle = scheduleJob(job, log);
      return tracker.track({ dispose: () => handle.stop() });
    },
    registerImporter(importer) {
      const dispose = registerImporterReg(serverCtx, pluginId, importer);
      return tracker.track({ dispose });
    },
    registerExporter(exporter) {
      const dispose = registerExporterReg(serverCtx, pluginId, exporter);
      return tracker.track({ dispose });
    },
    registerEmbeddingProvider(provider) {
      const dispose = registerEmbeddingProvider(serverCtx.driver, provider);
      return tracker.track({ dispose });
    },
    registerSearchProvider(provider) {
      const dispose = registerSearchProvider(serverCtx.driver, provider);
      return tracker.track({ dispose });
    },

    ops: {
      register(opDef: PluginOpDef) {
        registry.register(wrapPluginOp(opDef), pluginId);
        return tracker.track({ dispose: () => registry.unregister(opDef.name) });
      },
    },

    settings: {
      get() {
        return settingsGet(serverCtx.driver, pluginId);
      },
      async set(patch) {
        settingsSet(serverCtx, pluginId, patch);
      },
      onChange(cb) {
        const dispose = settingsOnChange(serverCtx, pluginId, cb);
        return tracker.track({ dispose });
      },
    },
    kv: {
      async get(key) {
        return kvGet(serverCtx.driver, pluginId, key);
      },
      async set(key, value) {
        kvSet(serverCtx.driver, pluginId, key, value);
      },
      async delete(key) {
        kvDelete(serverCtx.driver, pluginId, key);
      },
      async list(prefix) {
        return kvList(serverCtx.driver, pluginId, prefix);
      },
    },

    log,
    subscriptions: tracker.subscriptions as Disposable[],
    experimental: {},
  };

  return { ctx, tracker };
}
