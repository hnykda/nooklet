/**
 * The plugin host (`docs/adr/007-plugins.md`, `docs/spec/api-and-plugin-types.md` §2/§4): ties
 * discovery (`./manifest.ts`), bundling (`./bundler.ts`), and context construction
 * (`./server-context.ts`) together into "discover every plugin under a set of directories, load
 * the enabled ones, expose enable/disable/reload". Server halves load IN-PROCESS — v1 is trusted,
 * unsandboxed ESM (ADR 007); this file's job-ends are discovery/bundling/lifecycle, never a
 * security boundary.
 */
import { existsSync } from "node:fs";
import type { ServerPluginModule } from "@nooklet/plugin-api";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import type { OpRegistry, ServerConfig } from "../ops/registry.js";
import { bundleClientEntry, bundleServerEntry, importBundled } from "./bundler.js";
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
  /** `/plugins/<id>/client.<hash>.js` once the client half has been bundled at least once. */
  clientUrl?: string;
}

interface ActivePlugin {
  descriptor: PluginDescriptor;
  serverModule?: ServerPluginModule;
  tracker: DisposableTracker;
  clientBundle?: { file: string; hash: string };
}

export interface PluginHostDeps {
  serverCtx: ServerContext;
  config: ServerConfig;
  registry: OpRegistry;
  app: Hono;
  hostVersion?: string;
  /** Directories scanned for `<dir>/<name>/package.json#nooklet` plugins, in order. */
  dirs: string[];
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
    const existingDirs = this.deps.dirs.filter((d) => existsSync(d));
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
   * Bundles and (server half only) `import()`s + `activate()`s a discovered plugin. Client halves
   * are bundled for the browser but never executed here — they run in `apps/web`, which fetches
   * them from `/plugins/<id>/client.<hash>.js` (`./routes.ts`, `list()`'s `clientUrl`). A tracker
   * is created up front so a failure partway through (e.g. the server half throws inside
   * `activate()` after registering three things) still disposes whatever DID get registered,
   * rather than leaking it.
   */
  private async activate(descriptor: PluginDescriptor): Promise<void> {
    let tracker = new DisposableTracker();
    try {
      const entry: ActivePlugin = { descriptor, tracker };

      if (descriptor.serverEntry) {
        const bundle = await bundleServerEntry(descriptor.serverEntry, descriptor.dir);
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

      if (descriptor.clientEntry) {
        const bundle = await bundleClientEntry(descriptor.clientEntry, descriptor.dir);
        entry.clientBundle = { file: bundle.file, hash: bundle.hash };
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

  getClientBundle(id: string): { file: string; hash: string } | undefined {
    return this.active.get(id)?.clientBundle;
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
        clientUrl: activeEntry?.clientBundle
          ? `/plugins/${id}/client.${activeEntry.clientBundle.hash}.js`
          : undefined,
      });
    }
    return out;
  }

  get errors(): PluginDiscoveryError[] {
    return this.discoveryErrors;
  }
}
