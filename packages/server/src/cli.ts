#!/usr/bin/env node
/**
 * `nooklet` CLI: the one entry point that wires the pieces of this package together.
 *
 *   nooklet serve   [--data <dir>] [--port <n>]     run the HTTP API + MCP endpoint
 *   nooklet import  <logseq-graph-dir> [--data <dir>]  one-shot Logseq file-graph import (ADR 012)
 *   nooklet export  [--data <dir>]                  write the markdown mirror (ADR 002)
 *   nooklet mcp --stdio [--token <t>] [--data <dir>] MCP over stdio, for Claude Desktop (ADR 008)
 *   nooklet token   create --label <l> [--scope read|write|admin] [--sync] | list | revoke <id>
 *
 * `--data` defaults to $NOOKLET_DATA, then ~/.nooklet/default. The database lives at
 * <data>/graph.sqlite and the mirror at <data>/{pages,journals}/ (00-conventions.md, Storage).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createToken, revokeToken } from "./auth/tokens.js";
import { openDb } from "./db.js";
import { createApp } from "./http/app.js";
import { importLogseqGraph } from "./importer/logseq.js";
import { startStdioBridge } from "./mcp/stdio.js";
import { exportAll } from "./mirror/export.js";
import { buildRegistry } from "./ops/index.js";
import type { ServerConfig } from "./ops/registry.js";

interface Args {
  _: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      _.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { _, flags };
}

function dataDir(args: Args): string {
  const flag = args.flags.get("data");
  if (typeof flag === "string") return resolve(flag);
  if (process.env.NOOKLET_DATA) return resolve(process.env.NOOKLET_DATA);
  return join(homedir(), ".nooklet", "default");
}

function open(args: Args): { ctx: ServerContext; config: ServerConfig } {
  const dir = dataDir(args);
  const ctx = createServerContext(openDb({ path: join(dir, "graph.sqlite") }));
  const portFlag = args.flags.get("port");
  return {
    ctx,
    config: {
      dataDir: dir,
      graphId: "default",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      port: typeof portFlag === "string" ? Number(portFlag) : 6100,
      mirror: { enabled: args.flags.get("mirror") !== false },
    },
  };
}

function die(message: string): never {
  process.stderr.write(`nooklet: ${message}\n`);
  process.exit(1);
}

const USAGE = `nooklet — a local-first outliner server

  nooklet serve  [--data <dir>] [--port <n>]
  nooklet import <logseq-graph-dir> [--data <dir>]
  nooklet export [--data <dir>]
  nooklet mcp --stdio [--token <token>] [--data <dir>]
  nooklet token create --label <label> [--scope read|write|admin] [--sync]
  nooklet token list
  nooklet token revoke <token-id>
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  switch (cmd) {
    case "serve": {
      const { ctx, config } = open(args);
      const app = createApp({ serverCtx: ctx, registry: buildRegistry(), config });
      serve({ fetch: app.fetch, port: config.port }, (info) => {
        process.stdout.write(
          `nooklet serving ${config.dataDir}\n` +
            `  http  http://127.0.0.1:${info.port}/api/v1\n` +
            `  mcp   http://127.0.0.1:${info.port}/mcp\n` +
            `  spec  http://127.0.0.1:${info.port}/openapi.json\n`,
        );
      });
      return;
    }

    case "import": {
      const graphDir = args._[1];
      if (!graphDir) die("import needs a Logseq graph directory");
      const { ctx } = open(args);
      const stats = await importLogseqGraph(ctx, resolve(graphDir));
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return;
    }

    case "export": {
      const { ctx, config } = open(args);
      const result = exportAll(ctx.driver, config.dataDir);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    case "mcp": {
      if (!args.flags.get("stdio")) die("only --stdio is supported: nooklet mcp --stdio");
      const { ctx, config } = open(args);
      const token = args.flags.get("token");
      startStdioBridge({
        serverCtx: ctx,
        registry: buildRegistry(),
        config,
        ...(typeof token === "string" ? { token } : {}),
      });
      return;
    }

    case "token": {
      const sub = args._[1];
      const { ctx } = open(args);
      if (sub === "create") {
        const label = args.flags.get("label");
        if (typeof label !== "string") die("token create needs --label <label>");
        const scopeFlag = args.flags.get("scope");
        const scope = typeof scopeFlag === "string" ? scopeFlag : "read";
        if (scope !== "read" && scope !== "write" && scope !== "admin") {
          die(`unknown scope "${scope}" (expected read, write, or admin)`);
        }
        const created = createToken(ctx.driver, {
          label,
          scope,
          canSync: args.flags.get("sync") === true,
        });
        process.stdout.write(
          `${created.token}\n\nSaved as "${label}" (${scope}). This is the only time it is shown.\n`,
        );
        return;
      }
      if (sub === "list") {
        const rows = ctx.driver.all<{
          id: string;
          label: string;
          scope: string;
          can_sync: number;
          created_at: number;
          last_used_at: number | null;
          revoked_at: number | null;
        }>("SELECT id, label, scope, can_sync, created_at, last_used_at, revoked_at FROM token");
        for (const r of rows) {
          const state = r.revoked_at ? "revoked" : "active";
          const used = r.last_used_at ? new Date(r.last_used_at).toISOString() : "never";
          process.stdout.write(
            `${r.id}  ${r.scope.padEnd(5)}  ${state.padEnd(7)}  last used ${used}  ${r.label}\n`,
          );
        }
        return;
      }
      if (sub === "revoke") {
        const id = args._[2];
        if (!id) die("token revoke needs a token id (see: nooklet token list)");
        revokeToken(ctx.driver, id);
        process.stdout.write(`revoked ${id}\n`);
        return;
      }
      die(`unknown token subcommand "${sub ?? ""}" (expected create, list, or revoke)`);
      return;
    }

    default:
      process.stdout.write(USAGE);
      if (cmd !== undefined && cmd !== "help" && cmd !== "--help") process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`nooklet: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
