#!/usr/bin/env node
/**
 * `nooklet` CLI: the one entry point that wires the pieces of this package together.
 *
 *   nooklet serve   [--data <dir>] [--port <n>]     run the HTTP API + MCP endpoint
 *   nooklet import  <logseq-graph-dir> [--data <dir>]  one-shot Logseq file-graph import (ADR 012)
 *   nooklet export  [--data <dir>]                  write the markdown mirror (ADR 002)
 *   nooklet mcp --stdio [--token <t>] [--data <dir>] MCP over stdio, for Claude Desktop (ADR 008)
 *   nooklet token   create --label <l> [--scope read|write|admin] [--sync] [--ui-control] |
 *                   list | revoke <id>  (--ui-control grants ADR 015's live-UI-control capability)
 *   nooklet embed   status | run | model <name> [--provider ollama|openai-compat] [--host <url>]
 *                   M3/ADR 010 embeddings: index status, drain the queue now, or switch models.
 *   nooklet backup  [--out <path>] [--data <dir>]    consistent VACUUM INTO snapshot + assets/,
 *                   as a single .tar.gz archive (M6, docs/OPERATIONS.md)
 *   nooklet restore <archive> [--data <dir>] [--force]  restore a backup (refuses to clobber an
 *                   existing database unless --force; refuses an archive newer than this build)
 *   nooklet gc      [--dry-run] [--no-backup] [--data <dir>]  op-log GC down to
 *                   min(device.acked_seq) across live devices (M6, ./gc.ts)
 *   nooklet verify  [--data <dir>]  rebuild()-vs-live-state parity check (ADR 003, ./verify.ts);
 *                   also runs automatically at "nooklet serve" startup when NODE_ENV != production
 *
 * `--data` defaults to $NOOKLET_DATA, then ~/.nooklet/default. The database lives at
 * <data>/graph.sqlite and the mirror at <data>/{pages,journals}/ (00-conventions.md, Storage).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createToken, revokeToken } from "./auth/tokens.js";
import { createBackup, restoreBackup } from "./backup/index.js";
import { openDb } from "./db.js";
import {
  activateModel,
  buildProviderForModel,
  buildProviderFromSettings,
  EmbeddingIndexer,
  enqueueBackfill,
  getActiveModel,
  getEmbeddingSettings,
  getVecStatus,
  pendingCountForModel,
  registerModel,
  setEmbeddingSettings,
} from "./embeddings/index.js";
import { runGc } from "./gc.js";
import { importLogseqGraph } from "./importer/logseq.js";
import { startStdioBridge } from "./mcp/stdio.js";
import { exportAll } from "./mirror/export.js";
import { buildRegistry } from "./ops/index.js";
import type { ServerConfig } from "./ops/registry.js";
import { createAppWithPlugins } from "./plugins/bootstrap.js";
import { discoverPlugins } from "./plugins/manifest.js";
import { ensurePluginRow, isPluginEnabled, setPluginEnabled } from "./plugins/settings.js";
import { formatVerifyReport, verifyRebuildParity } from "./verify.js";

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

/**
 * Where the built web client lives, or `undefined` to stay API-only.
 *
 * Checked in order: an explicit `--web <dir>`, then `$NOOKLET_WEB_DIR`, then the two layouts that
 * actually occur — a packaged app, where the client sits next to the server bundle, and this
 * monorepo, where it is `apps/web/dist` some number of levels up. Resolution is relative to THIS
 * FILE, never `process.cwd()`: a desktop app is launched from Finder with cwd `/`, and `nooklet
 * serve` is meant to work from any directory.
 */
function resolveWebClientDir(flag: string | boolean | undefined): string | undefined {
  if (typeof flag === "string") return resolve(flag);
  if (flag === false) return undefined;
  if (process.env.NOOKLET_WEB_DIR) return resolve(process.env.NOOKLET_WEB_DIR);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "web"), join(here, "..", "..", "web")];
  for (let dir = here, i = 0; i < 6; i++, dir = dirname(dir)) {
    candidates.push(join(dir, "apps", "web", "dist"));
    if (dirname(dir) === dir) break;
  }
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}

function open(args: Args): { ctx: ServerContext; config: ServerConfig } {
  const dir = dataDir(args);
  const ctx = createServerContext(openDb({ path: join(dir, "graph.sqlite") }));
  const portFlag = args.flags.get("port");
  const hostFlag = args.flags.get("host");
  const allowFlag = args.flags.get("allow-host");
  return {
    ctx,
    config: {
      dataDir: dir,
      graphId: "default",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      port: typeof portFlag === "string" ? Number(portFlag) : 6100,
      mirror: { enabled: args.flags.get("mirror") !== false },
      host: typeof hostFlag === "string" ? hostFlag : "127.0.0.1",
      // Comma-separated rather than repeatable, because `parseArgs` keeps one value per flag.
      allowedHosts:
        typeof allowFlag === "string"
          ? allowFlag
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : undefined,
    },
  };
}

/**
 * Plugin discovery roots, in order: `<dataDir>/plugins` (where a real install's plugins live —
 * created lazily, so it needn't exist yet), then, in dev, the repo root's own `plugins/` (the 3
 * built-ins, M4/PLAN §13). The dev root is found relative to THIS file rather than `cwd()`, so
 * `nooklet serve` works the same from any directory; an installed build simply won't have a
 * `plugins/` three levels above `dist/cli.js`, so `discoverPlugins` (which skips missing
 * directories) silently finds none there.
 */
function pluginDirsFor(config: ServerConfig): string[] {
  const repoRootPlugins = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
  );
  return [join(config.dataDir, "plugins"), repoRootPlugins];
}

function die(message: string): never {
  process.stderr.write(`nooklet: ${message}\n`);
  process.exit(1);
}

const USAGE = `nooklet — a local-first outliner server

  nooklet serve  [--data <dir>] [--port <n>] [--web <dir>]
                 [--host <addr>] [--allow-host <h,h>]   expose on a LAN/tailnet
  nooklet import <logseq-graph-dir> [--data <dir>]
  nooklet export [--data <dir>]
  nooklet mcp --stdio [--token <token>] [--data <dir>]
  nooklet token create --label <label> [--scope read|write|admin] [--sync] [--ui-control]
  nooklet token list
  nooklet token revoke <token-id>
  nooklet embed status
  nooklet embed run
  nooklet embed model <name> [--provider ollama|openai-compat] [--host <url>]
  nooklet plugin list
  nooklet plugin enable <plugin-id>
  nooklet plugin disable <plugin-id>
  nooklet plugin reload <plugin-id>
  nooklet backup [--out <path>] [--data <dir>]
  nooklet restore <archive> [--data <dir>] [--force]
  nooklet gc [--dry-run] [--no-backup] [--data <dir>]
  nooklet verify [--data <dir>]
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  switch (cmd) {
    case "serve": {
      const { ctx, config } = open(args);

      // ADR 003 / sql-schema.md rule 26: "A dev-mode server SHOULD run rebuild() into a scratch
      // database on every start and diff it against the live state tables." Dev-only (the replay
      // + diff cost is fine at hobby-graph scale but not something to pay on every production
      // boot) and never fatal — a divergence is exactly the regression this exists to surface, not
      // a reason to refuse to serve.
      if (process.env.NODE_ENV !== "production") {
        const report = verifyRebuildParity(ctx.driver);
        process.stderr.write(`${formatVerifyReport(report)}\n`);
      }

      const registry = buildRegistry();
      const webClientDir = resolveWebClientDir(args.flags.get("web"));
      const { app } = await createAppWithPlugins({
        serverCtx: ctx,
        registry,
        config,
        pluginDirs: pluginDirsFor(config),
        webClientDir,
      });
      // `/sync/live` (../sync/live.ts) needs a real `ws` WebSocketServer wired into the Node
      // adapter's `serve()` call — `upgradeWebSocket` (used by that route) only handles the Hono
      // side of the handshake; `@hono/node-server` needs a `{ noServer: true }` WebSocketServer
      // to hand upgraded connections to. See `@hono/node-server`'s own WebSocket docs.
      const wss = new WebSocketServer({ noServer: true });
      // M3/ADR 010: drain embed_dirty on an interval, in-process. Network calls (the only slow
      // part) are awaited, so this never blocks the event loop's handling of concurrent requests.
      const indexer = new EmbeddingIndexer({
        driver: ctx.driver,
        providerFor: (model) => buildProviderForModel(ctx.driver, model),
        log: (message) => process.stderr.write(`nooklet: embedding indexer: ${message}\n`),
      });
      indexer.start();
      const shutdown = (): void => {
        indexer.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Loopback by default (see ServerConfig.host): reaching this graph from another machine has
      // to be something you asked for.
      const hostname = config.host ?? "127.0.0.1";
      const exposed = hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
      if (exposed && !config.allowedHosts?.length) {
        process.stderr.write(
          `nooklet: bound to ${hostname} with no --allow-host. Requests arriving with any other\n` +
            `  Host header (a LAN IP, a tailnet name) are refused — pass e.g.\n` +
            `  --allow-host 192.168.1.5,my-machine.local to reach it from another device.\n`,
        );
      }
      serve(
        { fetch: app.fetch, port: config.port, hostname, websocket: { server: wss } },
        (info) => {
          const shown = exposed ? hostname : "127.0.0.1";
          process.stdout.write(
            `nooklet serving ${config.dataDir}\n` +
              `  http  http://${shown}:${info.port}/api/v1\n` +
              `  mcp   http://${shown}:${info.port}/mcp\n` +
              `  spec  http://${shown}:${info.port}/openapi.json\n` +
              `  sync  ws://${shown}:${info.port}/sync/live\n` +
              `  live  ws://${shown}:${info.port}/ui/live\n` +
              (webClientDir
                ? `  app   http://${shown}:${info.port}/  (serving ${webClientDir})\n`
                : `  app   not served — build it (pnpm --filter @nooklet/web build) or pass --web <dir>\n`),
          );
        },
      );
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
        // ADR 015 §7: `--ui-control` grants the orthogonal live-UI-control capability
        // (`../ops/registry.ts`'s `Permission`), independent of --scope/--sync.
        const uiControl = args.flags.get("ui-control") === true;
        const created = createToken(ctx.driver, {
          label,
          scope,
          canSync: args.flags.get("sync") === true,
          uiControl,
        });
        process.stdout.write(
          `${created.token}\n\nSaved as "${label}" (${scope}${uiControl ? ", ui:control" : ""}). This is the only time it is shown.\n`,
        );
        return;
      }
      if (sub === "list") {
        const rows = ctx.driver.all<{
          id: string;
          label: string;
          scope: string;
          can_sync: number;
          ui_control: number;
          created_at: number;
          last_used_at: number | null;
          revoked_at: number | null;
        }>(
          "SELECT id, label, scope, can_sync, ui_control, created_at, last_used_at, revoked_at FROM token",
        );
        for (const r of rows) {
          const state = r.revoked_at ? "revoked" : "active";
          const used = r.last_used_at ? new Date(r.last_used_at).toISOString() : "never";
          const uiControl = r.ui_control ? " +ui:control" : "";
          process.stdout.write(
            `${r.id}  ${r.scope.padEnd(5)}${uiControl}  ${state.padEnd(7)}  last used ${used}  ${r.label}\n`,
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

    // ---------------------------------------------------------------------------------------
    // M3/ADR 010: embeddings — status, drain the queue on demand, switch models (rule 19).
    // ---------------------------------------------------------------------------------------
    case "embed": {
      const sub = args._[1];
      const { ctx } = open(args);
      const driver = ctx.driver;

      if (sub === "status") {
        const vec = getVecStatus(driver);
        const settings = getEmbeddingSettings(driver);
        process.stdout.write(
          vec.loaded
            ? `sqlite-vec: loaded (${vec.version ?? "?"})\n`
            : `sqlite-vec: NOT loaded (${vec.error ?? "unknown reason"}) — search/related degrade to keyword-only\n`,
        );
        process.stdout.write(
          `configured: provider=${settings.provider} model=${settings.model} host=${settings.host}\n`,
        );
        const active = getActiveModel(driver);
        if (active) {
          const pending = pendingCountForModel(driver, active.id);
          const done =
            driver.get<{ n: number }>(
              "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'done'",
              [active.id],
            )?.n ?? 0;
          const errors =
            driver.get<{ n: number }>(
              "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'error'",
              [active.id],
            )?.n ?? 0;
          process.stdout.write(
            `active model: ${active.provider}:${active.model} (id ${active.id}, dims ${active.dims})\n` +
              `indexed: ${done}  pending: ${pending}  errors: ${errors}\n`,
          );
        } else {
          process.stdout.write("active model: none (run: nooklet embed model <name>)\n");
        }
        const dirty = driver.get<{ n: number }>("SELECT count(*) AS n FROM embed_dirty")?.n ?? 0;
        process.stdout.write(`embed_dirty queue: ${dirty}\n`);
        return;
      }

      if (sub === "run") {
        if (!getActiveModel(driver))
          die("no active embedding model; run: nooklet embed model <name>");
        const indexer = new EmbeddingIndexer({
          driver,
          providerFor: (model) => buildProviderForModel(driver, model),
          log: (message) => process.stderr.write(`${message}\n`),
        });
        const total = await indexer.drainUntilEmpty({
          onProgress: (s) => {
            if (s.processedUnits > 0) {
              process.stdout.write(
                `processed ${s.processedUnits}  embedded ${s.embeddedPairs}  deleted ${s.deletedUnits}  errors ${s.errors}\n`,
              );
            }
          },
        });
        process.stdout.write(
          `done. total processed ${total.processedUnits}  embedded ${total.embeddedPairs}  ` +
            `deleted ${total.deletedUnits}  errors ${total.errors}\n`,
        );
        return;
      }

      if (sub === "model") {
        const name = args._[2];
        if (!name) die("embed model needs a model name, e.g. nooklet embed model bge-m3");
        const providerFlag = args.flags.get("provider");
        const hostFlag = args.flags.get("host");
        const current = getEmbeddingSettings(driver);
        const provider = typeof providerFlag === "string" ? providerFlag : current.provider;
        if (provider !== "ollama" && provider !== "openai-compat") {
          die(`unknown provider "${provider}" (expected ollama or openai-compat)`);
        }
        const host = typeof hostFlag === "string" ? hostFlag : current.host;
        setEmbeddingSettings(driver, { provider, model: name, host });

        process.stdout.write(`probing dims for ${provider}:${name} at ${host}...\n`);
        const dims = await buildProviderFromSettings(driver).dims();
        const row = registerModel(driver, { provider, model: name, dims });
        process.stdout.write(
          `registered ${row.provider}:${row.model} (id ${row.id}, dims ${row.dims})\n`,
        );
        const count = enqueueBackfill(driver);
        process.stdout.write(`enqueued ${count} unit(s) for backfill; draining...\n`);

        const indexer = new EmbeddingIndexer({
          driver,
          providerFor: (model) => buildProviderForModel(driver, model),
          log: (message) => process.stderr.write(`${message}\n`),
        });
        await indexer.drainUntilEmpty({
          onProgress: (s) => {
            if (s.processedUnits > 0) {
              process.stdout.write(
                `  processed ${s.processedUnits}  embedded ${s.embeddedPairs}\n`,
              );
            }
          },
        });

        const pending = pendingCountForModel(driver, row.id);
        if (pending > 0) {
          process.stdout.write(
            `warning: ${pending} unit(s) still pending — not activated. Run 'nooklet embed run' again, then retry.\n`,
          );
          return;
        }
        activateModel(driver, row.id);
        process.stdout.write(
          `activated ${row.provider}:${row.model} as the active embedding model.\n`,
        );
        return;
      }

      die(`unknown embed subcommand "${sub ?? ""}" (expected status, run, or model)`);
      return;
    }

    // =========================================================================================
    // M4/plugins (ADR 007, PLAN §13): `plugin list|enable|disable|reload`. Kept as one clearly
    // separated block, per task instructions — other agents have touched the rest of this file.
    // One-shot DB operations against the same discovery `../plugins/manifest.ts` uses; no running
    // `nooklet serve` process is contacted. `enable`/`disable` flip the `plugin.enabled` column a
    // future `PluginHost.loadAll()` reads; `reload` re-reads the manifest from disk and refreshes
    // its recorded version — v1 has no live-reload channel into an already-running server, so
    // actually re-bundling/re-activating happens the next time that server (re)starts.
    // =========================================================================================
    case "plugin": {
      const sub = args._[1];
      const { ctx, config } = open(args);
      const { found, errors } = discoverPlugins(pluginDirsFor(config));
      for (const d of found) ensurePluginRow(ctx.driver, d.id, d.version, ctx.hlc.next());

      if (sub === "list") {
        for (const d of found) {
          const enabled = isPluginEnabled(ctx.driver, d.id);
          const halves = [d.serverEntry && "server", d.clientEntry && "client"]
            .filter(Boolean)
            .join("+");
          process.stdout.write(
            `${d.id.padEnd(20)} v${d.version.padEnd(9)} ${(enabled ? "enabled" : "disabled").padEnd(9)} ${halves.padEnd(13)} ${d.dir}\n`,
          );
        }
        for (const e of errors) {
          process.stdout.write(
            `${(e.id ?? "?").padEnd(20)} ERROR      ${e.message}  (${e.source})\n`,
          );
        }
        return;
      }

      const id = args._[2];
      if (!id) die(`plugin ${sub ?? ""} needs a plugin id (see: nooklet plugin list)`);
      const descriptor = found.find((d) => d.id === id);

      if (sub === "enable" || sub === "disable") {
        if (!descriptor) die(`no such plugin "${id}" (see: nooklet plugin list)`);
        setPluginEnabled(ctx, id, sub === "enable");
        process.stdout.write(
          `${sub === "enable" ? "enabled" : "disabled"} "${id}". Restart "nooklet serve" for this to take effect.\n`,
        );
        return;
      }

      if (sub === "reload") {
        if (!descriptor) die(`no such plugin "${id}" (see: nooklet plugin list)`);
        ensurePluginRow(ctx.driver, descriptor.id, descriptor.version, ctx.hlc.next());
        process.stdout.write(
          `refreshed "${id}" from disk (v${descriptor.version}). Restart "nooklet serve" to reload it.\n`,
        );
        return;
      }

      die(`unknown plugin subcommand "${sub ?? ""}" (expected list, enable, disable, or reload)`);
      return;
    }

    // =========================================================================================
    // M6/hardening (PLAN.md §15): backup/restore, op-log GC, rebuild()-parity verify.
    // =========================================================================================
    case "backup": {
      const { ctx, config } = open(args);
      const outFlag = args.flags.get("out");
      const result = createBackup(ctx.driver, {
        dataDir: config.dataDir,
        ...(typeof outFlag === "string" ? { outPath: resolve(outFlag) } : {}),
      });
      process.stdout.write(
        `backed up ${config.dataDir} -> ${result.path}\n` +
          `  schema version ${result.manifest.schemaVersion}, ${result.fileCount} file(s), ${result.archiveBytes} bytes\n`,
      );
      return;
    }

    case "restore": {
      const archivePath = args._[1];
      if (!archivePath) die("restore needs a path to a backup archive (see: nooklet backup)");
      // Deliberately does NOT call open(args): that would create/initialize a fresh database at
      // the target data dir before restoreBackup ever gets to run its own refuse-to-clobber check.
      const dir = dataDir(args);
      const result = restoreBackup(resolve(archivePath), {
        dataDir: dir,
        force: args.flags.get("force") === true,
      });
      process.stdout.write(
        `restored ${result.filesRestored} file(s) into ${dir} ` +
          `(archive schema version ${result.manifest.schemaVersion})\n` +
          `restart "nooklet serve" to use the restored data.\n`,
      );
      return;
    }

    case "gc": {
      const { ctx, config } = open(args);
      const report = runGc(ctx, {
        dataDir: config.dataDir,
        dryRun: args.flags.get("dry-run") === true,
        noBackup: args.flags.get("no-backup") === true,
      });
      if (report.refused) {
        process.stdout.write(`gc: refused to run - ${report.reason}\n`);
        for (const d of report.blockingDevices) {
          process.stdout.write(
            `  blocked by device "${d.name}" (${d.id}), acked_seq=${d.ackedSeq}\n`,
          );
        }
        return;
      }
      const verb = report.dryRun ? "would drop" : "dropped";
      process.stdout.write(
        `gc: floor=${report.floor} (op.seq < floor) - ${verb} ${report.dropCount} op(s), ` +
          `retaining ${report.retainCount}\n`,
      );
      if (report.backupPath) process.stdout.write(`  backup taken first: ${report.backupPath}\n`);
      if (report.reclaimedBytes !== undefined) {
        process.stdout.write(`  reclaimed ${report.reclaimedBytes} byte(s) on disk\n`);
      }
      return;
    }

    case "verify": {
      const { ctx } = open(args);
      const report = verifyRebuildParity(ctx.driver);
      process.stdout.write(`${formatVerifyReport(report)}\n`);
      if (!report.ok) process.exit(1);
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
