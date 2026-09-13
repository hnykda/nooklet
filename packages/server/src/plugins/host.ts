/**
 * The plugin host (`docs/adr/007-plugins.md`, `docs/spec/api-and-plugin-types.md` §2/§4): ties
 * discovery (`./manifest.ts`), bundling (`./bundler.ts`), and context construction
 * (`./server-context.ts`) together into "discover every plugin under a set of directories, load
 * the enabled ones, expose enable/disable/reload". Server halves load IN-PROCESS — v1 is trusted,
 * unsandboxed ESM (ADR 007); this file's job-ends are discovery/bundling/lifecycle, never a
 * security boundary.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ServerPluginModule } from "@nooklet/plugin-api";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import type { OpRegistry, ServerConfig } from "../ops/registry.js";
import { alreadyBundled, bundleClientEntry, bundleServerEntry, importBundled } from "./bundler.js";
import { DisposableTracker } from "./disposables.js";
import { discoverPlugins, type PluginDescriptor, type PluginDiscoveryError } from "./manifest.js";
import { createPluginServerContext } from "./server-context.js";
import { ensurePluginRow, isPluginEnabled, setPluginEnabled } from "./settings.js";

export type PluginStatus = "active" | "disabled" | "error";

export interface LoadedPluginInfo {
  id: string;
  name: string;
  version: string;
  api: string;
  status: PluginStatus;
  error?: string;
  hasServer: boolean;
  hasClient: boolean;
  /** `/plugins/<id>/client.<hash>.js` once the client half has been bundled at least once
   * (`PluginHost.clientBundle` / `ensureClientBundles`). */
  clientUrl?: string;
}

interface ActivePlugin {
  descriptor: PluginDescriptor;
  serverModule?: ServerPluginModule;
  tracker: DisposableTracker;
  /** Built on first request, see `PluginHost.clientBundle`. */
  clientBundle?: Promise<{ file: string; hash: string }>;
  clientBundleReady?: { file: string; hash: string };
}

export interface PluginHostDeps {
  serverCtx: ServerContext;
  config: ServerConfig;
  registry: OpRegistry;
  app: Hono;
  hostVersion?: string;
  /** Directories scanned for `<dir>/<name>/package.json#nooklet` plugins, in order. */
  dirs: string[];
  /**
   * Scanned after `dirs`: plugins whose `server`/`client` entries are ALREADY bundles
   * (`./bundled.ts`) — the desktop sidecar's built-ins (B-180). Imported and served as they are:
   * no esbuild, and nothing written into the directory, which there sits inside a code-signed app
   * and is read-only when the app runs from its disk image. An entry here that is not a bundle
   * fails to import, and the plugin shows as `error`.
   */
  bundledDirs?: string[];
}

export class PluginHost {
  private readonly deps: PluginHostDeps;
  private readonly descriptors = new Map<string, PluginDescriptor>();
  private readonly active = new Map<string, ActivePlugin>();
  private readonly errored = new Map<string, string>();
  private discoveryErrors: PluginDiscoveryError[] = [];

  constructor(deps: PluginHostDeps) {
    this.deps = deps;
  }

  /** Whether `descriptor` was found in one of `deps.bundledDirs`. */
  private isBundled(descriptor: PluginDescriptor): boolean {
    const root = resolve(dirname(descriptor.dir));
    return (this.deps.bundledDirs ?? []).some((d) => resolve(d) === root);
  }

  private get log() {
    return {
      info: (...a: unknown[]) => console.info("[plugins]", ...a),
      warn: (...a: unknown[]) => console.warn("[plugins]", ...a),
      error: (...a: unknown[]) => console.error("[plugins]", ...a),
    };
  }

  /** Discovers every plugin under `deps.dirs` and activates the enabled ones. A single plugin
   * failing (invalid manifest, unsupported `api`, a throwing `activate()`) is recorded as `error`
   * and never aborts discovery or any other plugin's activation (ADR 007 / rule 15's "safe mode"
   * behavior, applied to the whole load path, not only the api-version check it names). */
  async loadAll(): Promise<void> {
    const existingDirs = [...this.deps.dirs, ...(this.deps.bundledDirs ?? [])].filter((d) =>
      existsSync(d),
    );
    const { found, errors } = discoverPlugins(existingDirs);
    this.discoveryErrors = errors;
    for (const e of errors) this.log.warn(`plugin discovery error at ${e.source}: ${e.message}`);

    for (const descriptor of found) {
      this.descriptors.set(descriptor.id, descriptor);
      ensurePluginRow(
        this.deps.serverCtx.driver,
        descriptor.id,
        descriptor.version,
        this.deps.serverCtx.hlc.next(),
      );
      if (!isPluginEnabled(this.deps.serverCtx.driver, descriptor.id)) continue;
      await this.activate(descriptor);
    }
  }

  /**
   * Bundles, `import()`s and `activate()`s a discovered plugin's server half. Client halves are
   * never executed here, and not bundled here either — see `clientBundle()`. A tracker is created
   * up front so a failure partway through (e.g. the server half throws inside `activate()` after
   * registering three things) still disposes whatever DID get registered, rather than leaking it.
   */
  private async activate(descriptor: PluginDescriptor): Promise<void> {
    let tracker = new DisposableTracker();
    try {
      const entry: ActivePlugin = { descriptor, tracker };

      if (descriptor.serverEntry) {
        const bundle = this.isBundled(descriptor)
          ? await alreadyBundled(descriptor.serverEntry)
          : await bundleServerEntry(descriptor.serverEntry, descriptor.dir);
        const mod = (await importBundled(bundle.file, bundle.hash)) as
          | ServerPluginModule
          | undefined;
        if (!mod || typeof mod.activate !== "function") {
          throw new Error(
            `server entry "${descriptor.serverEntry}" has no default export with activate()`,
          );
        }
        const built = createPluginServerContext(
          {
            serverCtx: this.deps.serverCtx,
            config: this.deps.config,
            registry: this.deps.registry,
            app: this.deps.app,
            hostVersion: this.deps.hostVersion ?? "0.0.1",
          },
          {
            id: descriptor.id,
            version: descriptor.version,
            dir: descriptor.dir,
            permissions: descriptor.manifest.permissions ?? [],
          },
        );
        tracker = built.tracker; // the tracker createPluginServerContext's register* calls actually push to
        entry.tracker = tracker;
        await mod.activate(built.ctx);
        entry.serverModule = mod;
      }

      this.active.set(descriptor.id, entry);
      this.errored.delete(descriptor.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.errored.set(descriptor.id, message);
      this.log.error(`plugin "${descriptor.id}" failed to activate:`, message);
      tracker.disposeAll();
    }
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.tracker.disposeAll();
    try {
      await entry.serverModule?.deactivate?.();
    } catch (e) {
      this.log.error(`plugin "${id}" deactivate() threw:`, e);
    }
    this.active.delete(id);
  }

  async disable(id: string): Promise<void> {
    setPluginEnabled(this.deps.serverCtx, id, false);
    await this.deactivate(id);
  }

  async enable(id: string): Promise<void> {
    setPluginEnabled(this.deps.serverCtx, id, true);
    const descriptor = this.descriptors.get(id);
    if (descriptor && !this.active.has(id)) await this.activate(descriptor);
  }

  async reload(id: string): Promise<void> {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) throw new Error(`no such plugin "${id}"`);
    await this.deactivate(id);
    await this.activate(descriptor);
  }

  /**
   * An active plugin's client half bundled for the browser — built on first request, then cached
   * until the plugin deactivates or reloads. `undefined` when the plugin is not active or has no
   * client half; rejects when esbuild does, and keeps rejecting until a reload: the URL that asks
   * for it is unauthenticated, and forgetting a failure let every request run esbuild again
   * (B-186). `nooklet plugin reload` activates a fresh entry, which bundles afresh.
   *
   * Not built at activation any more. The web app compiles the built-in client halves into its own
   * build (ADR 023) and requests none of these, while a client half may bundle a real library:
   * mermaid made this 12 MB and ~0.6 s of esbuild on every server start, before the first request
   * was answered (`tools/probes/mermaid-client-bundle-cost.mjs`; much more on a busy machine).
   */
  clientBundle(id: string): Promise<{ file: string; hash: string } | undefined> {
    const entry = this.active.get(id);
    const entryFile = entry?.descriptor.clientEntry;
    if (!entry || !entryFile) return Promise.resolve(undefined);
    entry.clientBundle ??= (
      this.isBundled(entry.descriptor)
        ? alreadyBundled(entryFile)
        : bundleClientEntry(entryFile, entry.descriptor.dir)
    ).then(
      ({ file, hash }) => {
        entry.clientBundleReady = { file, hash };
        return entry.clientBundleReady;
      },
      (e: unknown) => {
        this.log.error(`plugin "${id}" client half failed to bundle:`, e);
        throw e;
      },
    );
    return entry.clientBundle;
  }

  /** Bundles every active client half — what `GET /api/v1/plugins` awaits so its `client_url`s
   * are filled in. One failing leaves only that plugin's URL out. */
  async ensureClientBundles(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map((id) => this.clientBundle(id)));
  }

  list(): LoadedPluginInfo[] {
    const out: LoadedPluginInfo[] = [];
    for (const [id, descriptor] of this.descriptors) {
      const activeEntry = this.active.get(id);
      const enabled = isPluginEnabled(this.deps.serverCtx.driver, id);
      const error = this.errored.get(id);
      out.push({
        id,
        name: descriptor.manifest.name ?? id,
        version: descriptor.version,
        api: descriptor.manifest.api,
        status: error ? "error" : enabled ? "active" : "disabled",
        error,
        hasServer: Boolean(descriptor.serverEntry),
        hasClient: Boolean(descriptor.clientEntry),
        clientUrl: activeEntry?.clientBundleReady
          ? `/plugins/${id}/client.${activeEntry.clientBundleReady.hash}.js`
          : undefined,
      });
    }
    return out;
  }

  get errors(): PluginDiscoveryError[] {
    return this.discoveryErrors;
  }
}
