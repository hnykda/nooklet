/**
 * `nooklet.api` compatibility (`docs/spec/api-and-plugin-types.md` §Versioning).
 *
 * `nooklet.api` is a string MAJOR (`"1"` in v1, and the only value this whole package's types
 * accept for `PluginManifest["api"]`). Within API 1.x, `@nooklet/plugin-api` changes are
 * additive-only: new optional fields, new `register*` methods, new event names — nothing that
 * type-checks against API 1.0 may stop type-checking against a later 1.x. A DEPRECATED member
 * must keep working for at least one minor release and must log a warning (`ctx.log.warn`, once
 * per plugin per process) when used.
 *
 * A BREAKING change (removing/renaming a field, an incompatible `register*` signature change, a
 * changed default `expose` semantics) ships as `api: "2"`. When that happens, the host runs TWO
 * context factories side by side (`createServerContextV1`/`V2`, `createClientContextV1`/`V2`)
 * over the same underlying registries and services, so `"1"` and `"2"` plugins load
 * simultaneously; `"1"` support is dropped only after a published deprecation window (at minimum
 * one minor host release with both loaders active and a startup warning on every `"1"` plugin
 * naming the removal release). `SUPPORTED_API_MAJORS`/`isApiSupported` below would grow a second
 * entry (`"2"`) at that point — this module, not `manifest.ts`, is where that change lands.
 *
 * The manifest's `api` field itself stays typed as the literal `"1"` (`manifest.ts`) so
 * *authored* plugins can't typo a version; `assertApiSupported` takes a widened `string` because
 * the host calls it on untrusted, already-parsed JSON where `api` might be anything.
 */
export type ApiMajor = "1";

export const SUPPORTED_API_MAJORS: ReadonlySet<string> = new Set<ApiMajor>(["1"]);

export function isApiSupported(api: string): boolean {
  return SUPPORTED_API_MAJORS.has(api);
}

export class PluginLoadError extends Error {}

/**
 * The host calls this before `activate()`. A load failure here marks the plugin `error` in
 * Settings -> Plugins (with this message) and MUST NOT abort server startup or other plugins
 * (rule 15, Home Assistant "safe mode" behavior) — the host should catch `PluginLoadError`, not
 * let it propagate.
 */
export function assertApiSupported(manifest: { id: string; api: string }): void {
  if (!isApiSupported(manifest.api)) {
    throw new PluginLoadError(
      `plugin "${manifest.id}" targets nooklet plugin api "${manifest.api}"; this host supports: ${[...SUPPORTED_API_MAJORS].join(", ")}`,
    );
  }
}
