/**
 * Standalone entry point for the MCP stdio bridge: `node dist/mcp/stdio-main.js --token … --data …`.
 *
 * Deliberately a SEPARATE FILE from `./stdio.ts`, which is a library.
 *
 * The self-executing guard at the bottom compares `import.meta.url` with `process.argv[1]`. When a
 * bundler folds many modules into one file — as the desktop app's `build-sidecar.mjs` does — that
 * comparison becomes true for whichever entry point is being run, so this `main()` hijacked the
 * CLI: `nooklet serve --data <dir>` executed THIS instead, which reads `--data` as a database
 * *file*, and the app died on "unable to open database file".
 *
 * The two meanings of `--data` are both deliberate and both load-bearing: the CLI takes a data
 * directory, this bridge takes the database file itself. Keeping the auto-run in its own module is
 * what stops them colliding.
 */

import { fileURLToPath } from "node:url";
import { createServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";
import { buildRegistry } from "../ops/index.js";
import type { ServerConfig } from "../ops/registry.js";
import { startStdioBridge } from "./stdio.js";

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
