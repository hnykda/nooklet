import { describe, expect, it, vi } from "vitest";
import { cronMatchesMinute, parseDuration, scheduleJob } from "./jobs.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
    ["2d", 172_800_000],
    ["500ms", 500],
  ])("parses %s as %d ms", (spec, expected) => {
    expect(parseDuration(spec)).toBe(expected);
  });

  it("rejects an unrecognized format", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid job interval/);
  });
});

describe("cronMatchesMinute", () => {
  it("matches an exact time", () => {
    expect(cronMatchesMinute("55 23 * * *", new Date(2026, 0, 1, 23, 55))).toBe(true);
    expect(cronMatchesMinute("55 23 * * *", new Date(2026, 0, 1, 23, 54))).toBe(false);
  });

  it("supports comma lists and wildcards", () => {
    expect(cronMatchesMinute("0,30 * * * *", new Date(2026, 0, 1, 9, 30))).toBe(true);
    expect(cronMatchesMinute("0,30 * * * *", new Date(2026, 0, 1, 9, 15))).toBe(false);
  });

  it("rejects a malformed cron string", () => {
    expect(() => cronMatchesMinute("not a cron", new Date())).toThrow(/invalid cron/);
  });
});

describe("scheduleJob", () => {
  it("runs immediately when runOnStart is set", async () => {
    let calls = 0;
    const handle = scheduleJob(
      {
        id: "t",
        runOnStart: true,
        async run() {
          calls++;
        },
      },
      noopLog,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    handle.stop();
  });

  it("ticks on the configured interval and stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const handle = scheduleJob(
        {
          id: "t",
          every: "10ms",
          async run() {
            calls++;
          },
        },
        noopLog,
      );
      await vi.advanceTimersByTimeAsync(35);
      expect(calls).toBeGreaterThanOrEqual(2);
      handle.stop();
      const before = calls;
      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and swallows a run() rejection rather than crashing the scheduler", async () => {
    const errors: unknown[] = [];
    const log = { ...noopLog, error: (...a: unknown[]) => errors.push(a) };
    const handle = scheduleJob(
      {
        id: "t",
        runOnStart: true,
        async run() {
          throw new Error("job failed");
        },
      },
      log,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBeGreaterThan(0);
    handle.stop();
  });
});
