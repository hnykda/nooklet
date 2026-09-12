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
 * nooklet-specific wiring (server instructions text, bearer-auth-to-OpContext bridging via
 * `../auth/tokens.ts`) that would otherwise make this module depend on the auth layer. It still
 * builds on the exact same `OpRegistry`/`OpDef` this file defines, so op authors never see the
 * difference — `mcp/server.ts`'s `buildMcp` is the "mount 3 of 3" the spec describes, just kept in
 * its own file for that reason.
 */

import type { AppliedOpResult, Op, OpPayload } from "@nooklet/core";
import { makeOp } from "@nooklet/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { SERVER_DEVICE_ID, type ServerContext, serverApplyOps } from "../apply-ops.js";
import type { DataApi } from "../data-api.js";
import { createDataApi } from "../data-api.js";
import { withIdempotency } from "./idempotency.js";
import { writeLock } from "./trial-lock.js";

// -------------------------------------------------------------------------------------------
// 1.1 Shared primitives
// -------------------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Scope = "read" | "write" | "admin";

/**
 * `Scope` plus `"ui:control"` (ADR 015 §7): the live-UI-control capability, orthogonal to the
 * read/write/admin tier a token is created with — a broad `write` token for headless data cleanup
 * should not thereby be able to drive someone's screen, and a `read` + `ui:control` token is a
 * coherent "can watch and point at things, cannot edit" grant. Modeled as a fourth `Permission`
 * value rather than a parallel "capabilities" system so every existing scope-enforcement path
 * (`mountHttp`'s per-op check below, the MCP mount's `tools/list` filter and per-call check in
 * `../mcp/server.ts`) covers it for free: `OpDef.scopes`/`OpContext.scopes` are typed `Permission[]`
 * instead of `Scope[]`, `ui.*` ops simply list `"ui:control"` among their `scopes`, and
 * `../auth/tokens.ts#allScopesFor` is the one place that decides whether a verified token's
 * `Permission[]` includes it (from the token's own `ui_control` column, never implied by
 * `read`/`write`/`admin`). The token table's single `scope` column (its read/write/admin *tier*)
 * is untouched — `Scope` keeps meaning exactly that tier everywhere it already appears
 * (`CreateTokenOptions.scope`, `TokenRow.scope`, `scopesFor`).
 */
export type Permission = Scope | "ui:control";

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
  /** Minimum token permissions required to call this op (the read/write/admin scopes, plus the
   * orthogonal `"ui:control"` capability — see `Permission`). */
  scopes: Permission[];
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
  if (e instanceof OpError)
    return { error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  return {
    error: { code: "internal", message: e instanceof Error ? e.message : "internal error" },
  };
}

// -------------------------------------------------------------------------------------------
// 1.3 OpContext
// -------------------------------------------------------------------------------------------

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
  /**
   * Address to bind. Defaults to `127.0.0.1` — a personal journal should not be reachable from the
   * coffee-shop Wi-Fi because you forgot a flag. Set `0.0.0.0` to expose it on a LAN or tailnet,
   * and then `allowedHosts` below is what keeps DNS rebinding from turning a browser on that
   * network into a proxy into this server.
   */
  host?: string;
  /**
   * Hostnames a request's `Host` header may carry, beyond the loopback names that are always
   * allowed. Needed whenever `host` is not loopback: `@modelcontextprotocol/hono`'s guard is
   * installed app-wide, so an un-allowlisted `Host` fails the web client and `/mcp` alike.
   */
  allowedHosts?: string[];
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
  /**
   * Raw driver access for the rare cross-table query `DataApi` does not expose (search,
   * backlinks) — and, since a `SqlDriver` is as stable a per-server identity as `ServerContext`
   * itself, also what `../live/*` (ADR 015) keys its `WeakMap`-based live-window registry by
   * (`../live/registry.ts`), rather than adding a second, server-internal-only field here that
   * `@nooklet/plugin-api`'s public `OpContext` (which never imports anything server-internal)
   * would then also need to declare just to keep `packages/plugin-api/src/assignability.test.ts`
   * passing.
   */
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
  scopes: Permission[];
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
  auth: { scopes: Permission[]; actor: Actor; origin: Origin },
  transportMeta: {
    transport: OpContext["transport"];
    requestId: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  },
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
          : (serverCtx.driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")
              ?.n ?? 0);
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
    const existing = this.ops.get(op.name);
    if (existing) {
      throw new Error(`op "${op.name}" is already registered (by "${existing.owner}")`);
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

/**
 * Runs one op's handler, serializing WRITE ops (readOnlyHint false) behind `writeLock`
 * (`./trial-lock.ts`) so a `dry_run`/`batch` trial's open `Savepoint` — which now spans several
 * `await`s on the shared connection — can never interleave with another write. The lock wraps the
 * handler's ENTIRE execution (acquired once, here, per request) rather than each individual
 * `ctx.applyOps` call, so a handler that calls `applyOps` more than once (or `batch`, which runs
 * every step of a trial) never re-enters the lock it is already holding. Both mounts (HTTP below,
 * MCP in `../mcp/server.ts`) call this instead of `op.handler` directly.
 *
 * Writes also honour `idempotency_key` here (`./idempotency.ts`), inside the lock, so a retry that
 * races its original cannot run twice either.
 */
export async function runOpHandler(
  op: Pick<OpDef, "annotations" | "handler">,
  input: unknown,
  ctx: OpContext,
): Promise<unknown> {
  if (op.annotations.readOnlyHint) return op.handler(input, ctx);
  const fields = (input ?? {}) as { idempotency_key?: unknown; dry_run?: unknown };
  const key =
    typeof fields.idempotency_key === "string" && fields.dry_run !== true
      ? fields.idempotency_key
      : undefined;
  return writeLock.run(() =>
    withIdempotency(ctx.db, { tokenId: ctx.actor.tokenId, key, input }, () =>
      Promise.resolve(op.handler(input, ctx)),
    ),
  );
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

/** Best-effort string -> JSON-value coercion for a REST alias's query params ("2" -> 2, "true" ->
 * true), falling back to the raw string when it is not valid JSON (e.g. "child_first"). */
function coerceQueryValue(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
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
    const opName = op.name;

    const run = async (c: Context, raw: unknown) => {
      // Live lookup by name, NOT the `op` closed over above: a PLUGIN op can be unregistered
      // after this route is mounted (M4 plugins — `ctx.ops.register`'s `Disposable` calls
      // `reg.unregister(name)` on deactivate/reload, `../plugins/ops-bridge.ts`), and that must
      // make every route for it 404 from then on. A no-op extra `Map.get()` for core ops, which
      // never unregister.
      const current = reg.get(opName);
      if (!current) {
        return c.json(
          { error: { code: "not_found", message: `op "${opName}" is no longer registered` } },
          404,
        );
      }
      const parsed = current.input.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "invalid",
              message: z.prettifyError(parsed.error),
              hint: "fix the listed fields and retry",
            },
          },
          400,
        );
      }
      const ctx = await buildOpCtx(c, current);
      if (!ctx) {
        return c.json(
          { error: { code: "unauthorized", message: "missing or invalid bearer token" } },
          401,
        );
      }
      if (!current.scopes.every((s) => ctx.scopes.includes(s))) {
        return c.json(
          {
            error: {
              code: "forbidden",
              message: `requires scope(s): ${current.scopes.join(", ")}`,
            },
          },
          403,
        );
      }
      try {
        const out = await runOpHandler(current, parsed.data, ctx);
        return c.json(out as Record<string, unknown>);
      } catch (e) {
        const body = toErrorBody(e);
        return c.json(
          body,
          (HTTP_STATUS[body.error.code] ?? 500) as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500,
        );
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
      app.on(alias.method, `/api/v1${toHonoPath(alias.path)}`, (c) => {
        // REST-alias query params arrive as strings (e.g. "depth=2"); a schema field typed
        // z.number()/z.boolean() would otherwise fail validation on a value that came in fine
        // over the canonical JSON-body POST route. Path params (ids/names) are left as strings,
        // since every PageRef/BlockId-typed field is itself a string schema.
        const query = Object.fromEntries(
          Object.entries(c.req.query()).map(([k, v]) => [k, coerceQueryValue(v)]),
        );
        return run(c, { ...c.req.param(), ...query });
      });
    }
  }
}

// -------------------------------------------------------------------------------------------
// 1.6 Mount 2 of 3 — OpenAPI via z.toJSONSchema
// -------------------------------------------------------------------------------------------

const ErrorEnvelopeJsonSchema = z.toJSONSchema(
  z.object({
    error: z.object({
      code: z.enum([
        "not_found",
        "invalid",
        "conflict",
        "forbidden",
        "unauthorized",
        "rate_limited",
        "too_large",
        "internal",
      ]),
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
          content: {
            "application/json": { schema: z.toJSONSchema(op.input, { target: "openapi-3.0" }) },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: z.toJSONSchema(op.output, { target: "openapi-3.0" }) },
            },
          },
          default: {
            description: "Error",
            content: { "application/json": { schema: ErrorEnvelopeJsonSchema } },
          },
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
