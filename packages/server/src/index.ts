/**
 * `@nooklet/server` package entry: the pieces a CLI, another package, or a test needs to stand up a
 * full server (DB, write path, op registry, HTTP+MCP app) without reaching into internal files.
 */

export {
  createServerContext,
  SERVER_DEVICE_ID,
  type ServerContext,
  serverApplyOps,
} from "./apply-ops.js";
export { bearerAuth, createToken, revokeToken, scopesFor, verifyToken } from "./auth/tokens.js";
export {
  type BackupResult,
  createBackup,
  type RestoreResult,
  restoreBackup,
} from "./backup/index.js";
export { createDataApi, type DataApi } from "./data-api.js";
export { type OpenDbOptions, openDb } from "./db.js";
export { computeGcFloor, type GcReport, runGc } from "./gc.js";
export { type CreateAppOptions, createApp } from "./http/app.js";
export { buildMcp, buildMcpServerInstance, type McpAuth, mountMcp } from "./mcp/server.js";
export { type StdioBridgeOptions, startStdioBridge } from "./mcp/stdio.js";
export { buildRegistry, CORE_OPS } from "./ops/index.js";
export {
  buildOpContext,
  buildOpenApi,
  defineOp,
  mountHttp,
  type OpContext,
  type OpDef,
  OpError,
  OpRegistry,
  type Scope,
  type ServerConfig,
} from "./ops/registry.js";
export { initFullSchema, SCHEMA_VERSION } from "./schema.js";
export {
  type CommitEvent,
  type CommitListener,
  mountSync,
  notifyCommit,
  onCommit,
} from "./sync/index.js";
export { formatVerifyReport, type VerifyReport, verifyRebuildParity } from "./verify.js";
