/**
 * Local-first search, then enrich (server-search): the merge of the server's answer into the
 * device's hits, the bound on how long the server is waited for, and the line that says which side
 * answered.
 */
import { describe, expect, it } from "vitest";
import { ApiError, type SearchHit, type SearchResult } from "./api-client.js";
import { askServer, mergeHits, searchSourceLine, stabilizeHits } from "./search-enrich.js";

function hit(id: string, page = "P", kind: "block" | "page" = "block"): SearchHit {
  return {
    kind,
    id,
    page,
    snippet: `snippet ${id}`,
    breadcrumb: [],
    score: 0.5,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const ids = (hits: readonly { id: string }[]) => hits.map((h) => h.id);

describe("mergeHits", () => {
  const local = [hit("a"), hit("b")];

  it("with no server answer, is the device's hits, none semantic, all openable", () => {
    const out = mergeHits(local, undefined, new Map(), true);
    expect(ids(out)).toEqual(["a", "b"]);
    expect(out.every((h) => !h.semantic && h.onDevice)).toBe(true);
  });

  it("adopting the server's order: its ranking first, then hits only the device found", () => {
    const server = [hit("x"), hit("b"), hit("y")];
    const presence = new Map([
      ["block:x", "live" as const],
      ["block:y", "live" as const],
    ]);
    const out = mergeHits(local, server, presence, true);
    expect(ids(out)).toEqual(["x", "b", "y", "a"]);
    expect(out.find((h) => h.id === "x")?.semantic).toBe(true);
    // Found by keyword on the device too: not "semantic", and the device's snippet wins.
    expect(out.find((h) => h.id === "b")).toMatchObject({ semantic: false, snippet: "snippet b" });
  });

  it("keeping the device's order: its rows stay where they are, additions go below", () => {
    const server = [hit("x"), hit("b"), hit("y")];
    const presence = new Map([
      ["block:x", "live" as const],
      ["block:y", "live" as const],
    ]);
    expect(ids(mergeHits(local, server, presence, false))).toEqual(["a", "b", "x", "y"]);
  });

  it("a server hit the device has deleted is dropped; one it lacks is kept, not openable", () => {
    const server = [hit("gone"), hit("unsynced")];
    const out = mergeHits([], server, new Map([["block:gone", "deleted" as const]]), true);
    expect(ids(out)).toEqual(["unsynced"]);
    expect(out[0]).toMatchObject({ semantic: true, onDevice: false });
  });

  it("a page and a block with the same id are different hits; a repeated hit is shown once", () => {
    const server = [hit("same", "P", "page"), hit("same"), hit("same")];
    const presence = new Map([["page:same", "live" as const]]);
    const out = mergeHits([hit("same")], server, presence, true);
    expect(out.map((h) => `${h.kind}:${h.id}`)).toEqual(["page:same", "block:same"]);
  });
});

describe("stabilizeHits", () => {
  it("reuses the previous object for an unchanged hit, so its row (and focus) survives", () => {
    const first = mergeHits([hit("a"), hit("b")], undefined, new Map(), true);
    const changed = { ...hit("b"), snippet: "new text" };
    const second = mergeHits([hit("a"), changed], undefined, new Map(), true);
    const out = stabilizeHits(first, second);
    expect(out[0]).toBe(first[0]);
    expect(out[1]).not.toBe(first[1]);
    expect(out[1]?.snippet).toBe("new text");
  });
});

describe("askServer", () => {
  const answer = (r: Partial<SearchResult>): SearchResult => ({
    hits: [],
    modeUsed: "hybrid",
    ...r,
  });

  it("semantic matches arrive as `answered`", async () => {
    const out = await askServer({ query: "q" }, new AbortController().signal, {
      search: async () => answer({ hits: [hit("x")] }),
    });
    expect(out?.kind).toBe("answered");
  });

  it("a server whose semantic search did not run says why, as `fell-back`", async () => {
    const fallback = { reason: "not_configured", message: "not set up" };
    const out = await askServer({ query: "q" }, new AbortController().signal, {
      search: async () => answer({ modeUsed: "keyword", fallback }),
    });
    expect(out).toEqual({ kind: "fell-back", fallback });
  });

  it("passes the time bound down, and a timeout is `timed-out`", async () => {
    let seen: number | undefined;
    const out = await askServer({ query: "q" }, new AbortController().signal, {
      timeoutMs: 1234,
      search: async (_i, opts) => {
        seen = opts.timeoutMs;
        throw new ApiError("timeout", "no answer");
      },
    });
    expect(seen).toBe(1234);
    expect(out).toEqual({ kind: "timed-out" });
  });

  it("any other failure is `failed`, with the address and hint", async () => {
    const out = await askServer({ query: "q" }, new AbortController().signal, {
      search: async () => {
        throw new ApiError("network", "could not reach http://h:1 (Failed to fetch)");
      },
    });
    expect(out).toEqual({
      kind: "failed",
      message: "could not reach http://h:1 (Failed to fetch)",
    });
  });

  it("an answer for a query that has since changed is thrown away", async () => {
    const controller = new AbortController();
    let resolve: (r: SearchResult) => void = () => {};
    const pending = askServer({ query: "old" }, controller.signal, {
      search: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    controller.abort();
    resolve(answer({ hits: [hit("stale")] }));
    expect(await pending).toBeUndefined();
  });
});

describe("searchSourceLine", () => {
  it("says which side answered, quietly", () => {
    expect(searchSourceLine({ kind: "not-asked", why: "local-only" }, 0)).toBe(
      "Keyword search on this device (local-only).",
    );
    expect(searchSourceLine({ kind: "not-asked", why: "offline" }, 0)).toBe(
      "Keyword search on this device (offline).",
    );
    expect(searchSourceLine({ kind: "answered", result: answerOf(), adoptOrder: true }, 2)).toBe(
      "Keyword (this device) and semantic (server) · 2 found by meaning.",
    );
    expect(searchSourceLine({ kind: "timed-out" }, 0)).toBe(
      "Keyword search on this device · the server did not answer in time.",
    );
    // The fallback note says it instead.
    expect(searchSourceLine({ kind: "fell-back" }, 0)).toBeNull();
  });
});

function answerOf(): SearchResult {
  return { hits: [], modeUsed: "hybrid" };
}
