/**
 * `ServerPluginContext.settings`: per-plugin JSON settings persisted in the `plugin` table's
 * `settings_json` column (`../schema.ts`; that table already existed before M4 — this module is
 * the first thing to actually read/write it). `onChange` is in-process pub/sub only (no
 * cross-process notification — v1 is a single server process per graph, matching every other
 * plugin-host state in this package).
 */
import type { SqlDriver } from "@nooklet/core";
import type { Json } from "@nooklet/plugin-api";
import type { ServerContext } from "../apply-ops.js";

export type SettingsChangeListener = (next: Json, prev: Json) => void;

const listeners = new WeakMap<ServerContext, Map<string, Set<SettingsChangeListener>>>();

function listenersFor(ctx: ServerContext, pluginId: string): Set<SettingsChangeListener> {
  const byPlugin = listeners.get(ctx) ?? new Map<string, Set<SettingsChangeListener>>();
  listeners.set(ctx, byPlugin);
  const set = byPlugin.get(pluginId) ?? new Set<SettingsChangeListener>();
  byPlugin.set(pluginId, set);
  return set;
}

/** Ensures a `plugin` row exists (the loader calls this at discovery time for every plugin found
 * on disk, per `plugins/manifest.ts`), so `settingsGet`/`kv` never have to special-case "unknown
 * plugin id". Idempotent; never overwrites an existing row's `enabled`/`settings_json`. */
export function ensurePluginRow(
  driver: SqlDriver,
  pluginId: string,
  version: string,
  hlc: string,
): void {
  const now = Date.now();
  driver.run(
    `INSERT INTO plugin(id, version, enabled, settings_json, installed_at, updated_at, hlc)
     VALUES (?, ?, 1, '{}', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
    [pluginId, version, now, now, hlc],
  );
}

export function isPluginEnabled(driver: SqlDriver, pluginId: string): boolean {
  const row = driver.get<{ enabled: number }>("SELECT enabled FROM plugin WHERE id = ?", [
    pluginId,
  ]);
  return row ? row.enabled !== 0 : true; // no row yet (shouldn't happen post-ensurePluginRow): default open
}

export function setPluginEnabled(ctx: ServerContext, pluginId: string, enabled: boolean): void {
  ctx.driver.run("UPDATE plugin SET enabled = ?, updated_at = ?, hlc = ? WHERE id = ?", [
    enabled ? 1 : 0,
    Date.now(),
    ctx.hlc.next(),
    pluginId,
  ]);
}

export function settingsGet<T = Json>(driver: SqlDriver, pluginId: string): T {
  const row = driver.get<{ settings_json: string }>(
    "SELECT settings_json FROM plugin WHERE id = ?",
    [pluginId],
  );
  return (row ? JSON.parse(row.settings_json) : {}) as T;
}

/** `ServerPluginContext.settings.set`: merges `patch` into the current settings (shallow, same as
 * `Partial<T>` implies) and notifies every `onChange` listener registered for this plugin. */
export function settingsSet<T extends Json>(
  ctx: ServerContext,
  pluginId: string,
  patch: Partial<T>,
): void {
  const prev = settingsGet<Json>(ctx.driver, pluginId);
  const prevObj = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? prev : {};
  const next = { ...prevObj, ...patch } as Json;
  ctx.driver.run("UPDATE plugin SET settings_json = ?, updated_at = ?, hlc = ? WHERE id = ?", [
    JSON.stringify(next),
    Date.now(),
    ctx.hlc.next(),
    pluginId,
  ]);
  for (const l of listenersFor(ctx, pluginId)) l(next, prev);
}

export function settingsOnChange(
  ctx: ServerContext,
  pluginId: string,
  cb: SettingsChangeListener,
): () => void {
  const set = listenersFor(ctx, pluginId);
  set.add(cb);
  return () => set.delete(cb);
}
