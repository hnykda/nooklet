import { LIVE_CLOSE } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import {
  createLiveRetry,
  LIVE_REFUSED_BASE_MS,
  LIVE_REFUSED_MAX_MS,
  LIVE_RETRY_BASE_MS,
  LIVE_RETRY_MAX_MS,
  STABLE_MS,
} from "./live-backoff.js";

/** A retry policy on a fake clock with no jitter (random() = 0.5 -> factor 1). */
function fake() {
  let t = 0;
  const retry = createLiveRetry({ now: () => t, random: () => 0.5 });
  return {
    retry,
    advance: (ms: number) => {
      t += ms;
    },
    /** Open, stay open `openMs`, close with `code`; the delay it chose. */
    cycle(code: number, openMs = 20) {
      retry.onOpen();
      t += openMs;
      return retry.onClose(code);
    },
  };
}

describe("live socket reconnect policy (B-676 H4)", () => {
  it("a token refusal (4401/4403) stops reconnecting", () => {
    expect(fake().cycle(LIVE_CLOSE.forbidden)).toBeNull();
    expect(fake().cycle(LIVE_CLOSE.revoked)).toBeNull();
  });

  it("B-713: a retired graph (4410) stops reconnecting", () => {
    expect(fake().cycle(LIVE_CLOSE.graphRetired)).toBeNull();
  });

  it("a capacity refusal that opens and closes at once does NOT reconnect every second", () => {
    // The bug this replaces: `open` reset the delay to 1 s, so a server accepting and then
    // refusing every socket was retried once a second, forever.
    const f = fake();
    const delays = Array.from({ length: 6 }, () => f.cycle(LIVE_CLOSE.overCapacity));
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(Math.min(...(delays as number[]))).toBeGreaterThanOrEqual(LIVE_REFUSED_BASE_MS);
    expect(Math.max(...(delays as number[]))).toBe(LIVE_REFUSED_MAX_MS);
  });

  it("a frame-too-big close (1009) backs off the same way", () => {
    const f = fake();
    expect(f.cycle(LIVE_CLOSE.tooBig)).toBe(30_000);
    expect(f.cycle(LIVE_CLOSE.tooBig)).toBe(60_000);
  });

  it("capacity refusals are jittered ±20% so refused clients do not return in lockstep", () => {
    const lo = createLiveRetry({ random: () => 0 }).onClose(LIVE_CLOSE.overCapacity);
    const hi = createLiveRetry({ random: () => 0.999999 }).onClose(LIVE_CLOSE.overCapacity);
    expect(lo).toBe(24_000);
    expect(hi).toBeCloseTo(36_000, -1);
  });

  it("network drops keep the old 1 s doubling to 30 s, and a hello timeout (4408) counts as one", () => {
    const f = fake();
    const delays = [1006, 1006, 4408, 1001, 1006, 1006, 1006].map((c) => f.cycle(c));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(delays.at(-1)).toBe(LIVE_RETRY_MAX_MS);
  });

  it("a socket that failed to open at all (no onOpen) still backs off", () => {
    const { retry } = fake();
    expect([retry.onClose(1006), retry.onClose(1006), retry.onClose(1006)]).toEqual([
      1000, 2000, 4000,
    ]);
  });

  it("a socket that stayed open past STABLE_MS resets both delays; a brief open does not", () => {
    const f = fake();
    f.cycle(LIVE_CLOSE.overCapacity);
    f.cycle(LIVE_CLOSE.overCapacity);
    f.cycle(1006);
    f.cycle(1006);
    // Open longer than the server's hello timeout: it was accepted, and later dropped.
    expect(f.cycle(1006, STABLE_MS)).toBe(LIVE_RETRY_BASE_MS);
    expect(f.cycle(LIVE_CLOSE.overCapacity)).toBe(LIVE_REFUSED_BASE_MS);
    // Brief opens never reset.
    expect(f.cycle(LIVE_CLOSE.overCapacity, STABLE_MS - 1)).toBe(2 * LIVE_REFUSED_BASE_MS);
  });
});
