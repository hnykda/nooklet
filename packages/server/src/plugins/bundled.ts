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
import { basename, join } from "node:path";
import { bundleClientEntry, bundleServerEntry } from "./bundler.js";
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
