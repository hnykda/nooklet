/**
 * `defineOp`, `OpDef`/`OpContext`/`OpRegistry`, and the HTTP + OpenAPI mount functions
 * (`docs/spec/api-and-plugin-types.md` §1). This is the reference-implementation sketch from that
 * spec adapted to the *installed* `hono@4.13.7`/`zod@4.6.1` APIs (verified against their `.d.ts`
 * files under `node_modules/.pnpm`) — see the summary of deviations at the bottom of this file's
 * header comment block in the task write-up.
 *
 * `packages/plugin-api` does not exist yet in this repo, so — same accommodation as
 * `data-api.ts` — `OpDef`/`OpContext`/`OpError`/`Scope`/`OpAnnotations` live here (server-internal)
 * instead of being re-exported from a plugin-api package; move them out once that package exists.
 *
 * The MCP mount (§1.7 of the spec) lives in `../mcp/server.ts` instead of this file: it needs
 * vrite-specific wiring (server instructions text, bearer-auth-to-OpContext bridging via
 * `../auth/tokens.ts`) that would otherwise make this module depend on the auth layer. It still
 * builds on the exact same `OpRegistry`/`OpDef` this file defines, so op authors never see the
 * difference — `mcp/server.ts`'s `buildMcp` is the "mount 3 of 3" the spec describes, just kept in
 * its own file for that reason.
 */

import type { Context, Hono } from "hono";
import type { Op, OpPayload } from "@vrite/core";
import { makeOp } from "@vrite/core";
import { z } from "zod";
import type { AppliedOpResult } from "@vrite/core";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "../apply-ops.js";
import type { DataApi } from "../data-api.js";
import { createDataApi } from "../data-api.js";

// -------------------------------------------------------------------------------------------
// 1.1 Shared primitives
// -------------------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

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

// -------------------------------------------------------------------------------------------
// 1.2 OpDef and defineOp
// -------------------------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** true = mount only the canonical POST /api/v1/<name>; an object also mounts a REST alias. */
export type HttpExpose = boolean | { method: HttpMethod; path: string };

/** true = expose with no extra hints; an object turns exposure on and sets MCP-specific hints. */
export type McpExpose =
  | boolean
  | {
      alwaysLoad?: boolean;
      requiresUserInteraction?: boolean;
      maxResultSizeChars?: number;
    };

export interface OpExpose {
  http: HttpExpose;
  mcp: McpExpose;
}

export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** "noun.verb", dotted, e.g. "page.read". Globally unique across core + plugins. */
  name: string;
  /** <= 60 chars. Becomes the MCP tool `title` and the OpenAPI `summary`. */
  summary: string;
  /** LLM-facing: what it does, when to use it, when NOT to, what it returns. <= 1500 chars. */
  description: string;
  input: I;
  output: O;
  annotations: OpAnnotations;
  /** Minimum token scopes required to call this op. */
  scopes: Scope[];
  /** Defaults: http true always; mcp true for core ops, false for plugin ops. */
  expose?: Partial<OpExpose>;
  /** Text for MCP `content[0].text`. Required iff expose.mcp !== false. */
  render?: (output: z.output<O>) => string;
  handler: (input: z.output<I>, ctx: OpContext) => Promise<z.output<O>> | z.output<O>;
}

export function defineOp<I extends z.ZodType, O extends z.ZodType>(def: OpDef<I, O>): OpDef<I, O> {
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

export function toErrorBody(e: unknown): {
  error: { code: OpErrorCode; message: string; hint?: string; details?: Json };
} {
  if (e instanceof OpError) return { error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  return { error: { code: "internal", message: e instanceof Error ? e.message : "internal error" } };
}

// -------------------------------------------------------------------------------------------
// 1.3 OpContext
// -------------------------------------------------------------------------------------------

export type OriginKind = "user" | "api" | "mcp" | "sync" | "plugin" | "import" | "mirror" | "system";

export interface Origin {
  kind: OriginKind;
  deviceId?: string;
  pluginId?: string;
  tokenId?: string;
}

export interface Actor {
  label: string;
  tokenId?: string;
}

/**
 * Deviation from the spec's `ApplyOpsResult` sketch (`{ seq, applied: Op[], rejected: Array<{op,
 * reason}> }`, Open issue #10 in api-and-plugin-types.md, explicitly flagged there as needing
 * reconciliation once a real `applyOps` exists): `serverApplyOps` (`../apply-ops.ts`) already
 * returns a richer, real result (`results: AppliedOpResult[]` with per-op `status`/`reason`, plus
 * `batchId`). Reshaping that into the spec's exact `applied`/`rejected` arrays of full `Op` objects
 * would require carrying every input op alongside its result just to satisfy the sketch; op
 * handlers only ever need the per-op status/reason and the resulting `changes.seq` (for
 * `WriteResult.seq`/`changes_since`'s cursor space) and `batchId` (for `$n` chaining and audit
 * grouping), so this is what `OpContext.applyOps` actually returns.
 */
export interface ApplyOpsResult {
  /** Highest `changes.seq` written by this call (or the current head seq if nothing changed). */
  seq: number;
  results: AppliedOpResult[];
  batchId: string;
}

export interface ServerConfig {
  dataDir: string;
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

export const consoleLogger: Logger = {
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

export interface OpContext {
  /** Raw driver access for the rare cross-table query `DataApi` does not expose (search, backlinks). */
  db: ServerContext["driver"];
  /** The isomorphic read/write facade (`../data-api.ts`); the common path for handlers. */
  data: DataApi;
  /** The single write path. Ops must already carry `id`/`hlc`/`device` — build them with `mintOp`. */
  applyOps(ops: Op[], meta?: { batchId?: string }): Promise<ApplyOpsResult>;
  /**
   * NOT one of the spec's five/six named fields — added because a handler building more than a
   * single flat block (page.append's/block.insert's markdown -> block tree, batch's op sequence)
   * must construct fully-formed `Op` objects (id+hlc+device) before calling `applyOps(ops: Op[])`,
   * and nothing else in `OpContext` exposes a clock. Mints one op stamped with the server's own
   * HLC and `SERVER_DEVICE_ID` (../apply-ops.ts) — the same authorship every `ctx.data` write uses.
   */
  mintOp(entity: string, payload: OpPayload): Op;
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

/** Build the per-request `OpContext` shared by the HTTP and MCP mounts. */
export function buildOpContext(
  serverCtx: ServerContext,
  config: ServerConfig,
  auth: { scopes: Scope[]; actor: Actor; origin: Origin },
  transportMeta: { transport: OpContext["transport"]; requestId: string; idempotencyKey?: string; signal?: AbortSignal },
): OpContext {
  const data = createDataApi(serverCtx, { origin: auth.origin.kind, actor: auth.actor.label });
  return {
    db: serverCtx.driver,
    data,
    async applyOps(ops, meta) {
      const result = serverApplyOps(serverCtx, ops, {
        origin: auth.origin.kind,
        actor: auth.actor.label,
        batchId: meta?.batchId,
      });
      const seqRow = serverCtx.driver.get<{ n: number }>(
        "SELECT COALESCE(MAX(seq), 0) AS n FROM changes WHERE batch_id = ?",
        [result.batchId],
      );
      const seq =
        seqRow && seqRow.n > 0
          ? seqRow.n
          : (serverCtx.driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0);
      return { seq, results: result.results, batchId: result.batchId };
    },
    mintOp(entity, payload) {
      return makeOp(serverCtx.hlc.next(), SERVER_DEVICE_ID, entity, payload);
    },
    origin: auth.origin,
    actor: auth.actor,
    scopes: auth.scopes,
    config,
    log: consoleLogger,
    ...transportMeta,
  };
}

// -------------------------------------------------------------------------------------------
// 1.4 The registry
// -------------------------------------------------------------------------------------------

const OP_NAME_RE = /^([a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+|search|batch)$/;

export class OpRegistry {
  private ops = new Map<string, OpDef & { owner: string }>();

  register(op: OpDef, owner: "core" | string = "core"): void {
    if (!OP_NAME_RE.test(op.name)) {
      throw new Error(`op name "${op.name}" must be dotted lower-case segments, e.g. "page.read"`);
    }
    if (this.ops.has(op.name)) {
      // biome-ignore lint/style/noNonNullAssertion: `has` just confirmed presence
      throw new Error(`op "${op.name}" is already registered (by "${this.ops.get(op.name)!.owner}")`);
    }
    if ((op.expose?.mcp ?? owner === "core") !== false && !op.render) {
      throw new Error(`op "${op.name}" is exposed to MCP but has no render()`);
    }
    this.ops.set(op.name, { ...op, owner });
  }

  /** Used by a plugin's Disposable to remove its own op on deactivate/reload. */
  unregister(name: string): void {
    this.ops.delete(name);
  }

  list(): Array<OpDef & { owner: string }> {
    return [...this.ops.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): (OpDef & { owner: string }) | undefined {
    return this.ops.get(name);
  }
}

export function httpExpose(op: OpDef): Required<OpExpose>["http"] {
  return op.expose?.http ?? true;
}
export function mcpExpose(op: OpDef, owner: string): Required<OpExpose>["mcp"] {
  return op.expose?.mcp ?? owner === "core";
}

function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ":$1");
}

// -------------------------------------------------------------------------------------------
// 1.5 Mount 1 of 3 — HTTP router
// -------------------------------------------------------------------------------------------

/** Deviation from the spec's `(c: Context, op: OpDef) => Promise<OpContext | null>` sketch: our
 * `buildOpCtx` also needs the resolved raw input body for GET/REST-alias routes (already handled
 * inline below), so the signature is unchanged but documented here for clarity. */
export type BuildOpCtx = (c: Context, op: OpDef & { owner: string }) => Promise<OpContext | null>;

export function mountHttp(app: Hono, reg: OpRegistry, buildOpCtx: BuildOpCtx): void {
  for (const op of reg.list()) {
    const http = httpExpose(op);
    if (http === false) continue;

    const run = async (c: Context, raw: unknown) => {
      const parsed = op.input.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: { code: "invalid", message: z.prettifyError(parsed.error), hint: "fix the listed fields and retry" } },
          400,
        );
      }
      const ctx = await buildOpCtx(c, op);
      if (!ctx) {
        return c.json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);
      }
      if (!op.scopes.every((s) => ctx.scopes.includes(s))) {
        return c.json({ error: { code: "forbidden", message: `requires scope(s): ${op.scopes.join(", ")}` } }, 403);
      }
      try {
        const out = await op.handler(parsed.data, ctx);
        return c.json(out as Record<string, unknown>);
      } catch (e) {
        const body = toErrorBody(e);
        return c.json(body, (HTTP_STATUS[body.error.code] ?? 500) as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500);
      }
    };

    app.post(`/api/v1/${op.name}`, async (c) => {
      const bodyText = await c.req.text();
      const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      return run(c, body);
    });
    if (op.annotations.readOnlyHint) {
      app.get(`/api/v1/${op.name}`, (c) => run(c, JSON.parse(c.req.query("input") ?? "{}")));
    }
    if (typeof http === "object") {
      const alias = http;
      app.on(alias.method, `/api/v1${toHonoPath(alias.path)}`, (c) => run(c, { ...c.req.param(), ...c.req.query() }));
    }
  }
}

// -------------------------------------------------------------------------------------------
// 1.6 Mount 2 of 3 — OpenAPI via z.toJSONSchema
// -------------------------------------------------------------------------------------------

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

export function buildOpenApi(reg: OpRegistry): Record<string, unknown> {
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
    info: { title: "vrite API", version: "1" },
    paths,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  };
}
