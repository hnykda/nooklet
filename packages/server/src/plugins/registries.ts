/**
 * Small generic per-`ServerContext` registries shared by `registerCommand`, `registerImporter`,
 * and `registerExporter` — none of these have an existing host-side consumer to hook into (there
 * is no command palette or import/export CLI surface in `packages/server` yet), so each is "real"
 * in the sense the task asks for (register/list/dispose all genuinely work, tested directly) without
 * inventing a second, speculative subsystem this task wasn't asked to build. A future palette/CLI
 * simply reads `listCommands`/`listImporters`/`listExporters`.
 */
import type { ExporterDef, ImporterDef, PluginCommand } from "@nooklet/plugin-api";
import type { ServerContext } from "../apply-ops.js";

function createRegistry<T>() {
  const byCtx = new WeakMap<ServerContext, Map<string, T>>();
  const mapFor = (ctx: ServerContext): Map<string, T> => {
    const m = byCtx.get(ctx) ?? new Map<string, T>();
    byCtx.set(ctx, m);
    return m;
  };
  return {
    register(ctx: ServerContext, id: string, value: T): () => void {
      const m = mapFor(ctx);
      if (m.has(id)) throw new Error(`"${id}" is already registered`);
      m.set(id, value);
      return () => m.delete(id);
    },
    list(ctx: ServerContext): T[] {
      return [...mapFor(ctx).values()];
    },
    get(ctx: ServerContext, id: string): T | undefined {
      return mapFor(ctx).get(id);
    },
  };
}

export interface RegisteredCommand {
  pluginId: string;
  qualifiedId: string;
  command: PluginCommand;
}
const commandRegistry = createRegistry<RegisteredCommand>();
export function registerCommand(
  ctx: ServerContext,
  pluginId: string,
  command: PluginCommand,
): { qualifiedId: string; dispose: () => void } {
  const qualifiedId = `${pluginId}.${command.id}`;
  const dispose = commandRegistry.register(ctx, qualifiedId, { pluginId, qualifiedId, command });
  return { qualifiedId, dispose };
}
export function listCommands(ctx: ServerContext): RegisteredCommand[] {
  return commandRegistry.list(ctx);
}

export interface RegisteredImporter {
  pluginId: string;
  importer: ImporterDef;
}
const importerRegistry = createRegistry<RegisteredImporter>();
export function registerImporter(
  ctx: ServerContext,
  pluginId: string,
  importer: ImporterDef,
): () => void {
  return importerRegistry.register(ctx, `${pluginId}.${importer.id}`, { pluginId, importer });
}
export function listImporters(ctx: ServerContext): RegisteredImporter[] {
  return importerRegistry.list(ctx);
}

export interface RegisteredExporter {
  pluginId: string;
  exporter: ExporterDef;
}
const exporterRegistry = createRegistry<RegisteredExporter>();
export function registerExporter(
  ctx: ServerContext,
  pluginId: string,
  exporter: ExporterDef,
): () => void {
  return exporterRegistry.register(ctx, `${pluginId}.${exporter.id}`, { pluginId, exporter });
}
export function listExporters(ctx: ServerContext): RegisteredExporter[] {
  return exporterRegistry.list(ctx);
}
