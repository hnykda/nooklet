/**
 * `@vrite/server` package entry: the pieces a CLI, another package, or a test needs to stand up a
 * full server (DB, write path, op registry, HTTP+MCP app) without reaching into internal files.
 */

export { createServerContext, type ServerContext, serverApplyOps, SERVER_DEVICE_ID } from "./apply-ops.js";
export { openDb, type OpenDbOptions } from "./db.js";
export { initFullSchema, SCHEMA_VERSION } from "./schema.js";
export { createDataApi, type DataApi } from "./data-api.js";
export { buildRegistry, CORE_OPS } from "./ops/index.js";
export {
  defineOp,
  OpError,
  OpRegistry,
  buildOpContext,
  buildOpenApi,
  mountHttp,
  type OpContext,
  type OpDef,
  type ServerConfig,
  type Scope,
} from "./ops/registry.js";
export { createApp, type CreateAppOptions } from "./http/app.js";
export { createToken, verifyToken, revokeToken, bearerAuth, scopesFor } from "./auth/tokens.js";
export { buildMcp, buildMcpServerInstance, mountMcp, type McpAuth } from "./mcp/server.js";
export { startStdioBridge, type StdioBridgeOptions } from "./mcp/stdio.js";
