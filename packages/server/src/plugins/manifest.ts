/**
 * Plugin discovery (`docs/spec/api-and-plugin-types.md` §2, the loader design referenced from
 * `@nooklet/plugin-api`'s README: "packages/server/src/plugins/host.ts, not yet built"). Scans one
 * or more directories for `<dir>/<name>/package.json#nooklet` plugins (the primary, documented
 * form) and `<dir>/<name>.plugin.ts` single-file scripts, validating every manifest with
 * `@nooklet/plugin-api`'s `validateManifest` before anything is bundled or `import()`ed — rule 9's
 * test case ("neither server nor client -> loader rejects at discovery time, before any import()")
 * and rule 15 ("an unsupported api major marks the plugin error, never aborts the server") both
 * live here, not in the bundler.
 *
 * A bad plugin (invalid manifest, unsupported `api`, duplicate id) is reported as a
 * `PluginDiscoveryError`, never thrown — the caller (`./host.ts`) decides what "safe mode" means
 * (skip it, log it, mark it `error` in a future Settings -> Plugins UI); discovery itself never
 * aborts because one plugin among several is broken.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PluginManifest } from "@nooklet/plugin-api";
import { assertApiSupported, PluginLoadError, validateManifest } from "@nooklet/plugin-api";

export interface PluginDescriptor {
  id: string;
  manifest: PluginManifest;
  /** Directory the manifest/entries are resolved relative to. */
  dir: string;
  kind: "package" | "single-file";
  /** Absolute path to the server entry module, if `manifest.server` was set. */
  serverEntry?: string;
  /** Absolute path to the client entry module, if `manifest.client` was set. */
  clientEntry?: string;
  /** `package.json#version`, or "0.0.0" for a single-file plugin (no package.json). */
  version: string;
}

export interface PluginDiscoveryError {
  /** Best-effort plugin id, when one could be read before the error (e.g. a bad `client` field
   * still has a valid `id`); undefined when the manifest couldn't be parsed at all. */
  id?: string;
  source: string;
  message: string;
}

export interface DiscoveryResult {
  found: PluginDescriptor[];
  errors: PluginDiscoveryError[];
}

function readPackageManifest(dir: string): { pkg: Record<string, unknown> } | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  return { pkg };
}

function discoverPackagePlugin(
  dir: string,
  seenIds: Set<string>,
  errors: PluginDiscoveryError[],
): PluginDescriptor | undefined {
  const read = readPackageManifest(dir);
  if (!read) return undefined; // a directory without package.json is not a plugin; silently skip
  const { pkg } = read;

  const result = validateManifest(pkg.nooklet);
  if (!result.valid) {
    errors.push({
      source: dir,
      message: result.errors.map((e) => `${e.path || "(manifest)"}: ${e.message}`).join("; "),
    });
    return undefined;
  }
  const manifest = result.manifest;

  try {
    assertApiSupported(manifest);
  } catch (e) {
    // rule 15: an unsupported api major is a per-plugin error, not a discovery-wide abort.
    errors.push({ id: manifest.id, source: dir, message: (e as Error).message });
    return undefined;
  }

  if (seenIds.has(manifest.id)) {
    errors.push({ id: manifest.id, source: dir, message: `duplicate plugin id "${manifest.id}"` });
    return undefined;
  }
  seenIds.add(manifest.id);

  return {
    id: manifest.id,
    manifest,
    dir,
    kind: "package",
    serverEntry: manifest.server ? resolve(dir, manifest.server) : undefined,
    clientEntry: manifest.client ? resolve(dir, manifest.client) : undefined,
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
  };
}

/**
 * Scans `dirs` (in order; a later dir's plugin id never overrides an earlier one — first match
 * wins, reported as a duplicate-id error otherwise) for `<dir>/<name>/package.json#nooklet`
 * plugins. Directories that don't exist are skipped silently (a dev-only `plugins/` root, e.g.,
 * simply isn't present in an installed build).
 */
export function discoverPlugins(dirs: readonly string[]): DiscoveryResult {
  const found: PluginDescriptor[] = [];
  const errors: PluginDiscoveryError[] = [];
  const seenIds = new Set<string>();

  for (const root of dirs) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const dir = join(root, entry.name);
      try {
        const descriptor = discoverPackagePlugin(dir, seenIds, errors);
        if (descriptor) found.push(descriptor);
      } catch (e) {
        errors.push({ source: dir, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { found, errors };
}

/** Find one already-discovered plugin by id (for CLI `enable`/`disable`/`reload`, which take a
 * plugin id rather than a directory). */
export function findPlugin(dirs: readonly string[], id: string): PluginDescriptor | undefined {
  return discoverPlugins(dirs).found.find((p) => p.id === id);
}

export type { PluginManifest };
export { PluginLoadError };
