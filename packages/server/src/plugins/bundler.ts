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
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const hostRequire = createRequire(import.meta.url);

/** Bare specifiers a plugin may import that the HOST provides, resolved to this package's own
 * installed copy so a plugin never needs its own `node_modules` for these. */
export const HOST_PROVIDED_SPECIFIERS = [
  "@nooklet/plugin-api",
  "@nooklet/core",
  "zod",
  "hono",
] as const;

/** The file a host-provided specifier is shipped as in a host-modules directory
 * (`./bundled.ts#packageHostModules`): `@nooklet/plugin-api` → `nooklet__plugin-api.mjs`. */
export function hostModuleFileName(spec: string): string {
  return `${spec.replace(/^@/, "").replaceAll("/", "__")}.mjs`;
}

/**
 * Where each host-provided specifier points a plugin's bundle.
 *
 * `$NOOKLET_HOST_MODULES_DIR` first, when it is set and has the file: the desktop sidecar's
 * `server.mjs` is ONE bundled file with no `node_modules` beside it, so `hostRequire.resolve` finds
 * nothing there, the map came out empty, and every plugin a user wrote the documented way failed to
 * build with `Could not resolve "@nooklet/plugin-api"` / `"zod"` (B-336). The sidecar build ships
 * those modules as files (`packageHostModules`) and its `server.mjs` sets the variable. They are
 * preferred over resolution, not a fallback to it, so a sidecar never picks up whatever copy
 * happens to sit in a `node_modules` above wherever the app was unpacked.
 */
export function hostAliasMap(): Record<string, string> {
  const alias: Record<string, string> = {};
  const shipped = process.env.NOOKLET_HOST_MODULES_DIR;
  for (const spec of HOST_PROVIDED_SPECIFIERS) {
    const file = shipped ? join(shipped, hostModuleFileName(spec)) : undefined;
    if (file && existsSync(file)) {
      alias[spec] = file;
      continue;
    }
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
 * `node_modules` same as the server bundle).
 *
 * Output is content-addressed inside the plugin's own `.nooklet-build/` (`client.<hash>.js`, the
 * same name the served URL carries). It used to go to a fresh `mkdtemp` directory per call that
 * nothing removed (B-181): every server start and every plugin test left one behind, thousands on
 * a developer machine, and since a client half can bundle a real library (mermaid, 12 MB) that is
 * not a rounding error. Content addressing also makes concurrent servers on one checkout safe:
 * two writers of the same hash write the same bytes, each through its own temp name + rename.
 */
export async function bundleClientEntry(
  entryFile: string,
  pluginDir: string,
  /** Bare specifiers to leave as imports of a URL the page can already load, instead of inlining
   * them — see `PackageOptions.clientImportUrls` in `./bundled.ts`. */
  importUrls: Readonly<Record<string, string>> = {},
): Promise<BundleResult> {
  const outDir = join(pluginDir, ".nooklet-build");
  const result = await esbuild.build({
    entryPoints: [entryFile],
    outfile: join(outDir, "client.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    plugins: Object.keys(importUrls).length > 0 ? [urlImports(importUrls)] : [],
    alias: hostAliasMap(),
    write: false,
    logLevel: "silent",
    metafile: false,
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"));
  if (!js) throw new Error(`esbuild produced no JavaScript for client entry "${entryFile}"`);
  const hash = createHash("sha256").update(js.contents).digest("hex").slice(0, 12);
  const file = join(outDir, `client.${hash}.js`);
  if (!existsSync(file)) {
    mkdirSync(outDir, { recursive: true });
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, js.contents);
    renameSync(partial, file);
  }
  return { file, hash, warnings: result.warnings };
}

/** Resolves each exact specifier in `map` to its URL and marks it external, so `import("mermaid")`
 * is emitted as `import("/static/mermaid.core-<hash>.js")` rather than bundled. */
function urlImports(map: Readonly<Record<string, string>>): esbuild.Plugin {
  const escaped = Object.keys(map).map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  const filter = new RegExp(`^(?:${escaped.join("|")})$`);
  return {
    name: "nooklet-url-imports",
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: map[args.path] as string, external: true }));
    },
  };
}

async function hashFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * An entry that is ALREADY a bundle (`./bundled.ts`, B-180), taken as it is: no esbuild, and
 * nothing written anywhere. The same `{file, hash}` the two functions above return, so the host
 * imports and serves it the same way.
 */
export async function alreadyBundled(file: string): Promise<BundleResult> {
  return { file, hash: await hashFile(file), warnings: [] };
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
