/**
 * The web side of ADR 033's native capture queue: the `NookletCapture` Capacitor plugin
 * (`ios/App/App/CaptureQueuePlugin.swift`, registered by `AppViewController.swift`) exposes the
 * queue folder as list / read / remove, and `capture-queue.ts` drains it through the ordinary
 * quick-capture write.
 *
 * Only ever called in the iOS app (`platform.name === "capacitor"`). `@capacitor/core` is imported
 * lazily for the same reason `../platform/capacitor.ts` imports every plugin lazily: the web/PWA
 * bundle never fetches it. On Android, and on an iOS build older than this plugin, the plugin is
 * not there and the drain reports that once and does nothing.
 */
import { queryAs } from "../db/client.js";
import { type CaptureQueueDeps, type DrainReport, drainCaptureQueue } from "./capture-queue.js";
import { submitQuickCapture } from "./quickCaptureService.js";

interface NookletCapturePlugin {
  list(): Promise<{ ids: string[] }>;
  read(options: { id: string }): Promise<{ json: string }>;
  remove(options: { id: string }): Promise<void>;
}

let pluginPromise: Promise<NookletCapturePlugin | undefined> | undefined;

function plugin(): Promise<NookletCapturePlugin | undefined> {
  if (!pluginPromise) {
    pluginPromise = import("@capacitor/core").then(({ Capacitor, registerPlugin }) =>
      Capacitor.isPluginAvailable("NookletCapture")
        ? registerPlugin<NookletCapturePlugin>("NookletCapture")
        : undefined,
    );
  }
  return pluginPromise;
}

function nativeDeps(p: NookletCapturePlugin): CaptureQueueDeps {
  return {
    list: async () => (await p.list()).ids,
    read: async (id) => (await p.read({ id })).json,
    remove: (id) => p.remove({ id }),
    async blockExists(blockId) {
      // Deliberately no `deleted_at IS NULL`: a queued capture the person has since deleted must
      // stay deleted, not reappear because its file outlived the write.
      const rows = await queryAs<{ x: number }>("SELECT 1 AS x FROM block WHERE id = ? LIMIT 1", [
        blockId,
      ]);
      return rows.length > 0;
    },
    async write(text, opts) {
      const r = await submitQuickCapture(text, undefined, opts);
      return r === null ? null : { rejected: r.rejected };
    },
  };
}

/** Drains the native queue once (joining a drain already running). Resolves `undefined` where
 * there is no native queue. Never throws: a failed drain leaves every file for the next one. */
export async function drainNativeCaptureQueue(): Promise<DrainReport | undefined> {
  try {
    const p = await plugin();
    if (!p) return undefined;
    const report = await drainCaptureQueue(nativeDeps(p));
    if (report.failed.length > 0 || report.malformed.length > 0) {
      console.warn("[capture-queue] left queued", {
        failed: report.failed,
        malformed: report.malformed,
      });
    }
    return report;
  } catch (err) {
    console.warn("[capture-queue] drain failed; files stay queued", err);
    return undefined;
  }
}
