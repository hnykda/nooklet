/**
 * Bundles a plugin entry file with esbuild (ADR 007: "the host bundles each entry with esbuild and
 * `import()`s it") and, for the server half, `import()`s the result. `esbuild` was already present
 * transitively (a `vitest`/tooling dependency); it's now a direct `@nooklet/server` dependency
 * since this module calls its API directly.
 *
 * Host-provided modules (`@nooklet/plugin-api`, `@nooklet/core`, `zod`, `hono`) are resolved to
 * THIS package's own installed copies via esbuild's `alias` option and bundled in, rather than
 * requiring every plugin to `npm install` its own copies (a plugin author writes
 * `import { defineOp } from "@nooklet/plugin-api"` the same way core code does — a bare specifier
 * plugin-api's own package.json will never actually be reachable from a random plugin directory
 * that isn't part of this pnpm workspace). This is exactly what a host is supposed to provide (the
 * same idea as Obsidian's ambient `obsidian` module, or a browser extension host's ambient `chrome`
 * global) — see the module-level comment in `./host.ts` for how a plugin directory relates to the
 * workspace.
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const hostRequire = createRequire(import.meta.url);

/** Bare specifiers a plugin may import that the HOST provides, resolved to this package's own
 * installed copy so a plugin never needs its own `node_modules` for these. */
const HOST_PROVIDED_SPECIFIERS = ["@nooklet/plugin-api", "@nooklet/core", "zod", "hono"] as const;

function hostAliasMap(): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const spec of HOST_PROVIDED_SPECIFIERS) {
    try {
      alias[spec] = hostRequire.resolve(spec);
    } catch {
      // Not resolvable from here (shouldn't happen for any of the four above in a normal install)
      // — leave unaliased so esbuild's own resolution error names the real problem.
    }
  }
  return alias;
}

export interface BundleResult {
  /** Absolute path to the bundled output file. */
  file: string;
  /** sha256 of the output, first 12 hex chars — used for the client bundle's cache-busting URL
   * (`/plugins/<id>/client.<hash>.js`). */
  hash: string;
  warnings: esbuild.Message[];
}

/**
 * Bundles a plugin's SERVER entry for Node `import()`: ESM output, host-provided packages resolved
 * to this server's own copies (see file header), everything else the plugin's own code (bundled —
 * a plugin may be more than one local file). Output goes into `<pluginDir>/.nooklet-build/`,
 * which keeps Node module resolution for the plugin's own THIRD-PARTY deps (anything not in
 * `HOST_PROVIDED_SPECIFIERS`) working via a normal `node_modules` walk-up from the plugin's own
 * directory, exactly as if the file had been written there by hand.
 */
export async function bundleServerEntry(
  entryFile: string,
  pluginDir: string,
): Promise<BundleResult> {
  const outDir = join(pluginDir, ".nooklet-build");
  const outFile = join(outDir, "server.mjs");
  const result = await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: hostAliasMap(),
    write: true,
    logLevel: "silent",
    metafile: false,
  });
  const hash = await hashFile(outFile);
  return { file: outFile, hash, warnings: result.warnings };
}

/**
 * Bundles a plugin's CLIENT entry for the browser: fully bundled (browser code has no
 * `node_modules` to resolve against at runtime, so everything the plugin imports must be inlined
 * — host-provided packages aliased as above, third-party deps resolved from the plugin's own
 * `node_modules` same as the server bundle). Written to a fresh temp file per bundle (rather than
 * into the plugin dir) since the served URL is content-hashed
 * (`/plugins/<id>/client.<hash>.js`, `./routes.ts`) and callers key the in-memory cache by that
 * hash, not by path.
 */
export async function bundleClientEntry(entryFile: string): Promise<BundleResult> {
  const outDir = mkdtempSync(join(tmpdir(), "nooklet-plugin-client-"));
  const outFile = join(outDir, "client.js");
  const result = await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    alias: hostAliasMap(),
    write: true,
    logLevel: "silent",
    metafile: false,
  });
  const hash = await hashFile(outFile);
  return { file: outFile, hash, warnings: result.warnings };
}

async function hashFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/** `import()`s an already-bundled server entry, returning its default export. A fresh
 * `?v=<hash>` query string per bundle defeats Node's ES module cache, so a `reload` after editing
 * a plugin's source actually re-runs `activate()` against the new code (ADR 007's "Consequences":
 * "Node cannot evict ES modules... acceptable in development"). */
export async function importBundled(file: string, hash: string): Promise<unknown> {
  const url = `${pathToFileURL(file).href}?v=${hash}`;
  const mod = (await import(url)) as { default?: unknown };
  return mod.default;
}
