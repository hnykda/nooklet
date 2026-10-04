import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonStallAware } from "./http-transport.js";

/** A Response whose body arrives in `parts`, each after `gapMs`, then (optionally) never ends. */
function slowResponse(parts: string[], gapMs: number, hangAfter = false): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, gapMs));
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]));
      else if (!hangAfter) controller.close();
      else await new Promise(() => {});
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

describe("fetchJsonStallAware (the first sync of a real graph was aborted mid-download)", () => {
  it("finishes a slow, steady download that takes longer than the headers bound in total", async () => {
    const parts = ['{"blocks":[', '"a",', '"b",', '"c"', "]}"];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(slowResponse(parts, 40));
    // Total ~200 ms against a 100 ms headers bound: a total deadline would have aborted this.
    const out = await fetchJsonStallAware<{ blocks: string[] }>(
      "x",
      {},
      { headersMs: 100, idleMs: 100 },
    );
    expect(out.blocks).toEqual(["a", "b", "c"]);
  });

  it("aborts a download that stalls mid-body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_i, init) => {
      const res = slowResponse(['{"a":'], 10, true);
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {});
      return Promise.resolve(res);
    });
    await expect(fetchJsonStallAware("x", {}, { headersMs: 100, idleMs: 50 })).rejects.toThrow(
      /stalled/,
    );
  });

  it("fails fast when no response arrives at all", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_i, init) =>
        new Promise((_res, rej) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => rej(signal.reason));
        }),
    );
    const started = Date.now();
    await expect(fetchJsonStallAware("x", {}, { headersMs: 50, idleMs: 1000 })).rejects.toThrow(
      /no response/,
    );
    expect(Date.now() - started).toBeLessThan(500);
  });
});
