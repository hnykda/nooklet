/**
 * Single-file `*.plugin.ts` form (`docs/spec/api-and-plugin-types.md` §2.2). No `package.json` is
 * needed for a quick script; the loader synthesizes an equivalent `PluginManifest` from these
 * inline fields (`packages/server/src/plugins/host.ts`, not yet built — out of scope here).
 */

import type { ClientPluginContext } from "./client-context.js";
import type { PluginManifest } from "./manifest.js";
import type { ServerPluginContext } from "./server-context.js";

export interface ServerPluginModule {
  activate(ctx: ServerPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export interface ClientPluginModule {
  activate(ctx: ClientPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface SingleFilePlugin extends Omit<PluginManifest, "server" | "client"> {
  server?: ServerPluginModule;
  client?: ClientPluginModule;
}

export function definePlugin<P extends SingleFilePlugin>(p: P): P {
  return p;
}
