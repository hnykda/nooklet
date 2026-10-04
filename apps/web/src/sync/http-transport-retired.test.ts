/**
 * B-713: after `DELETE /graphs/<id>` the server answers every `/g/<id>/...` request with a 404 whose
 * body is its own `{"error":{"code":"not_found","message":"No graph \"<id>\" on this server"}}`
 * (`packages/server/src/graphs/mount.ts`). A reloaded page has no live socket to receive 4410, so
 * that 404 is how its sync learns the graph was retired. Any other 404 (a proxy, a wrong path)
 * stays a plain failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTransport, fetchJsonStallAware } from "./http-transport.js";
import { isSyncGraphRetiredError } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const noGraph = () =>
  Response.json(
    { error: { code: "not_found", message: 'No graph "work" on this server' } },
    { status: 404 },
  );

describe("a retired graph's 404 (B-713)", () => {
  it("pull and snapshot reject with SyncGraphRetiredError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(noGraph()));
    const err = await fetchJsonStallAware("x", {}).catch((e: unknown) => e);
    expect(isSyncGraphRetiredError(err)).toBe(true);
    const t = createHttpTransport({ baseUrl: "http://127.0.0.1:1/g/work" });
    expect(isSyncGraphRetiredError(await t.snapshot().catch((e: unknown) => e))).toBe(true);
  });

  it("push rejects with SyncGraphRetiredError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(noGraph()));
    const t = createHttpTransport({ baseUrl: "http://127.0.0.1:1/g/work" });
    const err = await t.push({ device_id: "d", ops: [] }).catch((e: unknown) => e);
    expect(isSyncGraphRetiredError(err)).toBe(true);
  });

  it("any other 404 is a plain failure, not 'retired'", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("not here", { status: 404 })),
    );
    const err = await fetchJsonStallAware("x", {}).catch((e: unknown) => e);
    expect(isSyncGraphRetiredError(err)).toBe(false);
    expect(String(err)).toMatch(/404/);
  });
});
