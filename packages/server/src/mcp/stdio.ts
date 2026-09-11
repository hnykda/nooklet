/**
 * `nooklet mcp --stdio`: the stdio bridge for hosts that cannot reach `localhost` (Claude Desktop's
 * custom connectors run from Anthropic's cloud, mcp-tools.md §3.9).
 *
 * DESIGN DECISION (task explicitly allows either shape — this is the one picked, and why): rather
 * than spawning a process that itself makes authenticated HTTP calls into a separately-running
 * `nooklet serve`, this bridge hosts the MCP server DIRECTLY in-process, against the SAME
 * `OpRegistry`/`ServerContext` a caller already has open — no HTTP hop, no second process to keep
 * alive, no localhost port to coordinate. Stdio is inherently single-client and process-scoped (one
 * `claude_desktop_config.json` entry spawns one subprocess per Claude Desktop session), so the
 * multi-client concurrency `/mcp`'s stateless-per-request HTTP design exists for is not needed
 * here; going in-process is strictly simpler and removes an entire failure mode (the bridge losing
 * its connection to the "real" server). The tradeoff: a stdio bridge and the HTTP server are two
 * separate OS processes if both are run (each opens its own `SqlDriver` connection to the same
 * `graph.sqlite` file — safe under WAL, per 00-conventions.md's storage conventions), so a stdio
 * session started while `nooklet serve` is also running will read/write the same on-disk database,
 * just not share the same in-memory `Hlc`/registry instance. Fine for v1's single-user desktop use.
 *
 * Auth: stdio carries no per-request Authorization header at all, so — unlike the HTTP/MCP mount,
 * which re-resolves scopes from `authInfo` on every call — this bridge resolves ONE fixed local
 * token ONCE at process start (`--token` CLI flag, else the `NOOKLET_TOKEN` env var, matching the
 * `claude_desktop_config.json` example in mcp-tools.md §3.9) and reuses that identity for every
 * tool call for the lifetime of the stdio connection.
 */

import { fileURLToPath } from "node:url";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ServerContext } from "../apply-ops.js";
import { createServerContext } from "../apply-ops.js";
import { scopesFor, verifyToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { buildRegistry } from "../ops/index.js";
import type { OpRegistry, ServerConfig } from "../ops/registry.js";
import { buildMcpServerInstance, type McpAuth } from "./server.js";

export interface StdioBridgeOptions {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  /** Falls back to the `NOOKLET_TOKEN` env var when omitted (the `nooklet mcp --stdio --token …` CLI flag). */
  token?: string;
  version?: string;
}

/** Verifies the fixed local token once, then serves stdio for as long as the process lives. */
export function startStdioBridge(opts: StdioBridgeOptions): StdioServerHandle {
  const rawToken = opts.token ?? process.env.NOOKLET_TOKEN;
  if (!rawToken) {
    throw new Error(
      "nooklet mcp --stdio requires a token: pass --token <token> or set NOOKLET_TOKEN",
    );
  }
  const verified = verifyToken(opts.serverCtx.driver, rawToken);
  if (!verified) {
    throw new Error("nooklet mcp --stdio: token is invalid or revoked");
  }
  const auth: McpAuth = {
    scopes: scopesFor(verified.scope),
    actor: { label: verified.label, tokenId: verified.id },
  };
  return serveStdio(
    () => buildMcpServerInstance(opts.registry, opts.serverCtx, opts.config, auth, opts.version),
    {
      onerror: (e) => console.error("[nooklet mcp --stdio]", e), // stdout is the protocol channel; logs go to stderr only
    },
  );
}

function parseArgs(argv: string[]): { token?: string; dataPath?: string } {
  const out: { token?: string; dataPath?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token") out.token = argv[++i];
    else if (argv[i] === "--data") out.dataPath = argv[++i];
  }
  return out;
}

/** Entry point for `nooklet mcp --stdio` once a CLI dispatcher exists; also runnable directly
 * (`node dist/mcp/stdio.js --token nk_… [--data /path/to/graph.sqlite]`). */
export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const dataPath =
    args.dataPath ??
    process.env.NOOKLET_DATA_FILE ??
    `${process.env.HOME ?? "."}/.nooklet/default/graph.sqlite`;
  const serverCtx = createServerContext(openDb({ path: dataPath }));
  const registry = buildRegistry();
  const config: ServerConfig = {
    dataDir: dataPath,
    graphId: "default",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    port: 0,
    mirror: { enabled: false },
  };
  startStdioBridge({ serverCtx, registry, config, token: args.token });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
