/**
 * Per-plugin `Disposable` bookkeeping (`docs/spec/api-and-plugin-types.md` §6, rule 12): every
 * `register*`/`on`/`beforeWrite`/`ops.register` call on a `ServerPluginContext` returns a
 * `Disposable` that the HOST — never the plugin — tracks, and disposes (in reverse registration
 * order) when the plugin deactivates, reloads, or the server shuts down. `ctx.subscriptions`
 * (read-only, for introspection/tests per rule 12) is backed by the same array this class owns.
 */
import type { Disposable, Logger } from "@nooklet/plugin-api";

export class DisposableTracker {
  private items: Disposable[] = [];

  /** Wraps `d` so it is tracked, then returns it unchanged (the exact `Disposable` a `register*`
   * method should return to its caller — plugin authors never call `.dispose()` themselves). */
  track<T extends Disposable>(d: T): T {
    this.items.push(d);
    return d;
  }

  /** Read-only view backing `ctx.subscriptions`. */
  get subscriptions(): readonly Disposable[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Disposes every tracked item in REVERSE registration order (rule 12), then clears the list.
   * One handler's `dispose()` throwing must not prevent every other one from also running — each
   * failure is logged and swallowed, matching "safe mode" (rule 15's spirit applied to teardown,
   * not just startup). */
  disposeAll(log?: Logger): void {
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]?.dispose();
      } catch (e) {
        log?.error("plugin disposable threw during teardown:", e);
      }
    }
  }
}
