#!/usr/bin/env node
/**
 * `nooklet` CLI: the one entry point that wires the pieces of this package together.
 *
 *   nooklet serve   [--data <dir>] [--port <n>]     run the HTTP API + MCP endpoint
 *   nooklet import  <logseq-graph-dir> [--data <dir>]  one-shot Logseq import: a file graph's
 *                                                     folder, or a DB-version graph's root
 *   nooklet export  [--data <dir>]                  write the markdown mirror (ADR 002)
 *   nooklet mcp --stdio [--token <t>] [--data <dir>] MCP over stdio, for Claude Desktop (ADR 008)
 *   nooklet pair    --link <public url> [--scope read|write] [--no-sync] [--minutes <n>]
 *                   one-time pairing code as a terminal QR (B-655; `./auth/pairing-codes.ts`)
 *   nooklet token   create --label <l> [--scope read|write|admin] [--sync] [--ui-control]
 *                   [--link <public url>] (B-603: also prints a nooklet://connect pairing link) |
 *                   list | revoke <id> | root  (--ui-control grants ADR 015's live-UI-control
 *                   capability; `root` prints this data dir's root token — ADR 025, `/graphs` —
 *                   minting one if it does not exist yet; ignores --graph, it is not per-graph)
 *   nooklet embed   status | run | model <name> [--provider ollama|openai-compat] [--host <url>]
 *                   M3/ADR 010 embeddings: index status, drain the queue now, or switch models.
 *   nooklet backup  [--graph <id>] [--out <path>] [--data <dir>]  VACUUM INTO snapshot + assets/,
 *                   as a single .tar.gz archive (M6, docs/OPERATIONS.md)
 *   nooklet restore <archive> [--graph <id>] [--data <dir>] [--force]  restore a backup into one
 *                   graph (refuses to clobber an existing database unless --force; refuses an
 *                   archive newer than this build)
 *   nooklet gc      [--dry-run] [--no-backup] [--asset-grace <days>] [--data <dir>]
 *                   op-log GC down to min(device.acked_seq) across live devices (M6), and
 *                   removal of assets nothing references any more (M7, ./gc.ts)
 *   nooklet verify  [--data <dir>]  rebuild()-vs-live-state parity check (ADR 003, ./verify.ts);
 *                   also runs automatically at "nooklet serve" startup when NODE_ENV != production
 *   nooklet repair  org-dates [--apply] [--data <dir>]  turn org `SCHEDULED:`/`DEADLINE:` lines an
 *                   old import left in block text into real dates, one undoable batch
 *                   (./repair-org-dates.ts); a dry run that writes nothing unless --apply
 *
 * `--data` defaults to $NOOKLET_DATA, then ~/.nooklet/default. One process can host several graphs
 * (ADR 025): each graph's database lives at <data>/graphs/<id>/graph.sqlite and its mirror at
 * <data>/graphs/<id>/{pages,journals}/. Every command except `serve` operates on exactly one graph,
 * chosen with `--graph <id>` (default "default") — `serve` hosts every graph under <data>/graphs/
 * at once, routed by `/g/<id>/`. A pre-ADR-025 flat `<data>/graph.sqlite` is folded into
 * `<data>/graphs/default/` automatically, once, the first time any command touches that data dir.
 */

import { existsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { renderUnicodeCompact } from "uqr";
import type { ServerContext } from "./apply-ops.js";
import { createPairingCode } from "./auth/pairing-codes.js";
import {
  graphAddress,
  PairingLinkError,
  pairingLink,
  pairingPageUrl,
} from "./auth/pairing-link.js";
import { ensureRootToken } from "./auth/root-token.js";
import { createToken, revokeToken } from "./auth/tokens.js";
import { createBackup, restoreBackup } from "./backup/index.js";
import {
  type Args,
  booleanFlag,
  CliArgError,
  checkFlags,
  GRAPH_FLAGS,
  GRAPH_SUBCOMMAND_FLAGS,
  PAIR_FLAGS,
  parseArgs,
  parseGcFlags,
  parseRepairFlags,
  RESTORE_FLAGS,
  wantsHelp,
} from "./cli-args.js";
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
import { migrateLegacyLayoutIfNeeded } from "./graphs/migrate-legacy-layout.js";
import { createMultiGraphApp } from "./graphs/mount.js";
import type { BaseServerConfig } from "./graphs/open-graph.js";
import { graphDir } from "./graphs/paths.js";
import { pluginDirsFor } from "./graphs/plugin-dirs.js";
import {
  createGraphForCommand,
  ensureGraphMeta,
  GraphRegistry,
  GraphSelectionError,
  openGraphForCommand,
} from "./graphs/registry.js";
import {
  GraphRetireError,
  listRetired,
  replaceGraph,
  retireGraph,
  unretireGraph,
} from "./graphs/retire.js";
import { liveServer, liveServerMessage, writeServerLock } from "./graphs/server-lock.js";
import { guardUpgradeSockets } from "./http/upgrade-guard.js";
import { detectLogseqGraph, importLogseqGraph } from "./importer/logseq.js";
import {
  configureLiveLimits,
  createLiveWebSocketServer,
  parseLiveLimitFlags,
} from "./live-limits.js";
import { startStdioBridge } from "./mcp/stdio.js";
import { exportAll } from "./mirror/export.js";
import { startLiveMirror } from "./mirror/live.js";
import { buildRegistry } from "./ops/index.js";
import type { ServerConfig } from "./ops/registry.js";
import { discoverPlugins } from "./plugins/manifest.js";
import { ensurePluginRow, isPluginEnabled, setPluginEnabled } from "./plugins/settings.js";
import { applyOrgDateRepair, formatOrgDateReport, planOrgDateRepair } from "./repair-org-dates.js";
import { formatServeBanner } from "./serve-banner.js";
import { formatVerifyReport, verifyRebuildParity } from "./verify.js";
import { NOOKLET_VERSION } from "./version.js";

function dataDir(args: Args): string {
  const flag = args.flags.get("data");
  if (typeof flag === "string") return resolve(flag);
  if (process.env.NOOKLET_DATA) return resolve(process.env.NOOKLET_DATA);
  return join(homedir(), ".nooklet", "default");
}

/** Which graph a single-graph command (`import`, `export`, `token`, ...) operates on (ADR 025) —
 * `--graph <id>`, defaulting to `"default"` so an existing single-graph install keeps working with
 * no flag at all. `serve` doesn't use this: it hosts every graph in `<dataDir>/graphs/` at once. */
function graphIdFlag(args: Args): string {
  const flag = args.flags.get("graph");
  return typeof flag === "string" ? flag : "default";
}

function loopbackTokenFlag(flag: unknown): boolean | undefined {
  if (flag === undefined) return undefined;
  return flag !== false && flag !== "false";
}

function baseServerConfig(args: Args): BaseServerConfig {
  const portFlag = args.flags.get("port");
  const hostFlag = args.flags.get("host");
  const allowFlag = args.flags.get("allow-host");
  return {
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
    // `--no-loopback-token` parses as `loopback-token: false` (cli-args.ts). Only `serve` reads it.
    // Absent: on for a loopback bind only (`http/app.ts#loopbackTokenEnabled`).
    loopbackToken: loopbackTokenFlag(args.flags.get("loopback-token")),
  };
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

interface OpenOptions {
  /**
   * Run pending data migrations (today: ADR 018's journal renames, which mint ops rather than
   * updating rows and so cannot live in `schema.ts`).
   *
   * Off by default, and opted into only by the commands that are already writers. `backup`,
   * `verify`, `gc` and `export` are things you reach for when you want to inspect or preserve a
   * graph, not change it — a "read-only" command that quietly rewrote 825 page names would be a
   * nasty surprise, and `verify`'s report would be about a database other than the one you asked
   * about. Found the hard way, by running `nooklet backup` on a real graph.
   */
  migrate?: boolean;
}

function open(args: Args, opts: OpenOptions = {}): { ctx: ServerContext; config: ServerConfig } {
  const dir = dataDir(args);
  migrateLegacyLayoutIfNeeded(dir);
  // Through the registry's helper, not `openGraph` directly: on a fresh data dir this creates the
  // default graph, and it must get its `graph.json` or `serve` later fails (B-607).
  try {
    return openGraphForCommand(dir, graphIdFlag(args), baseServerConfig(args), {
      migrate: opts.migrate,
    });
  } catch (err) {
    if (err instanceof GraphSelectionError) die(err.message);
    throw err;
  }
}

/**
 * Plugin discovery roots, in order: `<dataDir>/plugins` (where a real install's plugins live —
 * created lazily, so it needn't exist yet), then the 3 built-ins (M4/PLAN §13). Those are
 * `$NOOKLET_BUNDLED_PLUGINS_DIR` when it is set, and otherwise the repo root's own `plugins/`,
 * found relative to THIS file rather than `cwd()` so `nooklet serve` works the same from any
 * directory. A build with neither — no `plugins/` three levels above it — silently finds none,
 * which is how the desktop app shipped without them (B-180).
 */
function die(message: string): never {
  process.stderr.write(`nooklet: ${message}\n`);
  process.exit(1);
}

/** Runs a `cli-args.ts` flag parser, turning its `CliArgError` into `die`. */
function cliArg<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof CliArgError) die(err.message);
    throw err;
  }
}

const USAGE = `nooklet — a local-first outliner server

  nooklet serve  [--data <dir>] [--port <n>] [--web <dir>]
                 [--host <addr>] [--allow-host <h,h>]   expose on a LAN/tailnet
                 [--no-loopback-token]   never auto-issue a token to "this machine"; use
                                         behind a same-host reverse proxy (docs/OPERATIONS.md).
                                         Default: on for a loopback bind, off with a non-loopback
                                         --host (--loopback-token turns it back on)
                 [--ws-max-per-token <n>] [--ws-max-total <n>]   live-socket caps (default 20, 500)
  nooklet import <logseq-graph-dir> [--data <dir>]
                                         a file graph's folder (pages/, journals/), or a
                                         DB-version graph's root (db.sqlite + mirror/markdown/)
  nooklet export [--data <dir>]
  nooklet mcp --stdio [--token <token>] [--data <dir>]
  nooklet graph create <id> [--label <label>] [--data <dir>]
  nooklet graph list [--retired] [--data <dir>]
  nooklet graph retire <id> [--force] [--data <dir>]   move graphs/<id> to graphs-retired/
                      (nothing is deleted; "default" needs --force; refused while serve runs)
  nooklet graph unretire <retired-name> [--as <id>] [--data <dir>]
  nooklet graph replace <id> --from <dir> [--data <dir>]   swap in a re-imported graph,
                      keeping its tokens; the old one is retired
  nooklet pair --link <public url> [--scope read|write] [--no-sync] [--minutes <1-60>]
                      print a one-time pairing QR code for a phone (default: write + sync, 10 min)
  nooklet token create --label <label> [--scope read|write|admin] [--sync] [--ui-control]
                      [--link <public url>]   also print a nooklet://connect link CONTAINING the
                                              token (prefer "nooklet pair")
  nooklet token list
  nooklet token revoke <token-id>
  nooklet token root
  nooklet embed status
  nooklet embed run
  nooklet embed model <name> [--provider ollama|openai-compat] [--host <url>]
  nooklet plugin list
  nooklet plugin enable <plugin-id>
  nooklet plugin disable <plugin-id>
  nooklet plugin reload <plugin-id>
  nooklet backup [--graph <id>] [--out <path>] [--data <dir>]
  nooklet restore <archive> [--graph <id>] [--data <dir>] [--force]
  nooklet gc [--graph <id>] [--dry-run] [--no-backup] [--asset-grace <days>] [--data <dir>]
  nooklet verify [--graph <id>] [--data <dir>]
  nooklet repair org-dates [--graph <id>] [--apply] [--data <dir>]   dry run unless --apply
  nooklet --version | -V

  Every command except serve works on one graph: --graph <id>, default "default".
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  // `--help` / `-h` anywhere prints usage and touches nothing (B-146). It used to be a flag nobody
  // read, so `nooklet serve --help` served the default graph with migrations and the live mirror
  // on — an agent reading the flags did exactly that to the owner's real graph for ten minutes.
  if (wantsHelp(args, process.argv.slice(2))) {
    process.stdout.write(USAGE);
    return;
  }
  // B-696. Like --help, answered before anything opens a data dir. `-V` is not a `--` flag, so it
  // lands in `args._`; only honoured as the first token, so it can never be a positional value.
  if (args.flags.has("version") || cmd === "-V" || cmd === "version") {
    process.stdout.write(`nooklet ${NOOKLET_VERSION}\n`);
    return;
  }

  switch (cmd) {
    case "serve": {
      const dir = dataDir(args);
      migrateLegacyLayoutIfNeeded(dir);
      const baseConfig = baseServerConfig(args);
      const webClientDir = resolveWebClientDir(args.flags.get("web"));
      // B-676 H4: caps on /sync/live and /ui/live sockets (`live-limits.ts`).
      configureLiveLimits(cliArg(() => parseLiveLimitFlags(args)));

      // One indexer per graph this process ends up opening (ADR 025 — a graph is opened lazily,
      // the first time something asks for it, not necessarily at boot), so shutdown can stop all
      // of them, not just whichever graph happened to be first.
      const indexers = new Map<string, EmbeddingIndexer>();
      // Per graph too, so retiring one (B-713) stops its mirror before its database closes.
      const mirrors = new Map<string, ReturnType<typeof startLiveMirror>>();
      const registry = new GraphRegistry(dir, {
        registry: buildRegistry(),
        baseConfig,
        webClientDir,
        migrate: true,
        onOpen: async (handle) => {
          // ADR 002's continuous mirror — the half that never existed (B-95): pages/ and
          // journals/ followed commits only when someone ran `nooklet export`. `--no-mirror`
          // turns it off, for every graph this process hosts.
          if (handle.config.mirror.enabled) {
            mirrors.set(handle.id, startLiveMirror(handle.ctx, handle.config.dataDir));
          }

          // ADR 003 / sql-schema.md rule 26: "A dev-mode server SHOULD run rebuild() into a
          // scratch database on every start and diff it against the live state tables." Dev-only
          // (the replay + diff cost is fine at hobby-graph scale but not something to pay on
          // every production boot) and never fatal — a divergence is exactly the regression this
          // exists to surface, not a reason to refuse to serve.
          if (process.env.NODE_ENV !== "production") {
            const report = verifyRebuildParity(handle.ctx.driver);
            process.stderr.write(`[${handle.id}] ${formatVerifyReport(report)}\n`);
          }

          // M3/ADR 010: drain embed_dirty on an interval, in-process, per graph. Network calls
          // (the only slow part) are awaited, so this never blocks the event loop's handling of
          // concurrent requests.
          const indexer = new EmbeddingIndexer({
            driver: handle.ctx.driver,
            providerFor: (model) => buildProviderForModel(handle.ctx.driver, model),
            log: (message) =>
              process.stderr.write(`nooklet: [${handle.id}] embedding indexer: ${message}\n`),
          });
          indexer.start();
          indexers.set(handle.id, indexer);
        },
        onClose: (handle) => {
          // The mirror's last sweep runs now, while the database is still open, so the retired
          // folder's markdown copy is as current as its database.
          const mirror = mirrors.get(handle.id);
          mirrors.delete(handle.id);
          mirror?.flush();
          mirror?.stop();
          indexers.get(handle.id)?.stop();
          indexers.delete(handle.id);
        },
      });

      const { token: rootToken, created: rootTokenCreated } = ensureRootToken(dir);
      if (rootTokenCreated) {
        process.stderr.write(
          `nooklet: minted a root token for /graphs (list/create graphs on this server) — keep ` +
            `this secret. Run "nooklet token root" to see it again later:\n  ${rootToken}\n`,
        );
      }
      const app = createMultiGraphApp({ dataDir: dir, registry, rootToken, webClientDir });

      // A brand-new data dir has no graphs at all yet — before ADR 025 `nooklet serve` always had
      // exactly one, created implicitly on first run, and that zero-config experience matters more
      // for the common case (one person, one graph) than the purity of "creation is always an
      // explicit /graphs call." So: a data dir with no graphs at all gets a "default" one now.
      if ((await registry.list()).length === 0) await registry.create("default");

      // Fail fast for the common case (one graph, "default"): open it now, before this process
      // ever claims to be serving, exactly as the pre-ADR-025 single-graph `open()` did. Any
      // OTHER graph stays lazy — added later, opened on first request, no restart needed.
      if (existsSync(graphDir(dir, "default"))) await registry.resolve("default");

      // `/sync/live` (../sync/live.ts) needs a real `ws` WebSocketServer wired into the Node
      // adapter's `serve()` call — `upgradeWebSocket` (used by that route) only handles the Hono
      // side of the handshake; `@hono/node-server` needs a `{ noServer: true }` WebSocketServer
      // to hand upgraded connections to. See `@hono/node-server`'s own WebSocket docs. It carries
      // the frame-size limit (B-676 H12, `live-limits.ts`).
      const wss = createLiveWebSocketServer();
      const shutdown = (): void => {
        for (const indexer of indexers.values()) indexer.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Loopback by default (see ServerConfig.host): reaching this server from another machine
      // has to be something you asked for.
      const hostname = baseConfig.host ?? "127.0.0.1";
      // B-589 (a client reset mid-upgrade crashed the process) is handled by
      // `guardUpgradeSockets` below, at `'connection'` time. It must NOT be a second `'upgrade'`
      // listener: @hono/node-server only answers a failed upgrade when it is the sole one (B-602).
      // See `http/upgrade-guard.ts`.
      const server = serve(
        { fetch: app.fetch, port: baseConfig.port, hostname, websocket: { server: wss } },
        (info) => {
          // B-604: a wildcard bind lists the LAN addresses to use, and which still need
          // --allow-host (`serve-banner.ts`).
          const banner = formatServeBanner({
            dataDir: dir,
            host: hostname,
            port: info.port,
            allowedHosts: baseConfig.allowedHosts,
            webClientDir,
            interfaces: networkInterfaces(),
            version: NOOKLET_VERSION,
          });
          process.stdout.write(banner.stdout);
          if (banner.stderr) process.stderr.write(banner.stderr);
          // B-713: lets `nooklet graph retire` (another process) see that this data dir is live.
          // Written only once listening, so a serve that failed to bind never claims the dir.
          const removeLock = writeServerLock(dir, info.port);
          process.on("exit", removeLock);
        },
      );
      guardUpgradeSockets(server);
      // B-685: a failed listen is an 'error' event on the server; unhandled, Node threw it as a
      // raw EADDRINUSE stack trace. Say what happened and what to do, in one line.
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          die(
            `port ${baseConfig.port} on ${hostname} is in use — stop the other server, or pick another with --port <n>`,
          );
        }
        if (err.code === "EACCES") {
          die(`not allowed to listen on port ${baseConfig.port} — pick another with --port <n>`);
        }
        die(`could not listen on ${hostname}:${baseConfig.port}: ${err.message}`);
      });
      return;
    }

    case "import": {
      const graphDir = args._[1];
      if (!graphDir) die("import needs a Logseq graph directory");
      const layout = detectLogseqGraph(resolve(graphDir));
      process.stderr.write(
        layout.kind === "db"
          ? `nooklet: a Logseq DB-version graph: pages from ${layout.markdownDir}, images, favourites and dates from ${layout.sqliteFile} (read from a copy)\n`
          : `nooklet: a Logseq file graph at ${layout.root}\n`,
      );
      const { ctx, config } = open(args, { migrate: true });
      const stats = await importLogseqGraph(ctx, resolve(graphDir), { dataDir: config.dataDir });
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return;
    }

    case "export": {
      const { ctx, config } = open(args);
      const result = exportAll(ctx.driver, config.dataDir);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // Every other page was still written; say so in the exit status too.
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }

    case "mcp": {
      if (!args.flags.get("stdio")) die("only --stdio is supported: nooklet mcp --stdio");
      const { ctx, config } = open(args, { migrate: true });
      const token = args.flags.get("token");
      startStdioBridge({
        serverCtx: ctx,
        registry: buildRegistry(),
        config,
        ...(typeof token === "string" ? { token } : {}),
      });
      return;
    }

    // ADR 025: graphs on this data dir, without a running server. `create` is how the desktop app
    // adds a graph to This Mac (B-643); the HTTP equivalent is `POST /graphs` with the root token.
    case "graph": {
      const sub = args._[1];
      if (!sub || !Object.hasOwn(GRAPH_SUBCOMMAND_FLAGS, sub)) {
        die(
          `unknown graph subcommand "${sub ?? ""}" (expected create, list, retire, unretire or replace)`,
        );
      }
      cliArg(() =>
        checkFlags(args, GRAPH_SUBCOMMAND_FLAGS[sub as keyof typeof GRAPH_SUBCOMMAND_FLAGS]),
      );
      // `GRAPH_FLAGS` is the union the flag audit checks this case against.
      cliArg(() => checkFlags(args, GRAPH_FLAGS));
      const dir = dataDir(args);
      migrateLegacyLayoutIfNeeded(dir);
      // B-713: retire and replace move a graph's folder out from under whoever has it open. A live
      // `serve` on this data dir keeps its graphs' databases open and cannot be told from here to
      // let go, so refuse while one runs; `DELETE /graphs/<id>` retires from a running server.
      // `unretire` is allowed: it only moves a folder into `graphs/` under an id nothing serves
      // (it refuses an existing one), and a running server opens it on the first request.
      if (sub === "retire" || sub === "replace") {
        const live = liveServer(dir);
        if (live) die(liveServerMessage(dir, live));
      }
      if (sub === "retire") {
        const id = args._[2];
        if (!id) die("graph retire needs an id, e.g. nooklet graph retire work");
        try {
          const r = retireGraph(dir, id, { force: booleanFlag(args, "force", false) });
          process.stdout.write(
            `retired "${r.id}": moved to ${r.path}\n` +
              `Nothing was deleted. To bring it back: nooklet graph unretire ${r.retiredName}` +
              ` (add --as <id> to restore it under another id).\n`,
          );
        } catch (err) {
          if (err instanceof GraphRetireError) die(err.message);
          throw err;
        }
        return;
      }
      if (sub === "unretire") {
        const name = args._[2];
        if (!name)
          die("graph unretire needs a retired graph's name (see: nooklet graph list --retired)");
        const as = args.flags.get("as");
        if (as !== undefined && typeof as !== "string") die("--as needs a graph id");
        try {
          const r = unretireGraph(dir, name, as);
          process.stdout.write(
            `restored "${r.id}" from ${r.from}\nA running server picks it up on its next request for /g/${r.id}/.\n`,
          );
        } catch (err) {
          if (err instanceof GraphRetireError) die(err.message);
          throw err;
        }
        return;
      }
      if (sub === "replace") {
        const id = args._[2];
        const from = args.flags.get("from");
        if (!id || typeof from !== "string") {
          die(
            "graph replace needs an id and --from <dir>, e.g. nooklet graph replace work --from /tmp/scratch",
          );
        }
        try {
          const r = replaceGraph(dir, id, from);
          process.stdout.write(
            `replaced "${r.id}" with ${r.source} (${r.tokensCarried} token${r.tokensCarried === 1 ? "" : "s"} carried over)\n` +
              `The old graph is in ${r.retired.path}; nothing was deleted.\n` +
              `Devices that synced the old graph will show "The server has a different graph now"; ` +
              `"Discard the local copy and re-sync" is expected: the replacement is a new graph instance.\n`,
          );
        } catch (err) {
          if (err instanceof GraphRetireError) die(err.message);
          throw err;
        }
        return;
      }
      if (sub === "create") {
        const id = args._[2];
        if (!id) die("graph create needs an id, e.g. nooklet graph create work --label Work");
        const label = args.flags.get("label");
        try {
          const meta = createGraphForCommand(
            dir,
            id,
            baseServerConfig(args),
            typeof label === "string" ? label : undefined,
          );
          process.stdout.write(`${JSON.stringify(meta)}\n`);
        } catch (err) {
          if (err instanceof GraphSelectionError) die(err.message);
          throw err;
        }
        return;
      }
      if (sub === "list") {
        if (booleanFlag(args, "retired", false)) {
          for (const g of listRetired(dir)) {
            process.stdout.write(`${g.name}\t${g.id}\t${g.retiredAt}\t${g.label ?? ""}\n`);
          }
          return;
        }
        const registry = new GraphRegistry(dir, {
          registry: buildRegistry(),
          baseConfig: baseServerConfig(args),
        });
        for (const g of await registry.list()) process.stdout.write(`${g.id}\t${g.label}\n`);
        return;
      }
      return;
    }

    // QR pairing for a headless server (B-655): a one-time code, shown as a terminal QR of the
    // server's pairing page. The code goes to stdout for the owner and nowhere else: not to the
    // server's log, not into root.token, not into the database (only its hash).
    case "pair": {
      cliArg(() => checkFlags(args, PAIR_FLAGS));
      const linkFlag = args.flags.get("link");
      if (typeof linkFlag !== "string")
        die(
          "pair needs --link <the address phones use to reach this server>, e.g. --link https://nooklet.example.ts.net",
        );
      const scope = args.flags.get("scope") ?? "write";
      if (scope !== "read" && scope !== "write")
        die(`pair grants read or write only (got "${String(scope)}"); admin is never pairable`);
      const minutesFlag = args.flags.get("minutes");
      const minutes = minutesFlag === undefined ? 10 : Number(minutesFlag);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)
        die("--minutes must be a whole number from 1 to 60");
      const canSync = cliArg(() => booleanFlag(args, "sync", true));
      const graphId = graphIdFlag(args);
      // Validate the address BEFORE minting, so a typo leaves no live code behind.
      let pageFor: (code: string) => string;
      try {
        graphAddress(linkFlag, graphId);
        pageFor = (code) => pairingPageUrl(linkFlag, code, graphId);
      } catch (err) {
        if (err instanceof PairingLinkError) die(err.message);
        throw err;
      }
      const { ctx } = open(args);
      const created = createPairingCode(ctx.driver, {
        scope,
        canSync,
        ttlMs: minutes * 60_000,
        createdBy: null,
      });
      const url = pageFor(created.code);
      process.stdout.write(
        `${renderUnicodeCompact(url, { border: 2 })}\n\n` +
          `Scan with the phone's camera, then tap "Open in the nooklet app".\n` +
          `Or open this address on the device:\n  ${url}\n\n` +
          `Single use, expires at ${new Date(created.expiresAt).toLocaleTimeString()} ` +
          `(${minutes} min). Grants ${scope}${canSync ? " + sync" : ""} on graph "${graphId}".\n` +
          `Running "nooklet pair" again cancels this code.\n`,
      );
      return;
    }

    case "token": {
      const sub = args._[1];
      // Deliberately does NOT call open(args): the root token lives at <dataDir>/root.token,
      // outside every graph's own database (ADR 025) — printing it should not need to open, or
      // even create, any graph at all.
      if (sub === "root") {
        const dir = dataDir(args);
        const { token } = ensureRootToken(dir);
        process.stdout.write(`${token}\n`);
        return;
      }
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
        const canSync = args.flags.get("sync") === true;
        // B-603: `--link <public url>` also prints a `nooklet://connect` pairing link. Checked
        // BEFORE minting, so a bad address does not leave an unused live token behind.
        const linkFlag = args.flags.get("link");
        if (linkFlag === true)
          die("--link needs the address devices use, e.g. --link http://192.168.1.5:6100");
        const linkFor = (token: string): string | undefined => {
          if (typeof linkFlag !== "string") return undefined;
          try {
            return pairingLink(linkFlag, token, graphIdFlag(args));
          } catch (err) {
            if (err instanceof PairingLinkError) die(err.message);
            throw err;
          }
        };
        linkFor("nk_validate");
        const created = createToken(ctx.driver, { label, scope, canSync, uiControl });
        process.stdout.write(
          `${created.token}\n\nSaved as "${label}" (${scope}${uiControl ? ", ui:control" : ""}). This is the only time it is shown.\n`,
        );
        const link = linkFor(created.token);
        if (link) {
          process.stdout.write(
            `\nPairing link: open it on the phone (tap it in Notes/Messages, or paste it into\n` +
              `Safari's address bar). The app shows the server address and asks before connecting.\n` +
              `  ${link}\n` +
              `It CONTAINS the token: anyone who sees it can use this graph until you revoke it\n` +
              `("nooklet token revoke"). Clipboard, chat, shell history and screenshots all keep it.\n` +
              (canSync && scope !== "read"
                ? ""
                : `Note: a phone needs --scope write --sync to edit and sync; this token is ${scope}${canSync ? "" : " without --sync"}.\n`),
          );
        }
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
      die(`unknown token subcommand "${sub ?? ""}" (expected create, list, revoke, or root)`);
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
        // `fake` (deterministic vectors, `embeddings/fake-provider.ts`) only for test harnesses that
        // ask for it: the e2e suite needs a server whose semantic search really runs, without a
        // model (`e2e/tests/search-semantic-server.spec.ts`). Never offered to a person.
        const fakeAllowed = provider === "fake" && process.env.NOOKLET_TEST_FAKE_EMBEDDINGS === "1";
        if (provider !== "ollama" && provider !== "openai-compat" && !fakeAllowed) {
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
      const plugins = pluginDirsFor(config.dataDir);
      const { found, errors } = discoverPlugins([...plugins.dirs, ...plugins.bundled]);
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
      const result = await createBackup(ctx.driver, {
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
      const force = cliArg(() => {
        checkFlags(args, RESTORE_FLAGS);
        return booleanFlag(args, "force", false);
      });
      // Deliberately does NOT call open(args): that would create/initialize a fresh database at
      // the target data dir before restoreBackup ever gets to run its own refuse-to-clobber check.
      // Targets this graph's own subdirectory (ADR 025) so a restored archive lands exactly where
      // `serve`/`open()` will look for it — migrateLegacyLayoutIfNeeded never needs to touch it.
      const dir = graphDir(dataDir(args), graphIdFlag(args));
      const result = await restoreBackup(resolve(archivePath), { dataDir: dir, force });
      // Into a fresh data dir this is the graph's first database; give it its graph.json (B-607).
      ensureGraphMeta(dataDir(args), graphIdFlag(args));
      process.stdout.write(
        `restored ${result.filesRestored} file(s) into ${dir} ` +
          `(archive schema version ${result.manifest.schemaVersion})\n` +
          `restart "nooklet serve" to use the restored data.\n`,
      );
      return;
    }

    case "gc": {
      // Parsed before the database is opened: a flag gc does not understand stops the run.
      const gcFlags = cliArg(() => parseGcFlags(args));
      const { ctx, config } = open(args);
      const report = await runGc(ctx, { dataDir: config.dataDir, ...gcFlags });
      // The op-log half can be refused (no device has synced yet); the asset half never is, so
      // both are always reported.
      if (report.refused) {
        process.stdout.write(`gc: op log - refused to run - ${report.reason}\n`);
        for (const d of report.blockingDevices) {
          process.stdout.write(
            `  blocked by device "${d.name}" (${d.id}), acked_seq=${d.ackedSeq}\n`,
          );
        }
      } else {
        const verb = report.dryRun ? "would drop" : "dropped";
        process.stdout.write(
          `gc: op log - floor=${report.floor} (op.seq < floor) - ${verb} ${report.dropCount} ` +
            `op(s), retaining ${report.retainCount}\n`,
        );
        if (report.reclaimedBytes !== undefined) {
          process.stdout.write(`  reclaimed ${report.reclaimedBytes} byte(s) in the database\n`);
        }
      }
      const a = report.assets;
      const assetVerb = report.dryRun ? "would remove" : "removed";
      process.stdout.write(
        `gc: assets - ${a.total} on record, ${assetVerb} ${a.orphans.length} orphan(s) ` +
          `(unreferenced for over ${a.graceDays} day${a.graceDays === 1 ? "" : "s"}); ` +
          `${a.inGrace} unreferenced but within the grace period, ${a.keptByTrashOnly} ` +
          `referenced only from the trash, ${a.keptByHistoryOnly} only from page history - all kept\n`,
      );
      for (const o of a.orphans) {
        process.stdout.write(
          `  ${report.dryRun ? "orphan" : "removed"}: assets/${o.id}.${o.ext} ` +
            `("${o.fileName}", ${o.byteSize} bytes, uploaded ${new Date(o.createdAt).toISOString()})\n`,
        );
      }
      if (a.removed > 0) process.stdout.write(`  reclaimed ${a.reclaimedBytes} byte(s) of files\n`);
      if (report.backupPath) process.stdout.write(`  backup taken first: ${report.backupPath}\n`);
      return;
    }

    case "verify": {
      const { ctx, config } = open(args);
      // On disk beside the graph, not in memory: the replica holds the whole replayed op log.
      const scratchPath = join(config.dataDir, `.verify-scratch-${process.pid}.sqlite`);
      const report = verifyRebuildParity(ctx.driver, { scratchPath });
      process.stdout.write(`${formatVerifyReport(report)}\n`);
      if (!report.ok) process.exit(1);
      return;
    }

    case "repair": {
      // Parsed before the database is opened, like gc: a typo must not become a run.
      const flags = cliArg(() => parseRepairFlags(args));
      const { ctx } = open(args);
      if (flags.apply) {
        const result = applyOrgDateRepair(ctx);
        process.stdout.write(`${formatOrgDateReport(result, result)}\n`);
      } else {
        process.stdout.write(`${formatOrgDateReport(planOrgDateRepair(ctx))}\n`);
      }
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
