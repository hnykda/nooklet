/**
 * `docs/spec/api-and-plugin-types.md` §6. Every `register*`/`on`/`beforeWrite`/`ops.register` call
 * on a `ServerPluginContext`/`ClientPluginContext` returns one of these. The host — never the
 * plugin — pushes it onto that plugin's private list (read-only introspection via
 * `ctx.subscriptions`) and calls `dispose()` on every entry, in reverse registration order, when
 * the plugin deactivates, hot-reloads, or the server shuts down. This is Obsidian's
 * `Component`/`register()` pattern made fully automatic: a plugin that only ever used
 * `register*`/`on` needs no `deactivate()` of its own at all.
 */
export interface Disposable {
  dispose(): void;
}
