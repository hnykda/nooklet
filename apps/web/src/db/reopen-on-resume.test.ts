import { describe, expect, it, vi } from "vitest";
import { createResumeRetry } from "./reopen-on-resume.js";

describe("createResumeRetry", () => {
  it("passes calls straight through when nothing fails", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn();
    const retry = createResumeRetry(open, reopen);

    const result = await retry.call((v) => v.n * 2);

    expect(result).toBe(2);
    expect(reopen).not.toHaveBeenCalled();
  });

  it("propagates a failure when no resume has fired", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn();
    const retry = createResumeRetry(open, reopen);

    await expect(
      retry.call(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(reopen).not.toHaveBeenCalled();
  });

  it("after onResume(), reopens once and retries a failing call", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 2 });
    const retry = createResumeRetry(open, reopen);
    retry.onResume();

    let calls = 0;
    const result = await retry.call((v) => {
      calls++;
      if (calls === 1) throw new Error("stale connection");
      return v.n;
    });

    expect(result).toBe(2);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("disarms after one retry — a second failure right after reopening propagates", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 2 });
    const retry = createResumeRetry(open, reopen);
    retry.onResume();

    await expect(
      retry.call(() => {
        throw new Error("still broken");
      }),
    ).rejects.toThrow("still broken");
    expect(reopen).toHaveBeenCalledTimes(1);

    // A further failure, with the arm already spent, must not reopen again.
    await expect(
      retry.call(() => {
        throw new Error("broken again");
      }),
    ).rejects.toThrow("broken again");
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("catches an async rejection from fn, not just a synchronous throw", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 2 });
    const retry = createResumeRetry(open, reopen);
    retry.onResume();

    let calls = 0;
    const result = await retry.call(async (v) => {
      calls++;
      if (calls === 1) throw new Error("async stale connection");
      return v.n;
    });

    expect(result).toBe(2);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("a successful call after resume disarms it — a later unrelated failure does not reopen", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 2 });
    const retry = createResumeRetry(open, reopen);
    retry.onResume();

    // Succeeds without needing a retry — should disarm, not leave the arm live indefinitely.
    await expect(retry.call((v) => v.n)).resolves.toBe(1);
    expect(reopen).not.toHaveBeenCalled();

    // A later, unrelated failure — with no resume in between — must propagate, not reopen.
    await expect(
      retry.call(() => {
        throw new Error("unrelated bug");
      }),
    ).rejects.toThrow("unrelated bug");
    expect(reopen).not.toHaveBeenCalled();
  });

  it("current() resolves the live value, updated after a reopen", async () => {
    const open = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 1 });
    const reopen = vi.fn<() => Promise<{ n: number }>>().mockResolvedValue({ n: 2 });
    const retry = createResumeRetry(open, reopen);
    expect(await retry.current()).toEqual({ n: 1 });

    retry.onResume();
    await retry
      .call(() => {
        throw new Error("boom");
      })
      .catch(() => {});
    expect(await retry.current()).toEqual({ n: 2 });
  });
});
