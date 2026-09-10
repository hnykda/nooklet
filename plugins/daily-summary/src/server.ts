/**
 * `daily-summary`'s server half (M4 built-in #3): a scheduled job that appends a short block-count
 * summary to today's journal, demonstrating `registerJob` + `ctx.data` + `ctx.kv`.
 *
 * **Opt-in, disabled by default** (the task's explicit requirement — "so it never surprises
 * anyone"): `activate()` reads its own `ctx.settings` (persisted in the `plugin` table, namespaced
 * by this plugin's id — see its `package.json#nooklet.settings` JSON Schema) and registers nothing
 * at all unless `{ enabled: true }` has been set. Toggling it back on takes effect on the next
 * `nooklet plugin reload daily-summary` (or server restart) — v1 has no live settings-driven
 * re-registration, matching every other plugin here.
 *
 * `ctx.kv` guards against writing more than one summary per journal day even if the host restarts
 * (and re-registers the job) more than once in the same day — `registerJob`'s `cron` alone doesn't
 * protect against that, since a restart re-arms the schedule from scratch.
 */
import type {
  BlockNode,
  DataApi,
  ServerPluginContext,
  ServerPluginModule,
} from "@nooklet/plugin-api";

interface Settings {
  enabled?: boolean;
}

/** Exported for direct testing: the actual "count today's blocks and write a summary" logic,
 * independent of `registerJob`'s scheduling — a test can call this against a real `ctx.data`
 * without waiting for a cron tick. */
export async function runDailySummary(
  data: DataApi,
  kv: ServerPluginContext["kv"],
  log: ServerPluginContext["log"],
): Promise<{ wrote: boolean; blockCount: number }> {
  const today = await data.pages.journal("today", { create: true });
  if (!today) return { wrote: false, blockCount: 0 };

  const kvKey = `summarized:${today.name}`;
  if (await kv.get<string>(kvKey)) {
    log.debug(`daily-summary: already summarized ${today.name}, skipping`);
    return { wrote: false, blockCount: 0 };
  }

  const tree = await data.blocks.tree({ page: today.id });
  let blockCount = 0;
  const walk = (nodes: BlockNode[]): void => {
    for (const n of nodes) {
      blockCount++;
      walk(n.children);
    }
  };
  walk(tree);

  const summary = `Daily summary: ${blockCount} block${blockCount === 1 ? "" : "s"} logged today.`;
  await data.blocks.insert({ page: today.id, content: summary, after: "last" });
  await kv.set(kvKey, new Date().toISOString());
  return { wrote: true, blockCount };
}

export default {
  async activate(ctx) {
    const settings = ctx.settings.get<Settings>();
    if (!settings.enabled) {
      ctx.log.info(
        'daily-summary is disabled by default. Enable it via ctx.settings ({ "enabled": true }) ' +
          "and reload the plugin to schedule the job.",
      );
      return;
    }

    ctx.registerJob({
      id: "daily-summary",
      // 23:55 local time, every day (minimal 5-field cron: minute hour day month weekday).
      cron: "55 23 * * *",
      runOnStart: false,
      async run(signal) {
        if (signal.aborted) return;
        const result = await runDailySummary(ctx.data, ctx.kv, ctx.log);
        if (result.wrote)
          ctx.log.info(`daily-summary: wrote summary (${result.blockCount} blocks)`);
      },
    });
  },
} satisfies ServerPluginModule;
