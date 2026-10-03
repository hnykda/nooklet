/**
 * Directories scanned for plugins, given a graph's own `config.dataDir` (ADR 007/M4): that graph's
 * own `plugins/`, then — in a monorepo checkout with no bundled plugins dir set — the repo root's
 * own source `plugins/`. Shared by `registry.ts` (every graph `serve` opens) and `cli.ts`'s
 * `plugin` subcommand (one graph, no running server involved), so there is exactly one place this
 * rule lives.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function pluginDirsFor(dataDir: string): { dirs: string[]; bundled: string[] } {
  const graphPlugins = join(dataDir, "plugins");
  // The desktop sidecar's built-ins, bundled at build time: `apps/desktop/build-sidecar.mjs`
  // points this at the `plugins/` beside its `server.mjs`. The repo's `plugins/` below are
  // sources, which a bundled server cannot build — it has no `node_modules` to resolve their
  // imports in.
  const bundled = process.env.NOOKLET_BUNDLED_PLUGINS_DIR;
  if (bundled) return { dirs: [graphPlugins], bundled: [resolve(bundled)] };
  const repoRootPlugins = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "plugins",
  );
  return { dirs: [graphPlugins, repoRootPlugins], bundled: [] };
}
