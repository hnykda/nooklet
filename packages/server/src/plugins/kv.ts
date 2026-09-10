/**
 * `ServerPluginContext.kv`: a tiny per-plugin key-value store backed by the `plugin_kv` table
 * (`../schema.ts`, added in `SCHEMA_VERSION` 2). Namespaced by `plugin_id` so one plugin can never
 * read or write another's keys — every function here takes `pluginId` and scopes every query to
 * it.
 */
import type { SqlDriver } from "@nooklet/core";
import type { Json } from "@nooklet/plugin-api";

export function kvGet<T extends Json>(driver: SqlDriver, pluginId: string, key: string): T | null {
  const row = driver.get<{ value_json: string }>(
    "SELECT value_json FROM plugin_kv WHERE plugin_id = ? AND key = ?",
    [pluginId, key],
  );
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function kvSet(driver: SqlDriver, pluginId: string, key: string, value: Json): void {
  driver.run(
    `INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [pluginId, key, JSON.stringify(value), Date.now()],
  );
}

export function kvDelete(driver: SqlDriver, pluginId: string, key: string): void {
  driver.run("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?", [pluginId, key]);
}

export function kvList(driver: SqlDriver, pluginId: string, prefix?: string): string[] {
  const rows = prefix
    ? driver.all<{ key: string }>(
        "SELECT key FROM plugin_kv WHERE plugin_id = ? AND key LIKE ? ORDER BY key",
        [pluginId, `${prefix}%`],
      )
    : driver.all<{ key: string }>("SELECT key FROM plugin_kv WHERE plugin_id = ? ORDER BY key", [
        pluginId,
      ]);
  return rows.map((r) => r.key);
}

/** Deletes every key belonging to `pluginId` — used when a plugin is fully uninstalled (not on a
 * mere disable/reload, which must keep kv/settings intact). Not currently wired to any CLI/host
 * path (v1 has no "uninstall", only enable/disable), kept here for that future call site. */
export function kvClearAll(driver: SqlDriver, pluginId: string): void {
  driver.run("DELETE FROM plugin_kv WHERE plugin_id = ?", [pluginId]);
}
