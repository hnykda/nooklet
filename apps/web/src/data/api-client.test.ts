/**
 * Every server op goes through `callOp` (B-330): the device token, the API origin, and failures as
 * an `ApiError` that says what happened. `apiClient` used to keep a second POST path with no
 * network wrapping, so a search or graph that could not reach the server showed only "Failed to
 * fetch" — the message `callOp`'s own doc calls unactionable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const syncTarget = vi.hoisted(() => ({ has: true }));
vi.mock("./bootstrap.js", () => ({
  apiBaseUrl: () => "http://api.test:6100",
  authToken: () => "device-token",
  hasSyncTarget: () => syncTarget.has,
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

import { ApiError, apiClient, describeError, NO_SYNC_TARGET_CODE } from "./api-client.js";
import { undoBatch } from "./refactor-api.js";

afterEach(() => {
  fetchMock.mockReset();
  syncTarget.has = true;
});

const calls = [
  ["search", () => apiClient.search({ query: "pricing" })],
  ["page.backlinks", () => apiClient.pageBacklinks("Some Page")],
  ["graph.links", () => apiClient.graphLinks()],
  ["batch.undo", () => undoBatch("batch-1")],
] as const;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("apiClient and undoBatch call the server through callOp (B-330)", () => {
  it.each(calls)("%s cannot reach the server: an ApiError naming the address", async (_, call) => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("network");
    expect(describeError(err)).toContain("http://api.test:6100");
  });

  it.each(calls)("%s posts to the API origin with the device token", async (op, call) => {
    fetchMock.mockResolvedValueOnce(
      reply({ error: { code: "unauthorized", message: "no", hint: "pair" } }, 401),
    );
    const err = await call().catch((e: unknown) => e);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`http://api.test:6100/api/v1/${op}`);
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer device-token",
    );
    // A server rejection keeps its hint.
    expect(describeError(err)).toBe("no pair");
  });
});

describe("B-577: callOp fails fast with no fetch at all when there is no sync target", () => {
  it.each(calls)("%s never calls fetch, and throws the recognizable code", async (_, call) => {
    syncTarget.has = false;
    const err = await call().catch((e: unknown) => e);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(NO_SYNC_TARGET_CODE);
  });

  it("still calls fetch normally when a sync target is configured", async () => {
    syncTarget.has = true;
    fetchMock.mockResolvedValueOnce(reply({ hits: [], mode_used: "hybrid" }));
    await apiClient.search({ query: "pricing" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("undoBatch", () => {
  it("sends History's options and maps what the undo kept", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        batch_id: "undo-1",
        kept: [{ entity_type: "block", id: "b1", page: "P", fields: ["content"] }],
      }),
    );
    const out = await undoBatch("batch-1", { keepLaterEdits: true, ignoreBatches: ["batch-0"] });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      batch_id: "batch-1",
      keep_later_edits: true,
      ignore_batches: ["batch-0"],
    });
    expect(out).toEqual({
      batchId: "undo-1",
      kept: [{ entityType: "block", id: "b1", page: "P", fields: ["content"] }],
    });
  });

  it("without options sends only the batch id", async () => {
    fetchMock.mockResolvedValueOnce(reply({ batch_id: "undo-2" }));
    expect(await undoBatch("batch-2")).toEqual({ batchId: "undo-2", kept: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      batch_id: "batch-2",
    });
  });
});
