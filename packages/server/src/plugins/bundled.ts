/**
 * Plugins shipped already bundled (B-180): what `apps/desktop/build-sidecar.mjs` puts beside the
 * sidecar's `server.mjs`, and what `PluginHostDeps.bundledDirs` loads.
 *
 * The sidecar cannot load the repo's `plugins/` the way `nooklet serve` does in development, for
 * two reasons. The loader bundles a plugin at startup, and resolves the host-provided imports
 * (`@nooklet/plugin-api`, `zod`, …) to the server's own installed copies — but a bundled server has
 * no `node_modules` to resolve them in. And it writes that bundle into the plugin's directory,
 * which in the app sits inside a code-signed bundle and is read-only when the app runs from its
 * disk image. So the bundling happens here, at build time, with the SAME two functions the loader
 * uses — what ships is exactly what the development server would have run.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  bundleClientEntry,
  bundleServerEntry,
  HOST_PROVIDED_SPECIFIERS,
  hostModuleFileName,
} from "./bundler.js";
import { discoverPlugins } from "./manifest.js";

export interface PackagedPlugin {
  id: string;
  /** Where it was written: `<outRoot>/<directory name>`. */
  dir: string;
  server: boolean;
  client: boolean;
}

/**
 * Bundles every plugin under `srcRoot` (`<srcRoot>/<name>/package.json#nooklet`) into
 * `<outRoot>/<name>/`: `server.mjs` and/or `client.js`, and a `package.json` whose manifest points
 * at them. Throws on a plugin that does not discover cleanly — a broken built-in should fail the
 * build, not ship as an `error` row.
 */
export async function packageBundledPlugins(
  srcRoot: string,
  outRoot: string,
): Promise<PackagedPlugin[]> {
  const { found, errors } = discoverPlugins([srcRoot]);
  if (errors.length > 0) {
    throw new Error(
      `built-in plugins do not discover cleanly: ${errors.map((e) => `${e.source}: ${e.message}`).join("; ")}`,
    );
  }
  const packaged: PackagedPlugin[] = [];
  for (const d of found) {
    const out = join(outRoot, basename(d.dir));
    mkdirSync(out, { recursive: true });
    const manifest = { ...d.manifest };
    if (d.serverEntry) {
      const { file } = await bundleServerEntry(d.serverEntry, d.dir);
      copyFileSync(file, join(out, "server.mjs"));
      manifest.server = "./server.mjs";
    }
    if (d.clientEntry) {
      const { file } = await bundleClientEntry(d.clientEntry, d.dir);
      copyFileSync(file, join(out, "client.js"));
      manifest.client = "./client.js";
    }
    writeFileSync(
      join(out, "package.json"),
      `${JSON.stringify({ name: `nooklet-plugin-${d.id}`, version: d.version, type: "module", nooklet: manifest }, null, 2)}\n`,
    );
    packaged.push({ id: d.id, dir: out, server: !!d.serverEntry, client: !!d.clientEntry });
  }
  return packaged;
}

/**
 * Writes each host-provided module (`HOST_PROVIDED_SPECIFIERS`: `@nooklet/plugin-api`,
 * `@nooklet/core`, `zod`, `hono`) to `<outDir>/<hostModuleFileName(spec)>` as one ESM file, for a
 * server that has no `node_modules` to resolve them in — the desktop sidecar (B-336). The loader
 * aliases a plugin's imports to these when `$NOOKLET_HOST_MODULES_DIR` names the directory
 * (`./bundler.ts#hostAliasMap`), so a plugin the user drops into `<data>/plugins` builds there the
 * way it does under `nooklet serve`.
 *
 * Each file keeps the OTHER host modules as imports rather than inlining them: the plugin's own
 * build aliases those imports to the sibling files too, so a plugin importing both
 * `@nooklet/plugin-api` and `zod` gets one copy of each, as it does in development. Resolved from
 * this package's own dependencies, i.e. the versions the server itself was built with.
 */
export async function packageHostModules(outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const serverPackageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const written: string[] = [];
  for (const spec of HOST_PROVIDED_SPECIFIERS) {
    const outfile = join(outDir, hostModuleFileName(spec));
    const build = (withDefault: boolean) =>
      esbuild.build({
        stdin: {
          contents: `export * from ${JSON.stringify(spec)};${
            withDefault ? `export { default } from ${JSON.stringify(spec)};` : ""
          }`,
          resolveDir: serverPackageDir,
          loader: "ts",
        },
        bundle: true,
        // Neither Node nor the browser: the same file serves a plugin's server half and its client
        // half, and none of the four needs a platform built-in.
        platform: "neutral",
        mainFields: ["module", "main"],
        format: "esm",
        target: "es2022",
        outfile,
        external: HOST_PROVIDED_SPECIFIERS.filter((other) => other !== spec),
        logLevel: "silent",
      });
    // `export *` never re-exports a default, and naming one a module does not have is a build
    // error, so try with it first (zod has one) and without it otherwise.
    try {
      await build(true);
    } catch {
      await build(false);
    }
    written.push(outfile);
  }
  return written;
}
