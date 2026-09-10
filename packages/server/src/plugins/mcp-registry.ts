/**
 * `ServerPluginContext.registerMcpTool`/`registerMcpResource`: raw MCP tools/resources that skip
 * `defineOp`'s HTTP+OpenAPI+MCP triple mount (that's `ctx.ops.register`, wired straight into the
 * shared `OpRegistry` — `./server-context.ts`) and register directly against "the MCP server the
 * core ops use" instead. Since `../mcp/server.ts`'s `buildMcpServerInstance` builds a FRESH
 * `McpServer` per call (stateless HTTP MCP mounts one per request; the stdio bridge builds one at
 * startup), there is no single long-lived `McpServer` instance a plugin could register onto once —
 * so this module is a small registry `buildMcpServerInstance` reads from every time it builds an
 * instance, keyed by `ServerContext` like every other plugin-host seam in this package.
 *
 * Tool/resource names are prefixed `<pluginId>_...` (mirroring `PluginCommand.id`'s host-applied
 * `<pluginId>.` prefix, `@nooklet/plugin-api`'s `server-context.ts`) so two plugins can never
 * collide, and so a plugin's raw MCP tools are visibly attributable in `tools/list`.
 */
import type { McpResourceReader, McpToolDef, McpToolHandler } from "@nooklet/plugin-api";
import type { ServerContext } from "../apply-ops.js";

export interface PluginMcpTool {
  pluginId: string;
  name: string; // already prefixed
  def: McpToolDef;
  handler: McpToolHandler;
}
export interface PluginMcpResource {
  pluginId: string;
  name: string; // already prefixed
  uriTemplate: string;
  def: { description?: string; mimeType?: string };
  read: McpResourceReader;
}

const toolsByCtx = new WeakMap<ServerContext, Map<string, PluginMcpTool>>();
const resourcesByCtx = new WeakMap<ServerContext, Map<string, PluginMcpResource>>();

function toolsFor(ctx: ServerContext): Map<string, PluginMcpTool> {
  const m = toolsByCtx.get(ctx) ?? new Map();
  toolsByCtx.set(ctx, m);
  return m;
}
function resourcesFor(ctx: ServerContext): Map<string, PluginMcpResource> {
  const m = resourcesByCtx.get(ctx) ?? new Map();
  resourcesByCtx.set(ctx, m);
  return m;
}

export function registerPluginMcpTool(
  ctx: ServerContext,
  pluginId: string,
  name: string,
  def: McpToolDef,
  handler: McpToolHandler,
): () => void {
  const qualified = `${pluginId}_${name}`;
  const map = toolsFor(ctx);
  if (map.has(qualified)) throw new Error(`MCP tool "${qualified}" is already registered`);
  map.set(qualified, { pluginId, name: qualified, def, handler });
  return () => map.delete(qualified);
}

export function registerPluginMcpResource(
  ctx: ServerContext,
  pluginId: string,
  name: string,
  uriTemplate: string,
  def: { description?: string; mimeType?: string },
  read: McpResourceReader,
): () => void {
  const qualified = `${pluginId}_${name}`;
  const map = resourcesFor(ctx);
  if (map.has(qualified)) throw new Error(`MCP resource "${qualified}" is already registered`);
  map.set(qualified, { pluginId, name: qualified, uriTemplate, def, read });
  return () => map.delete(qualified);
}

/** Read by `../mcp/server.ts#buildMcpServerInstance` every time it builds a server instance. */
export function listPluginMcpTools(ctx: ServerContext): PluginMcpTool[] {
  return [...toolsFor(ctx).values()];
}
export function listPluginMcpResources(ctx: ServerContext): PluginMcpResource[] {
  return [...resourcesFor(ctx).values()];
}
