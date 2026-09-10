/**
 * `defineOp`/`OpDef`/`OpContext`/`OpError`/`Scope`/`OpAnnotations` (`docs/spec/api-and-plugin-
 * types.md` §1). The spec's own file-layout note says these "live in
 * `packages/server/src/ops/define-op.ts` and are re-exported from `@nooklet/plugin-api` so plugin
 * code never depends on `@nooklet/server`" — but no such file exists: the real implementation
 * (`packages/server/src/ops/registry.ts`) defines an equivalent set inline, with a comment saying
 * to "move them out once [`@nooklet/plugin-api`] exists". That file is off-limits to this package
 * (concurrent work owns `packages/server/src/ops/`), so this module is a from-scratch, structurally
 * matching implementation rather than a literal re-export. Two consequences worth knowing:
 *
 *  1. `OpDef`/`OpContext` here are plain object/interface shapes, so a plugin's `defineOp(...)`
 *     result structurally satisfies whatever `ctx.ops.register()` expects — no divergence there.
 *  2. `OpError` is a *class*. This package's `OpError` and the server's own internal `OpError`
 *     (`registry.ts`) are two distinct class references, so `e instanceof OpError` would NOT
 *     recognize an error thrown with this package's class inside code that checks against the
 *     server's own class (its `toErrorBody`). The host's `ctx.ops.register()` wrapper (not yet
 *     built) MUST bridge this — e.g. by importing `OpError`/`toErrorBody` from THIS package once
 *     it exists, or by having the wrapper duck-type on `{ code, message, hint, details }` instead
 *     of `instanceof` — so a plugin op that throws `@nooklet/plugin-api`'s `OpError` still renders
 *     the right HTTP status/MCP error shape. Flagged for whoever wires `ctx.ops.register`.
 *
 * `OpContext` below matches `packages/server/src/ops/registry.ts`'s REAL exported `OpContext`
 * (verified against that file), not the spec's original sketch — see the two divergences called
 * out on `ApplyOpsResult` and `OpContext.db`/`mintOp` below.
 */
import type { AppliedOpResult, Op, OpPayload, SqlDriver } from "@nooklet/core";
import type { z } from "zod";
import type { DataApi } from "./data.js";
import type { Json } from "./json.js";

// -------------------------------------------------------------------------------------------
// Shared primitives (spec §1.1)
// -------------------------------------------------------------------------------------------

export type Scope = "read" | "write" | "admin";

export interface OpAnnotations {
  /** No side effects at all. */
  readOnlyHint: boolean;
  /** May destroy or overwrite data (meaningful only when readOnlyHint is false). */
  destructiveHint: boolean;
  /** Calling twice with the same input has no further effect. */
  idempotentHint: boolean;
  /** Reaches outside the graph (web, other services). MUST be false for every core op; a plugin
   * op wrapping an external API (e.g. web search) MAY set it true. */
  openWorldHint: boolean;
}

// -------------------------------------------------------------------------------------------
// OpDef and defineOp (spec §1.2)
// -------------------------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** true = mount only the canonical `POST /api/v1/<name>`; an object also mounts a REST alias
 * (OpenAPI-style `{param}` path segments). */
export type HttpExpose = boolean | { method: HttpMethod; path: string };

/** true = expose with no extra hints; an object turns exposure on and sets MCP-specific hints. */
export type McpExpose =
  | boolean
  | {
      /** Never deferred behind Claude Code's tool search; keep to a handful across the whole server. */
      alwaysLoad?: boolean;
      /** Client must prompt the user before every call, even under auto-approval settings. */
      requiresUserInteraction?: boolean;
      /** Caps the size of the returned text/structured content the client will inline. */
      maxResultSizeChars?: number;
    };

export interface OpExpose {
  http: HttpExpose;
  mcp: McpExpose;
}

export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** "noun.verb", dotted, lowercase segments, e.g. "page.read". Globally unique across core +
   * plugins — the registry is one flat namespace with no reserved-prefix rule in v1. */
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
  /** Defaults: `http` true always; `mcp` true for core ops, false for plugin ops — a plugin op
   * must opt in explicitly to appear as an MCP tool. */
  expose?: Partial<OpExpose>;
  /** Text for MCP `content[0].text`. Required iff `expose.mcp !== false`; takes only the op's
   * `output`, never the input. Defaults to `JSON.stringify(output)` when omitted and allowed. */
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

/** Shared error-envelope shape (see the `instanceof` caveat in this file's header comment). */
export function toErrorBody(e: unknown): {
  error: { code: OpErrorCode; message: string; hint?: string; details?: Json };
} {
  if (e instanceof OpError) {
    return { error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  }
  return {
    error: { code: "internal", message: e instanceof Error ? e.message : "internal error" },
  };
}

// -------------------------------------------------------------------------------------------
// OpContext (spec §1.3, reconciled against the real packages/server/src/ops/registry.ts)
// -------------------------------------------------------------------------------------------

/** Origin kinds, verbatim from `00-conventions.md` §Vocabulary. */
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

/** Human-readable attribution for the audit log (token label, device name, plugin id). */
export interface Actor {
  label: string;
  tokenId?: string;
}

/**
 * DIVERGENCE from the spec's original sketch (`{ seq, applied: Op[], rejected: Array<{op,
 * reason}> }`, flagged there as Open issue #10, "needs reconciliation once a real `applyOps`
 * exists"). The real `OpContext.applyOps` (`packages/server/src/ops/registry.ts`) returns this
 * shape instead — `results` carries each op's own `status`/`reason` (from
 * `@nooklet/core`'s `AppliedOpResult`) rather than splitting into full-`Op` `applied`/`rejected`
 * arrays. Followed here because op handlers (including plugin ops) receive the real thing.
 */
export interface ApplyOpsResult {
  /** Highest `changes.seq` written by this call (or the current head seq if nothing changed). */
  seq: number;
  results: AppliedOpResult[];
  batchId: string;
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
  /**
   * DIVERGENCE from the spec's sketch (`{ write: DatabaseSync; read: DatabaseSync }`): the real
   * `OpContext.db` is the storage-agnostic `SqlDriver` (`@nooklet/core`'s `ServerContext["driver"]`),
   * a single connection, not a split read/write `node:sqlite` pair. Followed here so plugin op
   * authors' `ctx.db` calls type-check against what they actually receive. Escape hatch for the
   * few cross-table queries `data` does not expose (search, backlinks); prefer `data` otherwise.
   */
  db: SqlDriver;
  /** The isomorphic read/write facade (`./data.js`). The common path for handlers. */
  data: DataApi;
  /** The single write path. Ops must already carry `id`/`hlc`/`device` — build them with `mintOp`. */
  applyOps(ops: Op[], meta?: { batchId?: string }): Promise<ApplyOpsResult>;
  /**
   * DIVERGENCE (addition): not in the spec's original `OpContext` sketch. A handler that builds
   * more than one flat block (markdown -> block tree, a `batch` op sequence) must construct
   * fully-formed `Op` objects before calling `applyOps`; nothing else on `OpContext` exposes a
   * clock. Mints an op stamped with the server's own HLC and device id — the same authorship
   * every `ctx.data` write already uses under the hood.
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
