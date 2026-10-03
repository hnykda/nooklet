import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  CHECKPOINT_DEBOUNCE_MS,
  createCheckpointScheduler,
} from "./capacitor-checkpoint.js";

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips empty, small, and chunk-boundary-crossing byte arrays", () => {
    for (const size of [0, 1, 8191, 8192, 8193, 20000]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 256;
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });
});

describe("createCheckpointScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("onChange debounces — only the last call in a burst runs", async () => {
    const exportSnapshot = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const scheduler = createCheckpointScheduler(exportSnapshot);

    scheduler.onChange();
    vi.advanceTimersByTime(CHECKPOINT_DEBOUNCE_MS / 2);
    scheduler.onChange();
    vi.advanceTimersByTime(CHECKPOINT_DEBOUNCE_MS / 2);
    expect(exportSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS / 2);
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
  });

  it("onPause runs immediately, cancelling any pending debounce", async () => {
    const exportSnapshot = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const scheduler = createCheckpointScheduler(exportSnapshot);

    scheduler.onChange();
    scheduler.onPause();
    await vi.runOnlyPendingTimersAsync();
    expect(exportSnapshot).toHaveBeenCalledTimes(1);

    // The debounce onChange() scheduled must not also fire later.
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS);
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a call that arrives mid-run is not lost — it re-runs once the current run finishes", async () => {
    let resolveFirst!: (v: Uint8Array) => void;
    const exportSnapshot = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Uint8Array>((r) => (resolveFirst = r)))
      .mockResolvedValue(new Uint8Array([2]));
    const scheduler = createCheckpointScheduler(exportSnapshot);

    scheduler.onPause(); // starts the first run, which hangs on resolveFirst
    await Promise.resolve(); // let the run() function reach the await
    expect(exportSnapshot).toHaveBeenCalledTimes(1);

    scheduler.onPause(); // arrives while running — must not overlap, must queue instead
    resolveFirst(new Uint8Array([1]));
    // Let the first run finish and the queued re-run start and finish.
    await vi.waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
  });

  it("stop() prevents any further run", async () => {
    const exportSnapshot = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const scheduler = createCheckpointScheduler(exportSnapshot);
    scheduler.onChange();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS * 2);
    expect(exportSnapshot).not.toHaveBeenCalled();
  });

  it("a failed exportSnapshot() does not throw out of the scheduler", async () => {
    const exportSnapshot = vi.fn().mockRejectedValue(new Error("worker unreachable"));
    const scheduler = createCheckpointScheduler(exportSnapshot);
    scheduler.onChange();
    // If the rejection escaped uncaught, this await itself would throw and fail the test.
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS);
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
  });
});
