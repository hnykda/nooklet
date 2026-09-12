/**
 * Server `PluginContext` (`docs/spec/api-and-plugin-types.md` §4). Greenfield — no plugin host
 * exists in this repo yet, so this module follows the spec directly rather than reconciling
 * against an implementation (unlike `data.ts`/`op-def.ts`, which do have real code to match).
 */
import type { Block, BlockId, Op, Page, PageId } from "@nooklet/core";
import type { z } from "zod";
import type { DataApi } from "./data.js";
import type { Disposable } from "./disposable.js";
import type { Json } from "./json.js";
import type { JsonSchema, PluginPermission } from "./manifest.js";
import type { HttpMethod, Logger, OpAnnotations, OpDef, Origin } from "./op-def.js";

export interface PendingWriteTx {
  id: string;
  origin: Origin;
  /** Mutable: a `beforeWrite` handler may edit this array in place, or throw to veto the write. */
  ops: Op[];
}
export type BeforeWriteHandler = (tx: PendingWriteTx) => void | Promise<void>;

export interface ServerChangeEvents {
  "block.created": { block: Block; origin: Origin; txId: string };
  "block.updated": { block: Block; before: Block; origin: Origin; txId: string };
  "block.moved": {
    block: Block;
    before: { pageId: PageId; parentId: BlockId | null; order: string };
    origin: Origin;
    txId: string;
  };
  "block.deleted": { block: Block; origin: Origin; txId: string };
  "page.created": { page: Page; origin: Origin; txId: string };
  "page.renamed": { page: Page; before: Page; origin: Origin; txId: string };
  "page.updated": { page: Page; before: Page; origin: Origin; txId: string };
  "page.deleted": { page: Page; origin: Origin; txId: string };
  "tx.committed": { txId: string; origin: Origin; ops: Op[] };
}

export interface PluginCommand {
  /** "mermaid-tools.insert" — the host prefixes plugin commands with the plugin id. */
  id: string;
  title: string;
  description?: string;
  category?: string;
  /** JSON Schema for args; the palette prompts for them if the command needs input. */
  args?: JsonSchema;
  /** Auto-exposes this command as an MCP tool named "<pluginId>_<id-with-dots-as-underscores>". */
  mcp?: boolean;
  run(args: Json, info: { origin: Origin }): Json | void | Promise<Json | void>;
}

export type RpcFn = (...args: Json[]) => Json | void | Promise<Json | void>;

export interface McpToolDef {
  description: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: Partial<OpAnnotations>;
}
export type McpToolHandler = (
  args: Json,
  extra: { origin: Origin },
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Json;
  isError?: boolean;
}>;
export type McpResourceReader = (
  uri: URL,
  params: Record<string, string>,
) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>;

export interface JobDef {
  id: string;
  every?: string; // "15m"
  cron?: string; // "0 3 * * *"
  runOnStart?: boolean;
  run(signal: AbortSignal): Promise<void>;
}
export interface ImporterDef {
  id: string;
  title: string;
  accepts: string[]; // file extensions, e.g. [".md", ".zip"]
  run(
    input: { files: Array<{ name: string; bytes(): Promise<Uint8Array> }> },
    target: { namespace?: string },
    report: (msg: string) => void,
  ): Promise<{ pages: number; blocks: number }>;
}
export interface ExporterDef {
  id: string;
  title: string;
  mime: string;
  run(scope: { pages?: PageId[]; all?: boolean }): Promise<ReadableStream<Uint8Array>>;
}
export interface EmbeddingProviderDef {
  id: string;
  model: string;
  dims: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}
export interface SearchProviderDef {
  id: string;
  search(
    query: string,
    opts: { limit: number },
  ): Promise<Array<{ blockId: BlockId; score: number }>>;
}

export interface RouteInfo {
  params: Record<string, string>;
  origin: Origin;
}

export interface ServerPluginContext {
  readonly plugin: {
    id: string;
    version: string;
    dir: string;
    dataDir: string;
    permissions: PluginPermission[];
  };
  readonly host: { version: string; apiVersion: "1" };
  readonly data: DataApi;

  on<E extends keyof ServerChangeEvents>(
    event: E,
    handler: (payload: ServerChangeEvents[E]) => void | Promise<void>,
  ): Disposable;
  /** MUST NOT be invoked for a pending write whose `origin.kind === "sync"` (rule 13: sync must
   * always converge; a plugin veto would fork devices). */
  beforeWrite(handler: BeforeWriteHandler, opts?: { priority?: number }): Disposable;

  registerCommand(cmd: PluginCommand): Disposable;
  /** Server side of `ClientPluginContext.rpc.call`: `POST /api/plugins/<id>/rpc/<name>` with a
   * JSON array of arguments. Requires a bearer token like every plugin route; the client half
   * sends the app's own. */
  readonly rpc: { expose(name: string, fn: RpcFn): Disposable };

  /**
   * Mount a Hono sub-app, or a single (method, path, handler) route, under `/api/plugins/<id>/`.
   *
   * Both forms require a valid bearer token by default (`auth: "required"`): the route is
   * reachable by anything that can reach the server, which with `--host` set is the whole
   * network. Scope is NOT checked — a plugin route is the plugin's own API, and `RouteInfo.origin`
   * carries the token id for the plugin to decide with. `auth: "none"` opts a route out, for
   * things like an `<img>`/`<script>` source that cannot carry a header.
   */
  registerRoute(app: import("hono").Hono, opts?: { auth?: "required" | "none" }): Disposable;
  registerRoute(
    method: HttpMethod,
    path: string,
    handler: (req: Request, info: RouteInfo) => Response | Promise<Response>,
    opts?: { auth?: "required" | "none" },
  ): Disposable;

  registerMcpTool(name: string, def: McpToolDef, handler: McpToolHandler): Disposable;
  registerMcpResource(
    name: string,
    uriTemplate: string,
    def: { description?: string; mimeType?: string },
    read: McpResourceReader,
  ): Disposable;

  registerJob(job: JobDef): Disposable;
  registerImporter(importer: ImporterDef): Disposable;
  registerExporter(exporter: ExporterDef): Disposable;
  registerEmbeddingProvider(provider: EmbeddingProviderDef): Disposable;
  registerSearchProvider(provider: SearchProviderDef): Disposable;

  /** The full `defineOp` escape hatch (ADR 008): the same registry HTTP/MCP mount as core ops. */
  readonly ops: { register(op: OpDef): Disposable };

  readonly settings: {
    get<T = Json>(): T;
    set<T extends Json>(patch: Partial<T>): Promise<void>;
    onChange(cb: (next: Json, prev: Json) => void): Disposable;
  };
  readonly kv: {
    get<T extends Json>(key: string): Promise<T | null>;
    set(key: string, value: Json): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };

  readonly log: Logger;
  /** Host-managed; every `register*`/`on`/`beforeWrite` call's `Disposable` lands here too, for
   * introspection/tests (rule 12). Do not push to this array yourself. */
  readonly subscriptions: Disposable[];
  /** Requires `experimental: true` in the manifest. May change or disappear in any release. */
  readonly experimental: Record<string, unknown>;
}
