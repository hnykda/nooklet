# API and plugin types

Status: draft, implementation-ready. Normative for `packages/server`, `@nooklet/plugin-api`, and
every plugin. Refines ADR 007 (plugins), ADR 008 (API and MCP), ADR 009 (commands), and PLAN.md
§§11-13. Follows `00-conventions.md`; does not contradict PLAN or the ADRs. Companion specs owned
by other work: `mcp-tools.md` (the concrete 15 op/tool definitions, using the `defineOp` pattern
fixed here) and `commands-and-keymap.md` (the full default keymap, using the `Command` type fixed
here). Versions verified against npm on 2026-09-10: `hono` 4.13.7, `zod` 4.6.1,
`@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/hono` 2.0.0,
`@modelcontextprotocol/client` 2.0.0, `esbuild` 0.28.2, `fractional-indexing` 4.0.0 (already a
`packages/core` dependency).

## Purpose

Define the exact TypeScript shapes that every server-side operation and every plugin (server half
and client half) is written against:

1. `defineOp` — the single definition that produces an HTTP route, an OpenAPI operation, an MCP
   tool, and a typed client call, plus the registry and the three mount functions.
2. The plugin manifest (`package.json#nooklet` and the single-file `*.plugin.ts` form).
3. The shared `DataApi` and the server/client `PluginContext` interfaces.
4. The `Command` type and representative v1 commands.
5. A complete worked example plugin.
6. Versioning and compatibility rules for the plugin API.

This is the contract implementers code against; it is not itself the implementation of
`applyOps`, the sync engine, or the 15 MCP tools (those belong to ADR 003/the sync spec and to
`mcp-tools.md` respectively).

## Definitions

Builds on `00-conventions.md` §Vocabulary. Additional terms used only in this spec:

- **`OpDef`**: the object literal passed to `defineOp` (conventions.md already defines "Operation
  (op definition)"; this spec fixes its TypeScript shape).
- **`OpContext`**: the second argument passed to every `OpDef.handler`. Carries storage access,
  the write path, the audit identity, config, and logging (§Interfaces 1.3).
- **`Disposable`**: `{ dispose(): void }`, returned by every `register*` call on a plugin context.
  See §Interfaces 6.
- **`ServerPluginContext` / `ClientPluginContext`**: the `ctx` argument passed to a plugin half's
  `activate()`. Called `ServerContext`/`ClientContext` in `research/05-plugins.md`; renamed here
  to avoid confusion with `OpContext` and with Hono's own `Context`.
- **`DataApi`**: the isomorphic block/page/query/transact interface, identical on server and
  client (ADR 007).

### Glossary additions (for `00-conventions.md`)

This spec is restricted to writing only `docs/spec/api-and-plugin-types.md`, so the following
one-line entries — required by `00-conventions.md`'s own rule ("a spec... adds a one-line entry to
the glossary") — are listed here for whoever next edits `00-conventions.md` to copy in:

- **Disposable**: `{ dispose(): void }` returned by every plugin `register*` call; the host
  disposes a plugin's disposables on deactivate (`api-and-plugin-types.md`).
- **OpContext**: the context argument passed to every `defineOp` handler: storage, `applyOps`,
  actor/origin, config, logger (`api-and-plugin-types.md`).
- **DataApi**: the block/page/query/transact interface shared verbatim by server and client
  plugin halves (`api-and-plugin-types.md`).

## Normative rules

1. Op names MUST match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` — dotted segments, each starting
   with a lowercase letter; `_` MAY appear inside a segment (relaxed 2026-09-12 for ADR 020's
   `block.to_page`, `block.move_to_page`). That makes the MCP name derivation (`.` → `_`,
   conventions.md §Naming) non-injective on its own — `a.b_c` and `a.b.c` both become `a_b_c` —
   so `OpRegistry.register` MUST also throw when the derived tool name is already taken by another
   op. The guarantee that matters, two distinct op names never sharing one tool name, is kept by
   that check rather than by the grammar; the mapping is one-way (the MCP server closes over the op),
   so nothing ever has to turn a tool name back into an op name.
2. `OpRegistry.register` MUST throw if `name` is already registered. The registry is one flat
   namespace shared by core and every plugin (ADR 008: "Plugins register ops through the same
   registry"); there is no reserved-prefix rule in v1 (see Open issues #9).
3. Every `OpDef.annotations` field (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint`) MUST be set explicitly. `defineOp` MUST NOT default them — the MCP spec's
   defaults for an unannotated tool are the dangerous direction (destructive, non-idempotent,
   open-world).
4. `openWorldHint` MUST be `false` for every core op (nooklet is a closed world: it never reaches
   the open internet on an op's behalf). A plugin op that wraps an external API (e.g. a web
   search provider) MAY set it `true`.
5. Every object-typed `input`/`output` root schema MUST be `.strict()` (or otherwise forbid
   unknown keys) so `z.toJSONSchema` emits `additionalProperties: false`, per MCP's recommendation
   for no-argument-surprise tools.
6. Every input and output field SHOULD carry `.describe()`. Contract tests (owned by
   `mcp-tools.md`) enforce this for all core ops.
7. `OpError.code` MUST be one of the eight codes in `00-conventions.md` §API conventions
   (`not_found`, `invalid`, `conflict`, `forbidden`, `unauthorized`, `rate_limited`, `too_large`,
   `internal`) — lowercase, exactly this set. Do not introduce additional codes (e.g. no
   `ambiguous`; map an ambiguous short-id-prefix match to `invalid` with a `hint`).
8. Defaults for `expose` when the field (or a sub-field) is omitted: `http: true`; `mcp: true` for
   ops registered by **core**, `mcp: false` for ops registered by a **plugin** (ADR 007: "plugin
   ops default to HTTP-only exposure"). A plugin op must set `expose: { mcp: true }` explicitly to
   appear as an MCP tool.
9. When `expose.http` is `{ method, path }`, the canonical `POST /api/v1/<name>` route MUST still
   be mounted (unless `expose.http` is the literal `false`); the object form ADDS a REST-style
   alias at `<method> /api/v1<path>`, it does not replace the canonical route.
10. A caller's token scopes MUST be a superset of `op.scopes` or the handler MUST NOT run. Over
    HTTP this is `403 forbidden`. Over MCP the tool MUST be omitted entirely from that
    credential's `tools/list` (never listed then denied — the spec permits per-credential tool
    lists; use that, don't rely on the client refusing).
11. `render` is REQUIRED when `expose.mcp` is not `false` (MCP always needs `content[].text`);
    OPTIONAL otherwise, defaulting to `JSON.stringify(output)`. `render` takes only the op's
    `output` — never the input (§Open issues #2).
12. Every `register*` method on a `ServerPluginContext`/`ClientPluginContext` MUST return a
    `Disposable`, and the host MUST track it internally and dispose every disposable a plugin
    created, in reverse registration order, when that plugin deactivates or reloads — with no
    action required from the plugin author (Obsidian's `register*` pattern, done one level more
    automatically: see §Interfaces 6).
13. `beforeWrite` handlers MUST NOT be invoked for a pending write whose `origin.kind === 'sync'`
    (sync must always converge; a plugin veto would fork devices).
14. A plugin manifest MUST declare at least one of `server` / `client`.
15. `nooklet.api` MUST be the literal string `"1"` for a v1 plugin. The host MUST refuse to
    `activate()` a plugin whose `api` major it does not support, marking it `error` in
    Settings → Plugins, and MUST NOT abort server startup because of it (Home Assistant "safe
    mode" behavior).
16. `DataApi` on the client MUST reach the server only through the HTTP API plus the local sync
    replica cache; it MUST NOT touch SQLite directly. `DataApi` on the server MUST go through the
    same core services the HTTP API and MCP tools use. Both sides implement the byte-identical
    TypeScript interface (§Interfaces 3).
17. Property values crossing any `DataApi`/op boundary MUST be `string`, or `null` in a patch to
    unset a key — matching `packages/core/src/model.ts`'s `Properties = Record<string, string>`.
    Typed coercion (number/date/checkbox) is a presentation-layer concern (PLAN §8), never part of
    this wire shape.
18. Journal pages crossing any `DataApi`/op boundary MUST be addressed by ISO `YYYY-MM-DD` (or
    the aliases `today`/`yesterday`/`tomorrow`), never by the internal `YYYYMMDD` integer
    (`journalDay` in `packages/core/src/model.ts` is storage/core-internal only).
19. **Wire JSON is `snake_case`; TypeScript is `camelCase`** (reconciled 2026-09-10, see
    `00-conventions.md` §API conventions). Every field name inside an op's `input`/`output` Zod
    schema — i.e. every field an HTTP body or MCP tool call actually carries — is `snake_case`
    (`idempotency_key`, `if_version`, `dry_run`, `next_cursor`, `batch_id`, `block_count`, …).
    This does NOT apply to `OpContext`, `DataApi`, `PluginContext`, or the registry's own fields
    (`defineOp`'s `name`/`input`/`output`/`handler`, `applyOps`'s `meta.batchId`,
    `QueryApi.blocks`'s `updatedAfter`, etc.) — none of those are ever serialized as a request or
    response body, so they correctly stay `camelCase` per `00-conventions.md` §Naming. A handler
    reads its parsed `snake_case` input object and calls `camelCase` `DataApi`/`applyOps` methods;
    see the worked example in §5, whose op output uses `word_count`/`block_count`.
    `mcp-tools.md`'s 16 tool definitions use this same `snake_case` wire rule.
20. Command ids MUST follow `00-conventions.md`'s `area.verb` convention (`block.indent`,
    `task.cycle`); this is the same shape as op names but a distinct, separate namespace (a
    command may internally call an op, but command ids and op names are never compared or
    deduplicated against each other).

## Interfaces

Packages, per `00-conventions.md`: `defineOp`, `OpDef`, `OpContext`, `OpError`, `Scope`,
`OpAnnotations` live in `packages/server/src/ops/define-op.ts` and are re-exported from
`@nooklet/plugin-api` so plugin code never depends on `@nooklet/server`. `OpRegistry` lives in
`packages/server/src/ops/registry.ts` (server-internal — plugins get the narrower
`ctx.ops.register()` in §4). The mount functions live in `packages/server/src/http.ts` and
`packages/server/src/mcp.ts`. `DataApi`, `ServerPluginContext`, `ClientPluginContext`,
`PluginManifest`, `Disposable`, `Command` live in `packages/plugin-api/src/index.ts`.

### 1. `defineOp` and the operation registry

#### 1.1 Shared primitives

```ts
// packages/plugin-api/src/json.ts
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// packages/server/src/ops/define-op.ts
import { z } from "zod"; // zod 4.6.1 — the package's default export is the v4 API;
// "zod/v4" is an equivalent subpath kept for hybrid v3/v4 installs, not needed here.
import type { Json } from "@nooklet/plugin-api"; // re-exports packages/plugin-api/src/json.ts

export type Scope = "read" | "write" | "admin";

export interface OpAnnotations {
  /** No side effects at all. */
  readOnlyHint: boolean;
  /** May destroy or overwrite data (meaningful only when readOnlyHint is false). */
  destructiveHint: boolean;
  /** Calling twice with the same input has no further effect. */
  idempotentHint: boolean;
  /** Reaches outside the graph (web, other services). MUST be false for every core op. */
  openWorldHint: boolean;
}
```

#### 1.2 `OpDef` and `defineOp`

```ts
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** true = mount only the canonical POST /api/v1/<name>; an object also mounts a REST alias. */
export type HttpExpose = boolean | { method: HttpMethod; path: string }; // path uses OpenAPI-style "{param}" segments

/** true = expose with no extra hints; an object turns exposure on and sets MCP-specific hints. */
export type McpExpose =
  | boolean
  | {
      /** Never deferred behind Claude Code's tool search; keep to a handful across the whole server. */
      alwaysLoad?: boolean;
      /** Client must prompt the user before every call, even under auto-approval settings. */
      requiresUserInteraction?: boolean;
      /** Caps the size of the returned text/structured content Claude Code will inline. */
      maxResultSizeChars?: number;
    };

export interface OpExpose {
  http: HttpExpose;
  mcp: McpExpose;
}

export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** "noun.verb", dotted, e.g. "page.read". See rule 1. Globally unique across core + plugins. */
  name: string;
  /** <= 60 chars. Becomes the MCP tool `title` and the OpenAPI `summary`. */
  summary: string;
  /** LLM-facing: what it does, when to use it, when NOT to, what it returns. <= 1500 chars. */
  description: string;
  input: I;
  output: O;
  annotations: OpAnnotations;
  /** Minimum token scopes required to call this op (rule 10). */
  scopes: Scope[];
  /** Defaults per rule 8: http true always; mcp true for core ops, false for plugin ops. */
  expose?: Partial<OpExpose>;
  /** Text for MCP `content[0].text` and for the HTTP-adjacent CLI. Required iff expose.mcp !== false (rule 11). */
  render?: (output: z.output<O>) => string;
  handler: (input: z.output<I>, ctx: OpContext) => Promise<z.output<O>> | z.output<O>;
}

export function defineOp<I extends z.ZodType, O extends z.ZodType>(
  def: OpDef<I, O>,
): OpDef<I, O> {
  return def;
}

export type OpErrorCode =
  | "not_found"
  | "invalid"
  | "conflict"
  | "forbidden"
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "internal";

export const HTTP_STATUS: Record<OpErrorCode, number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  rate_limited: 429,
  too_large: 413,
  internal: 500,
};

export class OpError extends Error {
  constructor(
    public code: OpErrorCode,
    message: string,
    public hint?: string,
    public details?: Json,
  ) {
    super(message);
  }
}

/** Shared by the HTTP and MCP mounts (§1.5, §1.7) so both render the same envelope for the same error. */
export function toErrorBody(e: unknown): { error: { code: OpErrorCode; message: string; hint?: string; details?: Json } } {
  if (e instanceof OpError) return { error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  return { error: { code: "internal", message: "internal error" } };
}
```

#### 1.3 `OpContext`

```ts
import type { DatabaseSync } from "node:sqlite"; // packages/server store driver (PLAN §3)
import type { Op } from "@nooklet/core"; // packages/core/src/ops.ts
import type { DataApi } from "@nooklet/plugin-api"; // §3 — the isomorphic facade, re-exported for server-side use too

/** Origin kinds, verbatim from 00-conventions.md §Vocabulary. */
export type OriginKind =
  | "user"
  | "api"
  | "mcp"
  | "sync"
  | "plugin"
  | "import"
  | "mirror"
  | "system";

export interface Origin {
  kind: OriginKind;
  deviceId?: string; // present for "sync"
  pluginId?: string; // present for "plugin"
  tokenId?: string; // present for "api" / "mcp"
}

/** Human-readable attribution for the audit log (00-conventions.md: "token label, device name, plugin id"). */
export interface Actor {
  label: string;
  tokenId?: string;
}

export interface ApplyOpsResult {
  seq: number; // change-log position after this write; feeds changes.since
  applied: Op[];
  rejected: Array<{ op: Op; reason: string }>; // e.g. server-corrected structure ops
}

export interface ServerConfig {
  dataDir: string; // $NOOKLET_DATA
  graphId: string;
  timezone: string;
  port: number;
  mirror: { enabled: boolean };
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface OpContext {
  /** node:sqlite connections (00-conventions.md §Storage: one writer, separate readers). */
  db: { write: DatabaseSync; read: DatabaseSync };
  /**
   * The isomorphic read/write facade (§3), built on top of `db` + `applyOps`. The common path
   * for handlers; drop to `db`/`applyOps` directly only for cross-table SQL (search, backlinks)
   * that `DataApi` does not expose. Not one of the task's original five fields — added because
   * op handlers need a usable facade; see Open issues #7.
   */
  data: DataApi;
  /** The single write path (ADR 003 owns its full implementation and op-conflict semantics). */
  applyOps(ops: Op[], meta?: { batchId?: string }): Promise<ApplyOpsResult>;
  origin: Origin;
  actor: Actor;
  scopes: Scope[];
  config: ServerConfig;
  log: Logger;
  transport: "http" | "mcp" | "internal";
  requestId: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}
```

#### 1.4 The registry

```ts
// packages/server/src/ops/registry.ts
import type { OpDef } from "./define-op.js";

const OP_NAME_RE = /^([a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+|search|batch)$/;

export class OpRegistry {
  private ops = new Map<string, OpDef & { owner: string }>();

  register(op: OpDef, owner: "core" | string = "core"): void {
    if (!OP_NAME_RE.test(op.name)) {
      throw new Error(`op name "${op.name}" must be dotted lower-case segments, e.g. "page.read"`);
    }
    if (this.ops.has(op.name)) {
      throw new Error(`op "${op.name}" is already registered (by "${this.ops.get(op.name)!.owner}")`);
    }
    if ((op.expose?.mcp ?? owner === "core") !== false && !op.render) {
      throw new Error(`op "${op.name}" is exposed to MCP but has no render()`); // rule 11
    }
    this.ops.set(op.name, { ...op, owner });
  }

  /** Used by a plugin's Disposable to remove its own op on deactivate/reload. */
  unregister(name: string): void {
    this.ops.delete(name);
  }

  list(): Array<OpDef & { owner: string }> {
    return [...this.ops.values()].sort((a, b) => a.name.localeCompare(b.name)); // deterministic: MCP prompt-cache friendly
  }

  get(name: string): OpDef | undefined {
    return this.ops.get(name);
  }
}
```

#### 1.5 Mount 1 of 3 — HTTP router

```ts
// packages/server/src/http.ts
import { Hono, type Context } from "hono";
import { z } from "zod";
import { HTTP_STATUS, toErrorBody, type OpContext, type OpDef, type OpExpose } from "./ops/define-op.js";
import type { OpRegistry } from "./ops/registry.js";

export function httpExpose(op: OpDef): Required<OpExpose>["http"] {
  return op.expose?.http ?? true;
}
export function mcpExpose(op: OpDef, owner: string): Required<OpExpose>["mcp"] {
  return op.expose?.mcp ?? owner === "core";
}
function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ":$1"); // OpenAPI "{param}" -> Hono ":param"
}

export function mountHttp(app: Hono, reg: OpRegistry, buildOpCtx: (c: Context, op: OpDef) => Promise<OpContext | null>): void {
  for (const op of reg.list()) {
    const http = httpExpose(op);
    if (http === false) continue;

    const run = async (c: Context, raw: unknown) => {
      const parsed = op.input.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: { code: "invalid", message: z.prettifyError(parsed.error), hint: "fix the listed fields and retry" } }, 400);
      }
      const ctx = await buildOpCtx(c, op); // auth middleware: builds OpContext (actor, origin, scopes, db, ...) or null on bad token
      if (!ctx) return c.json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);
      if (!op.scopes.every((s) => ctx.scopes.includes(s))) {
        return c.json({ error: { code: "forbidden", message: `requires scope(s): ${op.scopes.join(", ")}` } }, 403); // rule 10
      }
      try {
        return c.json(await op.handler(parsed.data, ctx));
      } catch (e) {
        const body = toErrorBody(e);
        return c.json(body, HTTP_STATUS[body.error.code] ?? 500);
      }
    };

    app.post(`/api/v1/${op.name}`, (c) => c.req.json().then((b) => run(c, b))); // rule 9: canonical route
    if (op.annotations.readOnlyHint) {
      app.get(`/api/v1/${op.name}`, (c) => run(c, JSON.parse(c.req.query("input") ?? "{}")));
    }
    if (typeof http === "object") {
      const alias = http;
      app.on(alias.method, `/api/v1${toHonoPath(alias.path)}`, (c) => run(c, { ...c.req.param(), ...c.req.query() }));
    }
  }
}
```

#### 1.6 Mount 2 of 3 — OpenAPI via `z.toJSONSchema`

```ts
// packages/server/src/http.ts (continued)
export function buildOpenApi(reg: OpRegistry) {
  const paths: Record<string, unknown> = {};
  for (const op of reg.list()) {
    if (httpExpose(op) === false) continue;
    paths[`/api/v1/${op.name}`] = {
      post: {
        operationId: op.name,
        summary: op.summary,
        description: op.description,
        tags: [op.name.split(".")[0]],
        "x-annotations": op.annotations,
        "x-scopes": op.scopes,
        requestBody: {
          required: true,
          content: { "application/json": { schema: z.toJSONSchema(op.input, { target: "openapi-3.0" }) } },
        },
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: z.toJSONSchema(op.output, { target: "openapi-3.0" }) } } },
          default: { description: "Error", content: { "application/json": { schema: ErrorEnvelopeJsonSchema } } },
        },
        security: [{ bearer: [] }],
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "nooklet API", version: "1" },
    paths,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  };
}

const ErrorEnvelopeJsonSchema = z.toJSONSchema(
  z.object({
    error: z.object({
      code: z.enum(["not_found", "invalid", "conflict", "forbidden", "unauthorized", "rate_limited", "too_large", "internal"]),
      message: z.string(),
      hint: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  { target: "openapi-3.0" },
);
```

`GET /openapi.json` is mounted once as `app.get("/openapi.json", (c) => c.json(buildOpenApi(reg)))`.

#### 1.7 Mount 3 of 3 — MCP tools via `@modelcontextprotocol/server` v2

```ts
// packages/server/src/mcp.ts
import type { Hono } from "hono";
import { createMcpHandler, McpServer, requireBearerAuth } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { toErrorBody, type OpContext } from "./ops/define-op.js";
import type { OpRegistry } from "./ops/registry.js";
import { mcpExpose } from "./http.js"; // shared with the HTTP mount so exposure defaults never diverge (rule 8)

export function buildMcp(reg: OpRegistry, deps: { version: string; contextFromAuth: (authInfo: unknown) => Omit<OpContext, "transport" | "requestId" | "idempotencyKey" | "signal"> }) {
  return createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer(
        { name: "nooklet", version: deps.version },
        { instructions: SERVER_INSTRUCTIONS }, // <= 2 KB: Claude Code truncates server instructions there
      );
      const base = deps.contextFromAuth(authInfo);
      for (const op of reg.list()) {
        if (mcpExpose(op, op.owner) === false) continue;
        if (!op.scopes.every((s) => base.scopes.includes(s))) continue; // rule 10: not even listed for this token

        const mcp = op.expose?.mcp;
        server.registerTool(
          op.name.replace(/\./g, "_"),
          {
            title: op.summary,
            description: op.description,
            inputSchema: op.input,
            outputSchema: op.output,
            annotations: op.annotations,
            _meta: {
              ...(typeof mcp === "object" && mcp.alwaysLoad ? { "anthropic/alwaysLoad": true } : {}),
              ...(typeof mcp === "object" && mcp.requiresUserInteraction ? { "anthropic/requiresUserInteraction": true } : {}),
              ...(typeof mcp === "object" && mcp.maxResultSizeChars ? { "anthropic/maxResultSizeChars": mcp.maxResultSizeChars } : {}),
            },
          },
          async (input, mcpCtx) => {
            try {
              const out = await op.handler(input, {
                ...base,
                transport: "mcp",
                requestId: mcpCtx.mcpReq?.id ?? crypto.randomUUID(),
                signal: mcpCtx.mcpReq?.signal,
              });
              return { content: [{ type: "text", text: op.render!(out) }], structuredContent: out }; // rule 11: render required here
            } catch (e) {
              const { error } = toErrorBody(e);
              return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}` }] };
            }
          },
        );
      }
      return server;
    },
    { legacy: "stateless" }, // spec 2026-07-28 stateless core; serves 2025-era clients per-request too
  );
}

const SERVER_INSTRUCTIONS = `nooklet is a block outliner: pages, daily journals, nested blocks, [[refs]], #tags, key:: value properties.
Use search to find things; page.read/block.read to read (block ids look like ^1k7f3q9xz2hav4); page.append/block.insert to write.
Dates are YYYY-MM-DD ("today" accepted).`;

export function mountMcp(app: Hono, handler: ReturnType<typeof createMcpHandler>, verifyToken: (token: string) => Promise<unknown>) {
  const mcpApp = createMcpHonoApp(); // Host/Origin validation on by default (DNS rebinding)
  const auth = requireBearerAuth({ verifier: { verifyAccessToken: verifyToken }, requiredScopes: ["read"] });
  mcpApp.all("/mcp", auth, (c) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody"), authInfo: c.get("authInfo") }));
  app.route("/", mcpApp);
}
```

#### 1.8 Typed client (fourth consumer of the same registry, not a "mount" but built from `list()` the same way)

```ts
// packages/plugin-api/src/client.ts
import { z } from "zod";
import type { OpDef } from "./op-def.js"; // re-exported from packages/server/src/ops/define-op.ts

export function createOpClient<Ops extends readonly OpDef[]>(ops: Ops, baseUrl: string, token: string) {
  type Name = Ops[number]["name"];
  return async function call<N extends Name>(
    name: N,
    input: z.input<Extract<Ops[number], { name: N }>["input"]>,
    opts?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<z.output<Extract<Ops[number], { name: N }>["output"]>> {
    const res = await fetch(`${baseUrl}/api/v1/${name}`, {
      method: "POST",
      signal: opts?.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error.message), body.error);
    return body;
  };
}
```

### 2. Plugin manifest

#### 2.1 `package.json#nooklet`

```ts
// packages/plugin-api/src/manifest.ts
export type PluginPermission = "net" | "fs" | "shell" | "env"; // informational in v1 (trusted ESM); enforced when a worker/sandbox host ships (ADR 007)

export type JsonSchema = Record<string, unknown>; // JSON Schema 2020-12; the host renders a settings form from it

export interface CommandContribution {
  id: string; // matches a Command.id this plugin will register in code
  title: string;
  category?: string;
  when?: string;
  defaultKeys?: CommandKeys; // see §7.1 — shown in the palette/keymap UI before the plugin loads
}
export interface SlashContribution {
  id: string;
  label: string;
  keywords?: string[];
}
export interface KeybindingContribution {
  key: string;
  command: string;
  when?: string;
}
export interface PluginContributes {
  commands?: CommandContribution[];
  slash?: SlashContribution[];
  keybindings?: KeybindingContribution[];
}

export interface PluginManifest {
  id: string; // stable, [a-z0-9-]+; namespaces kv/settings/routes/rpc
  name?: string; // display name; defaults to id
  api: "1"; // plugin API major this plugin targets (rule 15, §6)
  server?: string; // relative path to the server entry module
  client?: string; // relative path to the client entry module
  permissions?: PluginPermission[];
  settings?: JsonSchema;
  contributes?: PluginContributes;
  experimental?: boolean; // required to use ctx.experimental.*
}
```

Example (`plugins/mermaid-tools/package.json`, abbreviated to the relevant fields — the full
worked example is §Examples):

```jsonc
{
  "name": "nooklet-plugin-mermaid-tools",
  "version": "0.1.0",
  "type": "module",
  "nooklet": {
    "id": "mermaid-tools",
    "name": "Mermaid + word count",
    "api": "1",
    "server": "./src/server.ts",
    "client": "./src/client.ts",
    "permissions": [],
    "contributes": { "slash": [{ "id": "mermaid", "label": "Mermaid diagram" }] }
  },
  "engines": { "nooklet": ">=0.4" },
  "dependencies": { "mermaid": "^11" }
}
```

#### 2.2 Single-file `*.plugin.ts`

For quick scripts (`plugins/<name>.plugin.ts`), no `package.json` is needed:

```ts
// packages/plugin-api/src/define-plugin.ts
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
```

```ts
// plugins/wordcount.plugin.ts
import { definePlugin } from "@nooklet/plugin-api";

export default definePlugin({
  id: "wordcount",
  api: "1",
  server: { activate(ctx) {
    /* ... */
  } },
  client: { activate(ctx) {
    /* ... */
  } },
});
```

The loader (`packages/server/src/plugins/host.ts`, out of scope here — this spec fixes types, not
the bundler/hot-reload mechanics already described in `research/05-plugins.md` §4) synthesizes an
equivalent `PluginManifest` from the inline fields for single-file plugins; the discovery order
(directory `package.json#nooklet`, config-listed npm packages, `*.plugin.ts`) is unchanged from that
research report.

### 3. Shared `DataApi`

References `packages/core/src/model.ts` (`Block`, `Page`, `BlockId`, `PageId`, `Properties`) and
`packages/core/src/ops.ts` (`Op`) directly — this spec does not redefine those. `BlockNode` (a
`Block` with materialized `children`) is a plugin-API-level convenience type, not part of
`packages/core`.

```ts
// packages/plugin-api/src/data.ts
import type { Block, BlockId, Page, PageId, Properties } from "@nooklet/core";

export interface BlockNode extends Block {
  children: BlockNode[];
}

export interface PropertyPatch {
  [key: string]: string | null; // null unsets the key (rule 17)
}

export interface BlocksApi {
  get(id: BlockId): Promise<Block | null>;
  children(parent: BlockId | { page: PageId }): Promise<Block[]>;
  tree(root: BlockId | { page: PageId }, opts?: { depth?: number }): Promise<BlockNode[]>;
  insert(spec: {
    content: string;
    properties?: Properties;
    page?: PageId;
    parent?: BlockId;
    after?: BlockId | "first" | "last";
  }): Promise<Block>;
  update(id: BlockId, patch: { content?: string; properties?: PropertyPatch; collapsed?: boolean }): Promise<Block>;
  move(id: BlockId, to: { page?: PageId; parent?: BlockId; after?: BlockId | "first" | "last" }): Promise<void>;
  delete(id: BlockId, opts?: { children?: "delete" | "lift" }): Promise<void>;
}

export interface PagesApi {
  get(ref: PageId | { name: string }): Promise<Page | null>;
  list(opts?: { namespace?: string; kind?: "page" | "journal"; limit?: number; cursor?: string }): Promise<{ items: Page[]; cursor?: string }>;
  create(spec: { name: string; properties?: Properties; firstBlock?: string }): Promise<Page>;
  rename(id: PageId, name: string): Promise<Page>; // rewrites [[refs]] in content in the same tx
  delete(id: PageId): Promise<void>;
  namespaceTree(root: string): Promise<Array<{ page: Page; children: unknown[] }>>;
  /** date is YYYY-MM-DD (rule 18), or "today" | "yesterday" | "tomorrow". */
  journal(date: string, opts?: { create?: boolean }): Promise<Page | null>;
}

export interface QueryApi {
  blocks(q: {
    text?: string;
    page?: PageId | { namespace: string };
    refs?: { to: PageId | BlockId };
    tags?: string[];
    property?: { key: string; value?: string; op?: "eq" | "neq" | "gt" | "lt" | "exists" | "contains" };
    updatedAfter?: number;
    limit?: number;
    cursor?: string;
    order?: "updated" | "created" | "page";
  }): Promise<{ items: Block[]; cursor?: string }>;
  linkedRefs(target: PageId | BlockId): Promise<Array<{ page: Page; blocks: Block[] }>>;
  unlinkedRefs(page: PageId): Promise<Array<{ page: Page; blocks: Block[] }>>;
  semantic(text: string, opts?: { limit?: number; page?: PageId }): Promise<Array<{ block: Block; score: number }>>;
}

export interface DataApi {
  blocks: BlocksApi;
  pages: PagesApi;
  query: QueryApi;
  /** One atomic write, one change-event batch. */
  transact<T>(fn: (tx: DataApi) => Promise<T> | T, opts?: { label?: string }): Promise<T>;
}
```

Server-side `DataApi` is a thin wrapper over core services + `applyOps`; client-side `DataApi` is
HTTP calls to the same ops plus the local sync replica cache for reads (rule 16). Both compile
against this one interface, so shared plugin code that only touches `ctx.data` runs unmodified on
either half.

### 4. Server `PluginContext`

```ts
// packages/plugin-api/src/server-context.ts
import type { z } from "zod";
import type { Block, BlockId, Op, Page, PageId } from "@nooklet/core";
import type { DataApi } from "./data.js"; // §3
import type { Disposable } from "./disposable.js"; // §6
import type { HttpMethod, Json, JsonSchema, OpAnnotations, OpDef, PluginPermission } from "./index.js";

export interface PendingWriteTx {
  id: string;
  origin: Origin;
  ops: Op[]; // mutable: a beforeWrite handler may edit this array, or throw to veto
}
export type BeforeWriteHandler = (tx: PendingWriteTx) => void | Promise<void>;

export interface ServerChangeEvents {
  "block.created": { block: Block; origin: Origin; txId: string };
  "block.updated": { block: Block; before: Block; origin: Origin; txId: string };
  "block.moved": { block: Block; before: { pageId: PageId; parentId: BlockId | null; order: string }; origin: Origin; txId: string };
  "block.deleted": { block: Block; origin: Origin; txId: string };
  "page.created": { page: Page; origin: Origin; txId: string };
  "page.renamed": { page: Page; before: Page; origin: Origin; txId: string };
  "page.updated": { page: Page; before: Page; origin: Origin; txId: string };
  "page.deleted": { page: Page; origin: Origin; txId: string };
  "tx.committed": { txId: string; origin: Origin; ops: Op[] };
}

export interface PluginCommand {
  id: string; // "mermaid-tools.insert" — host prefixes plugin commands with the plugin id
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
export type McpToolHandler = (args: Json, extra: { origin: Origin }) => Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Json; isError?: boolean }>;
export type McpResourceReader = (uri: URL, params: Record<string, string>) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>;

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
  run(input: { files: Array<{ name: string; bytes(): Promise<Uint8Array> }> }, target: { namespace?: string }, report: (msg: string) => void): Promise<{ pages: number; blocks: number }>;
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
  search(query: string, opts: { limit: number }): Promise<Array<{ blockId: BlockId; score: number }>>;
}

export interface RouteInfo {
  params: Record<string, string>;
  origin: Origin;
}

export interface ServerPluginContext {
  readonly plugin: { id: string; version: string; dir: string; dataDir: string; permissions: PluginPermission[] };
  readonly host: { version: string; apiVersion: "1" };
  readonly data: DataApi;

  on<E extends keyof ServerChangeEvents>(event: E, handler: (payload: ServerChangeEvents[E]) => void | Promise<void>): Disposable;
  beforeWrite(handler: BeforeWriteHandler, opts?: { priority?: number }): Disposable;

  registerCommand(cmd: PluginCommand): Disposable;
  readonly rpc: { expose(name: string, fn: RpcFn): Disposable };

  /** Mount a Hono sub-app, or a single (method, path, handler) route, under /api/plugins/<id>/. */
  registerRoute(app: import("hono").Hono): Disposable;
  registerRoute(method: HttpMethod, path: string, handler: (req: Request, info: RouteInfo) => Response | Promise<Response>, opts?: { auth?: "required" | "none" }): Disposable;

  registerMcpTool(name: string, def: McpToolDef, handler: McpToolHandler): Disposable;
  registerMcpResource(name: string, uriTemplate: string, def: { description?: string; mimeType?: string }, read: McpResourceReader): Disposable;

  registerJob(job: JobDef): Disposable;
  registerImporter(importer: ImporterDef): Disposable;
  registerExporter(exporter: ExporterDef): Disposable;
  registerEmbeddingProvider(provider: EmbeddingProviderDef): Disposable;
  registerSearchProvider(provider: SearchProviderDef): Disposable;

  /** The full defineOp escape hatch (ADR 008): the same registry HTTP/MCP mount as core ops. */
  readonly ops: { register(op: OpDef): Disposable };

  readonly settings: { get<T = Json>(): T; set<T extends Json>(patch: Partial<T>): Promise<void>; onChange(cb: (next: Json, prev: Json) => void): Disposable };
  readonly kv: { get<T extends Json>(key: string): Promise<T | null>; set(key: string, value: Json): Promise<void>; delete(key: string): Promise<void>; list(prefix?: string): Promise<string[]> };

  readonly log: Logger;
  readonly subscriptions: Disposable[]; // host-managed; see rule 12
  readonly experimental: Record<string, unknown>; // requires manifest.experimental: true
}
```

`plugin_kv` and `plugin_settings` (SQL, `00-conventions.md` naming: snake_case tables, `_json`
suffix on JSON columns):

```sql
CREATE TABLE plugin_settings (
  plugin_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
```

### 5. Client `PluginContext`

```ts
// packages/plugin-api/src/client-context.ts
import type { Block, BlockId, Page, PageId } from "@nooklet/core";
import type { DataApi } from "./data.js"; // §3
import type { Disposable } from "./disposable.js"; // §6
import type { Json } from "./json.js";
import type { ServerChangeEvents } from "./server-context.js"; // §4 — the client half receives the same events over the sync socket

export type CodeBlockRenderer =
  | { render(source: string, el: HTMLElement, info: RenderInfo): void | Disposable | Promise<void | Disposable> } // trusted: full DOM
  | { html(source: string, info: RenderInfo): string | Promise<string> }; // sandbox-able: painted into an iframe in v2
export type MacroRenderer =
  | { render(args: string[], el: HTMLElement, info: RenderInfo & { raw: string }): void | Disposable | Promise<void | Disposable> }
  | { html(args: string[], info: RenderInfo & { raw: string }): string | Promise<string> };
export interface RenderInfo {
  block: Block;
  page: Page;
  lang?: string;
  meta?: string;
  editing: boolean;
  signal: AbortSignal;
}

export interface EditorApi {
  currentPage(): Page | null;
  currentBlock(): Block | null;
  selection(): { blocks: BlockId[]; text?: string };
  insertText(text: string, opts?: { cursor?: number }): Promise<void>;
  replaceBlock(id: BlockId, content: string): Promise<void>;
  insertBlockAfter(id: BlockId, content: string): Promise<Block>;
  focusBlock(id: BlockId, opts?: { at?: "start" | "end" | number }): void;
  openPage(ref: PageId | { name: string }, opts?: { sidebar?: boolean }): Promise<void>;
  navigate(path: string): void;
}

export interface SlashItem {
  id: string;
  label: string;
  icon?: string;
  keywords?: string[];
  run(editor: EditorApi): void | Promise<void>;
}
export interface PanelDef {
  id: string;
  title: string;
  icon?: string;
  side?: "left" | "right";
  mount(el: HTMLElement, api: { close(): void; setTitle(t: string): void }): Disposable | void;
}
export interface BlockMenuItemDef {
  id: string;
  title: string;
  icon?: string;
  when?(block: Block): boolean;
  run(block: Block, editor: EditorApi): void;
}
export interface PageMenuItemDef {
  id: string;
  title: string;
  icon?: string;
  run(page: Page): void;
}
export interface ToolbarItemDef {
  id: string;
  title: string;
  icon: string;
  run(): void;
}
export interface StatusItemDef {
  id: string;
  mount(el: HTMLElement): Disposable | void;
}

export interface ClientPluginContext {
  readonly plugin: { id: string; version: string };
  readonly host: { version: string; apiVersion: "1"; platform: "desktop" | "mobile"; theme: "light" | "dark" };
  readonly data: DataApi;

  on<E extends keyof ServerChangeEvents>(event: E, handler: (p: ServerChangeEvents[E]) => void): Disposable;
  on(event: "page.opened", handler: (p: { page: Page }) => void): Disposable;
  // Added 2026-09-13 (ADR 023): what editor.currentPage() answers changed — another page, no page, a change to its rows, or the server caught up with a local edit to it
  on(event: "page.changed", handler: (p: { page: Page | null }) => void): Disposable;
  on(event: "block.focused" | "block.blurred", handler: (p: { block: Block }) => void): Disposable;
  on(event: "selection.changed", handler: (p: { blocks: BlockId[] }) => void): Disposable;

  registerCommand(cmd: { id: string; title: string; description?: string; category?: string; icon?: string; when?: string; run(info: { editor: EditorApi }): void | Promise<void> }): Disposable;
  registerKeybinding(keys: string, commandId: string): Disposable;
  registerSlashCommand(item: SlashItem): Disposable;
  registerCodeBlockRenderer(lang: string, r: CodeBlockRenderer): Disposable;
  registerMacroRenderer(name: string, r: MacroRenderer): Disposable;
  registerPanel(p: PanelDef): Disposable;
  registerMenuItem(target: "block", item: BlockMenuItemDef): Disposable;
  registerMenuItem(target: "page", item: PageMenuItemDef): Disposable;
  registerToolbarItem(item: ToolbarItemDef): Disposable;
  registerStatusItem(item: StatusItemDef): Disposable;

  readonly theme: { style(css: string): Disposable; vars(vars: Record<`--${string}`, string>): Disposable };
  readonly editor: EditorApi;

  notify(message: string, opts?: { kind?: "info" | "success" | "warning" | "error"; timeout?: number }): void;
  confirm(message: string): Promise<boolean>;
  prompt(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string | null>;
  modal(m: { title: string; mount(el: HTMLElement, api: { close(): void }): Disposable | void }): { close(): void };

  readonly settings: { get<T = Json>(): T; onChange(cb: (next: Json, prev: Json) => void): Disposable };
  readonly rpc: { call<T extends Json = Json>(name: string, ...args: Json[]): Promise<T> }; // calls the plugin's own server half (ctx.rpc.expose)

  readonly log: Logger;
  readonly subscriptions: Disposable[];
  readonly experimental: Record<string, unknown>;
}
```

Design notes: renderers accept either `render(el)` (trusted, full DOM — v1 default) or `html()`
(pure function of source → string), per ADR 007; the sandboxed v2 client host only calls the
`html()` form and paints it into a sandboxed iframe. `ctx.rpc.call` is the client→server bridge
for a plugin's own private functions (`ctx.rpc.expose` on the server half); it is not the same
path as `ctx.data`, which talks to core, not to the plugin's own server code.

**What the v1 client host implements (2026-09-13, ADR 023).** `apps/web` compiles the built-in
plugins' client halves into its build and activates them at startup; it does not load client
halves from `<dataDir>/plugins`. Implemented: `plugin`, `host`, `on("page.opened")`,
`on("page.changed")`, `registerCommand`, `registerSlashCommand` (a `plugin.<id>.slash<Item>`
command gated on `editorFocused`, plus a slash row after the core rows),
`registerCodeBlockRenderer` (a fence whose info string matches; `query` is reserved; one renderer
per language), `registerStatusItem` (top bar), `editor.currentPage` (the `/page/<name>` route's
page, else `null`), `editor.insertText`, `editor.openPage` (not `sidebar`), `editor.navigate`,
`rpc.call`, `log`, `subscriptions`, `experimental` (empty). Everything else — `data`, the
server-shaped events, `block.focused`/`blurred`, `selection.changed`, keybindings, macros, panels,
menus, toolbar, theme, dialogs, settings, the other `editor` methods — throws
`"<member> is not supported by nooklet's client plugin host yet (ADR 023)"`; thrown inside
`activate()`, that marks the plugin `error` and leaves the others running.
`RenderInfo.block`/`page` come from the local replica.

### 6. `Disposable` and the lifecycle contract

```ts
// packages/plugin-api/src/disposable.ts
export interface Disposable {
  dispose(): void;
}
```

Contract (rule 12): every `register*`/`on`/`beforeWrite`/`ops.register` call returns a
`Disposable`. The host — not the plugin — pushes it onto that plugin's private list (exposed
read-only as `ctx.subscriptions` for introspection/tests). When a plugin is deactivated (explicit
disable, hot reload, or server shutdown) the host calls `dispose()` on every entry, **in reverse
registration order**, then calls the plugin module's own `deactivate()` if present. `deactivate()`
exists only for cleanup the plugin did *outside* a `register*` call (an interval started with raw
`setInterval`, an open child process); a plugin that only ever used `register*`/`on` needs no
`deactivate()` at all. This is Obsidian's `Component`/`register()` pattern, made fully automatic:
Obsidian requires the author to call `this.register(disposable)`; here every host-owned
registration function does that for you.

```ts
export interface ServerPluginModule {
  activate(ctx: ServerPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export interface ClientPluginModule {
  activate(ctx: ClientPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

### 7. `Command` and v1 examples

#### 7.1 The `Command` type

```ts
// packages/plugin-api/src/command.ts
export type Platform = "mac" | "win" | "linux";

/** "Mod" = Cmd on mac, Ctrl on win/linux — set `default` for the common case, override per-platform only when keys differ. */
export interface CommandKeys {
  default?: string;
  mac?: string;
  win?: string;
  linux?: string;
}

export interface Command {
  id: string; // "area.verb", rule 20
  title: string;
  description: string;
  category: string; // palette grouping: "Navigation" | "Editing" | "Tasks" | "Properties" | "Search" | "Sync" | "Settings" | plugin-defined
  /**
   * A boolean expression string over host-defined context keys (editorFocus, blockSelected, ...).
   * The full grammar and context-key list are owned by commands-and-keymap.md; this spec fixes
   * only the field's type (string, evaluated by the host).
   */
  when?: string;
  defaultKeys?: CommandKeys;
  run(args: Json | undefined, info: { editor?: EditorApi; origin: Origin }): Json | void | Promise<Json | void>;
}
```

`commands-and-keymap.md` owns: the full `when`-clause grammar and context keys, the exhaustive
default keymap table (every core command × platform), conflict detection, and the
`keybindings.json` user-override format (`{ key, command, when }`, per ADR 009). It MUST reuse
`Command`, `CommandKeys`, and `Platform` exactly as defined here.

#### 7.2 Representative v1 commands

Only keys explicitly given in PLAN.md §7 ("Editor") are shown as defaults below; every other
command is real (drawn from PLAN §§2, 8, 9, 12) but intentionally left without a `defaultKeys` to
avoid inventing a binding that belongs to `commands-and-keymap.md`.

```ts
export const CORE_COMMANDS: Command[] = [
  // Navigation
  { id: "nav.journals", title: "Open journals", description: "Go to the journal stream.", category: "Navigation", run: (_, { editor }) => editor?.navigate("/journals") },
  { id: "nav.back", title: "Go back", description: "Navigate to the previous page.", category: "Navigation", run: (_, { editor }) => editor?.navigate("back") },
  { id: "palette.open", title: "Open command palette", description: "Search commands and pages.", category: "Navigation", defaultKeys: { default: "Mod+K" }, run: () => {} },

  // Editing (keys per PLAN §7's keyboard contract)
  { id: "block.indent", title: "Indent block", description: "Make the current block a child of its previous sibling.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Tab" }, run: () => {} },
  { id: "block.outdent", title: "Outdent block", description: "Move the current block up a level (logical outdent).", category: "Editing", when: "editorFocus", defaultKeys: { default: "Shift+Tab" }, run: () => {} },
  { id: "block.moveUp", title: "Move block up", description: "Move the block (and its children) before its previous sibling.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Alt+ArrowUp" }, run: () => {} },
  { id: "block.moveDown", title: "Move block down", description: "Move the block (and its children) after its next sibling.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Alt+ArrowDown" }, run: () => {} },
  { id: "block.toggleCollapse", title: "Collapse/expand block", description: "Toggle whether the block's children are shown.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Mod+ArrowUp" }, run: () => {} },
  { id: "block.zoomIn", title: "Zoom into block", description: "Make this block the page root.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Mod+." }, run: () => {} },
  { id: "block.select", title: "Select block", description: "Exit text editing and select the whole block (Esc); Shift+Up/Down then extends the selection.", category: "Editing", when: "editorFocus", defaultKeys: { default: "Escape" }, run: () => {} },

  // Tasks
  { id: "task.cycle", title: "Cycle task status", description: "None -> TODO -> DOING -> DONE -> none.", category: "Tasks", when: "editorFocus", defaultKeys: { default: "Mod+Enter" }, run: () => {} },
  { id: "task.toggleDone", title: "Toggle done", description: "Mark the block DONE or clear it; same action as clicking the checkbox.", category: "Tasks", run: () => {} },
  { id: "task.setWaiting", title: "Set WAITING", description: "Set the task marker to WAITING.", category: "Tasks", run: () => {} },

  // Search
  { id: "search.open", title: "Search", description: "Open full-text/semantic search across the graph.", category: "Search", run: () => {} },
  { id: "search.related", title: "Show related", description: "Show pages/blocks related to the current page by embedding similarity.", category: "Search", run: () => {} },
];
```

## Examples

### Worked example: one plugin, both halves, every interface type in use

Adds a `/mermaid` code-block renderer on the client and a `page.wordcount` op exposed as both HTTP
and MCP on the server.

```jsonc
// plugins/mermaid-tools/package.json
{
  "name": "nooklet-plugin-mermaid-tools",
  "version": "0.1.0",
  "type": "module",
  "nooklet": {
    "id": "mermaid-tools",
    "name": "Mermaid + word count",
    "api": "1",
    "server": "./src/server.ts",
    "client": "./src/client.ts",
    "permissions": [],
    "contributes": { "slash": [{ "id": "mermaid", "label": "Mermaid diagram" }] }
  },
  "engines": { "nooklet": ">=0.4" },
  "dependencies": { "mermaid": "^11" }
}
```

```ts
// plugins/mermaid-tools/src/server.ts
import { defineOp, OpError } from "@nooklet/plugin-api";
import { z } from "zod";
import type { ServerPluginModule } from "@nooklet/plugin-api";

export default {
  async activate(plugin) {
    plugin.ops.register(
      defineOp({
        name: "page.wordcount",
        summary: "Count words in a page",
        description:
          "Counts words across all blocks of a page or journal day. Read-only and cheap; " +
          "call before deciding whether to read the full page.",
        input: z.object({
          page: z.string().min(1).max(512).describe('Page name, journal date (YYYY-MM-DD), or "today"'),
        }).strict(),
        output: z.object({ page: z.string(), block_count: z.number().int(), word_count: z.number().int() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        scopes: ["read"],
        expose: { http: true, mcp: true }, // plugin ops default mcp:false (rule 8) — opt in explicitly
        render: (out) => `${out.page}: ${out.word_count} words across ${out.block_count} blocks`,
        async handler({ page }, opCtx) {
          const target = await opCtx.data.pages.get({ name: page });
          if (!target) throw new OpError("not_found", `no page named "${page}"`, "check the exact name with page.list");
          const tree = await opCtx.data.blocks.tree({ page: target.id });
          let blockCount = 0;
          let wordCount = 0;
          const walk = (nodes: typeof tree) => {
            for (const n of nodes) {
              blockCount++;
              wordCount += n.content.split(/\s+/).filter(Boolean).length;
              walk(n.children);
            }
          };
          walk(tree);
          return { page: target.name, block_count: blockCount, word_count: wordCount };
        },
      }),
    );
  },
} satisfies ServerPluginModule;
```

```ts
// plugins/mermaid-tools/src/client.ts
import type { ClientPluginModule } from "@nooklet/plugin-api";

export default {
  async activate(ctx) {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });

    ctx.registerCodeBlockRenderer("mermaid", {
      async render(source, el) {
        const { svg } = await mermaid.render(`m-${crypto.randomUUID()}`, source);
        el.innerHTML = svg;
      },
    });

    ctx.registerSlashCommand({
      id: "mermaid",
      label: "Mermaid diagram",
      keywords: ["diagram", "graph"],
      run: (editor) => editor.insertText("```mermaid\ngraph TD\n  A --> B\n```"),
    });
  },
} satisfies ClientPluginModule;
```

No `deactivate()` on either half: both registrations (`ops.register`, `registerCodeBlockRenderer`,
`registerSlashCommand`) return `Disposable`s the host already tracks and disposes on unload (rule
12).

JSON examples of this op in use:

```
POST /api/v1/page.wordcount
{ "page": "today" }

200 OK
{ "page": "2026-09-10", "blockCount": 14, "wordCount": 132 }
```

```
POST /api/v1/page.wordcount
{ "page": "Nonexistent Page" }

404 Not Found
{ "error": { "code": "not_found", "message": "no page named \"Nonexistent Page\"", "hint": "check the exact name with page.list" } }
```

The MCP `tools/list` entry this op produces (name = `page_wordcount`, `.` → `_`):

```json
{
  "name": "page_wordcount",
  "title": "Count words in a page",
  "description": "Counts words across all blocks of a page or journal day. Read-only and cheap; call before deciding whether to read the full page.",
  "inputSchema": {
    "type": "object",
    "properties": { "page": { "type": "string", "maxLength": 512, "description": "Page name, journal date (YYYY-MM-DD), or \"today\"" } },
    "required": ["page"],
    "additionalProperties": false
  },
  "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
}
```

## Versioning and compatibility

1. `nooklet.api` is a **string major** (`"1"` in v1). Within API 1.x, `@nooklet/plugin-api` changes
   are additive-only: new optional fields, new `register*` methods, new event names. Nothing that
   type-checks against API 1.0 may stop type-checking against a later 1.x.
2. The host checks `manifest.api` before calling `activate()`:

   ```ts
   const SUPPORTED_API_MAJORS = new Set<PluginManifest["api"]>(["1"]);

   function assertApiSupported(manifest: PluginManifest): void {
     if (!SUPPORTED_API_MAJORS.has(manifest.api)) {
       throw new PluginLoadError(
         `plugin "${manifest.id}" targets nooklet plugin api "${manifest.api}"; ` +
           `this host supports: ${[...SUPPORTED_API_MAJORS].join(", ")}`,
       );
     }
   }
   ```

   A load failure here marks the plugin `error` in Settings → Plugins (with the message above)
   and MUST NOT stop the server or other plugins from starting (rule 15).
3. `engines.nooklet` (a semver range on the *host* version, e.g. `">=0.4"`) is checked but only
   warns when unmet — unlike `api`, it is advisory, matching Obsidian's `minAppVersion` and VS
   Code's `engines.vscode`.
4. A breaking API change (removing/renaming a field, changing a `register*` signature
   incompatibly, changing default `expose` semantics) ships as `api: "2"`. The host runs **two
   context factories** side by side (`createServerContextV1`/`V2`, `createClientContextV1`/`V2`)
   over the same underlying registries and services, so `"1"` and `"2"` plugins load
   simultaneously. `"1"` support is dropped only after a published deprecation window (at minimum
   one minor host release with both loaders active and a startup warning on every `"1"` plugin
   naming the removal release).
5. Within a major, a deprecated member MUST keep working for at least one minor release and MUST
   log a warning (`ctx.log.warn`, once per plugin per process) when used.
6. Anything under `ctx.experimental.*` may change or disappear in any release; using it requires
   `experimental: true` in the manifest, which the plugin list UI shows with a warning badge.

## Test cases

1. **Op name validation.** `defineOp({ name: "PageRead", ... })` registered via
   `registry.register` → throws `op name "PageRead" must be dotted lower-case segments...`.
   `registry.register(defineOp({ name: "page.read", ... }))` → succeeds.
2. **Duplicate registration.** Registering two ops named `page.wordcount` (once as `"core"`, once
   as a plugin owner) → the second `register()` call throws
   `op "page.wordcount" is already registered (by "core")`.
3. **MCP name derivation.** `op.name = "changes.since"` → MCP tool name `changes_since`;
   `op.name = "graph.overview"` → `graph_overview`.
4. **Default exposure.** A core op with `expose` omitted → mounted at
   `POST /api/v1/<name>` and listed in `tools/list` (subject to scope). A plugin op with `expose`
   omitted → mounted over HTTP only; absent from `tools/list` until it sets `expose.mcp: true`.
5. **HTTP validation error.** `POST /api/v1/page.wordcount` with body `{}` (missing required
   `page`) → `400` with
   `{ "error": { "code": "invalid", "message": "...", "hint": "fix the listed fields and retry" } }`.
6. **Scope enforcement.** A `read`-scope token calling a `scopes: ["write"]` op over HTTP → `403`
   `{ "error": { "code": "forbidden", "message": "requires scope(s): write" } }`. The same token's
   MCP `tools/list` never contains that tool's name at all.
7. **GET alias for read-only ops.** `page.list` (`readOnlyHint: true`) → both
   `POST /api/v1/page.list` and `GET /api/v1/page.list?input=%7B%7D` work and return identical
   bodies for identical logical input.
8. **REST alias is additive.** An op with `expose: { http: { method: "GET", path: "/pages/{page}" } }`
   → `GET /api/v1/pages/today` AND `POST /api/v1/page.read` both work (rule 9).
9. **Manifest validation.** A `package.json#nooklet` with neither `server` nor `client` → loader
   rejects at discovery time (rule 14), before any `import()`.
10. **Unsupported API major.** A manifest with `"api": "2"` on a host that only supports `["1"]`
    → plugin marked `error`; server startup and all other plugins proceed unaffected (rule 15,
    Versioning §2).
11. **Disposable auto-cleanup.** A plugin's `activate()` calls `registerCommand` three times and
    `beforeWrite` once with no explicit `deactivate()`. Deactivating the plugin (or a hot reload)
    disposes all four registrations in reverse order; the command palette no longer shows the
    plugin's commands and `beforeWrite` is no longer invoked for subsequent writes.
12. **`beforeWrite` skipped for sync.** A `beforeWrite` handler that throws unconditionally is
    registered. A local `page.append` call from `origin.kind: "user"` → rejected (the throw
    propagates). The same content arriving via `origin.kind: "sync"` from another device →
    applied normally, handler not invoked (rule 13).
13. **Worked example op.** Given a page `"today"` with two top-level blocks
    `"Buy milk"` (2 words) and `"Call Anna about the API"` (5 words, one child block `"decided:
    RPC over HTTP"` = 3 words): `page.wordcount { "page": "today" }` →
    `{ "page": "2026-09-10", "blockCount": 3, "wordCount": 10 }`.

## Open issues

1. **`expose` shape is a deliberate merge, not a copy of the research sketch.** This spec
   consolidates `research/07-api-mcp.md`'s separate `http`/`mcp` config objects into one
   `expose: { http, mcp }` field, per direct instruction. `mcp-tools.md` MUST target
   `expose.http`/`expose.mcp` (e.g. `expose.mcp.alwaysLoad`), not the research doc's top-level
   `http.alias`/`mcp.alwaysLoad`.
2. **`render(output)` is single-argument.** Fixed as `(output) => string`, dropping the second
   `input` parameter `research/07-api-mcp.md`'s sketch had. If a future op's text rendering
   genuinely needs the input (e.g. to echo back a search query), the handler should fold that
   value into `output` rather than widening `render`'s signature.
3. **Ids are 14 characters, not 12.** ADR 004 (revised 2026-09-10, same day as the API/MCP
   research) fixed block/page ids at 14-char Crockford base32 (`packages/core/src/ids.ts`); the
   12-char figure in `research/07-api-mcp.md` predates that revision. Any `BlockId`/`PageId`
   regex or token-cost estimate in `mcp-tools.md` MUST use 14, matching `ids.ts`'s
   `^[0-9a-hjkmnp-tv-z]{14}$`.
4. **Error codes are the eight lowercase codes in `00-conventions.md`.** Not the uppercase,
   larger set (`NOT_FOUND`, `AMBIGUOUS`, ...) sketched in `research/07-api-mcp.md`. `mcp-tools.md`
   MUST use `not_found | invalid | conflict | forbidden | unauthorized | rate_limited |
   too_large | internal` only.
5. **RESOLVED 2026-09-10: wire JSON is `snake_case`, not camelCase.** This issue originally
   claimed all API JSON fields should be camelCase, following a loose passing mention in
   `00-conventions.md`. `docs/spec/mcp-tools.md` was written concurrently and independently chose
   `snake_case` instead, matching PLAN.md §11's own literal field names (`old_str`, `if_version`,
   `dry_run`) and the wider MCP/LLM tool-calling convention. `00-conventions.md` §API conventions
   now states the rule explicitly: wire JSON (HTTP bodies, MCP tool schemas) is `snake_case`;
   `OpContext`/`DataApi`/`PluginContext` and other TypeScript-only interfaces stay `camelCase`
   since they are never serialized. Rule 19 above and the worked example in §5 were updated to
   match; no further reconciliation needed.
6. **Flat `register*` naming on `PluginContext`**, per direct instruction, rather than
   `research/05-plugins.md`'s nested groups (`ctx.commands.register`, `ctx.http.route`,
   `ctx.mcp.registerTool`, `ctx.jobs.schedule`, `ctx.importers.register`, ...). Only genuinely
   noun-shaped members stay grouped: `rpc` (`expose`/`call`), `settings`, `kv`, `data`, `ops`,
   `theme`.
7. **`OpContext.data: DataApi` was added** beyond the five things the brief named (db, actor/
   origin, applyOps, config, logger), so op handlers have a usable read/write facade instead of
   hand-written SQL for the common case; `db` remains for the few ops (search, backlinks) that
   need cross-table SQL `DataApi` doesn't expose. Flag for the implementer of
   `packages/server/src/ops`: decide whether *core* op handlers should also route through
   `ctx.data` or call internal services directly for performance — this spec permits either.
8. **`Properties`/`PropValue` follow `packages/core/src/model.ts` exactly** (`Record<string,
   string>`, values plus `null` to unset), not `research/05-plugins.md`'s richer union
   (numbers/booleans/arrays/page-refs). Typed properties are a presentation-layer concern per
   PLAN §8, out of scope for this wire-level spec.
9. **Plugin ops share the core op namespace with no automatic prefix.** The worked example's
   `page.wordcount` shows this deliberately: a plugin can extend an existing core noun. This is a
   real collision risk once more than a couple of plugins are installed (two plugins both wanting
   `page.wordcount` collide, and the second fails to load per rule 2). Acceptable for v1's
   trusted, hand-picked plugin set; revisit (e.g. require a `<pluginId>.` prefix, or namespace by
   owner internally while keeping the display name) before any plugin marketplace ships.
10. **`applyOps`'s real signature belongs to ADR 003 / the sync spec.** `OpContext.applyOps` here
    is declared at the shape op handlers need (`ops`, optional `batchId`, returns `seq` +
    applied/rejected); it MUST be reconciled with whatever the sync spec's actual `applyOps`
    implementation returns when that spec is written.
11. **`CommandKeys`/`when` are typed but not exhaustively specified.** This spec fixes `Command`,
    `CommandKeys` (`default`/`mac`/`win`/`linux`, `"Mod+"`-prefixed cross-platform keys), and
    `when: string`. The `when`-clause grammar (available context keys, operators, chord support)
    and the exhaustive default keymap table are `commands-and-keymap.md`'s to write, reusing
    these three types verbatim.
12. **RESOLVED 2026-09-10:** `Disposable`, `OpContext`, and `DataApi` are now defined in
    `00-conventions.md`'s glossary.
