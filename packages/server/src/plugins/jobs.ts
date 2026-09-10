/**
 * `ServerPluginContext.registerJob` (`docs/spec/api-and-plugin-types.md` §4, `JobDef`): interval
 * (`every: "15m"`) or cron (`cron: "0 3 * * *"`) scheduling, in-process (`setInterval`/`setTimeout`
 * — v1 has no separate job-runner process). Every run gets a fresh `AbortSignal` that fires when
 * the job is disposed, so a long-running `run()` can cooperatively cancel; a run already in flight
 * when the next tick arrives is skipped rather than overlapped (a plugin's job handler is not
 * assumed to be reentrant-safe).
 */
import type { JobDef, Logger } from "@nooklet/plugin-api";

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(spec: string): number {
  const m = DURATION_RE.exec(spec.trim());
  if (!m) {
    throw new Error(`invalid job interval "${spec}" (expected e.g. "30s", "15m", "1h", "1d")`);
  }
  const [, amount, unit] = m as unknown as [string, string, string];
  return Number(amount) * (DURATION_MULTIPLIERS[unit] ?? 0);
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => Number.parseInt(part, 10) === value);
}

/** Minimal 5-field cron (`minute hour day-of-month month day-of-week`): exact integers, `*`, and
 * comma lists — enough for "once a day at HH:MM" (the built-in `daily-summary` plugin's use case).
 * No step (`*​/n`) or range (`1-5`) syntax in v1; add if a real plugin needs it. */
export function cronMatchesMinute(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`invalid cron "${cron}" (expected 5 space-separated fields)`);
  }
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    cronFieldMatches(min, date.getMinutes()) &&
    cronFieldMatches(hour, date.getHours()) &&
    cronFieldMatches(dom, date.getDate()) &&
    cronFieldMatches(mon, date.getMonth() + 1) &&
    cronFieldMatches(dow, date.getDay())
  );
}

export interface ScheduledJobHandle {
  stop(): void;
}

/** Starts `job` ticking per its `every`/`cron` spec and returns a handle to stop it. Exactly one
 * of `every`/`cron` is expected (neither is also valid — the job just never fires on its own,
 * which is a legitimate way to register a job a plugin only ever runs manually... except v1 has no
 * "run now" API, so in practice a `JobDef` should set one). */
export function scheduleJob(job: JobDef, log: Logger): ScheduledJobHandle {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCronKey: string | undefined;

  const runOnce = (): void => {
    if (running || stopped) return;
    running = true;
    const controller = new AbortController();
    Promise.resolve(job.run(controller.signal))
      .catch((e: unknown) => log.error(`plugin job "${job.id}" failed:`, e))
      .finally(() => {
        running = false;
      });
  };

  if (job.runOnStart) runOnce();

  if (job.every) {
    const ms = parseDuration(job.every);
    timer = setInterval(runOnce, ms);
  } else if (job.cron) {
    // Checked once a minute; `lastCronKey` guards against firing twice inside the same minute
    // (setInterval drift, or a slow first tick landing right on a minute boundary).
    timer = setInterval(() => {
      const now = new Date();
      const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      if (key === lastCronKey) return;
      if (cronMatchesMinute(job.cron as string, now)) {
        lastCronKey = key;
        runOnce();
      }
    }, 30_000);
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
