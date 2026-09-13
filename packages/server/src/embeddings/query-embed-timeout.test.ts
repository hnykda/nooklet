/**
 * B-522: a search's query embed is bounded. A host that accepts the connection and never answers
 * used to hold the search for undici's 300 s header timeout; now it falls back, and says why.
 *
 * Real sockets, not a mocked `fetch`: the bug lives in what `fetch` does with a silent peer.
 * `timeoutMs` is shortened here; the production bound is `QUERY_EMBED_TIMEOUT_MS`.
 */

import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer } from "../test-helpers.js";
import { activateModel, registerModel } from "./model-registry.js";
import { embedQueryForSearch, QUERY_EMBED_TIMEOUT_MS } from "./semantic-search.js";
import { setEmbeddingSettings } from "./settings.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Accepts TCP and never writes a byte. */
async function silentHost(): Promise<string> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Lists bge-m3 at once, but never answers an embed — a model stuck loading. */
async function hostThatNeverEmbeds(): Promise<string> {
  const server = createHttpServer((req, res) => {
    req.resume();
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "bge-m3:latest" }] }));
    }
    // /api/embed: no response, ever.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.closeAllConnections());
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function activeModelAt(host: string) {
  const { driver } = makeTestServer().serverCtx;
  setEmbeddingSettings(driver, { provider: "ollama", model: "bge-m3", host });
  const row = registerModel(driver, { provider: "ollama", model: "bge-m3", dims: 8 });
  activateModel(driver, row.id);
  return { driver, model: { ...row, active: true } };
}

describe("query embed timeout (B-522)", () => {
  it("is bounded in production by a finite constant", () => {
    expect(QUERY_EMBED_TIMEOUT_MS).toBeGreaterThan(0);
    expect(QUERY_EMBED_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("a host that accepts and never answers falls back as unreachable, saying how long it waited", async () => {
    const host = await silentHost();
    const { driver, model } = activeModelAt(host);
    const t0 = Date.now();
    const out = await embedQueryForSearch(driver, model, "pricing", undefined, { timeoutMs: 300 });
    // 300 ms for the embed plus the probe's own 2.5 s bound, with slack for a loaded machine.
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(out.vector).toBeUndefined();
    expect(out.fallback).toMatchObject({
      reason: "provider_unreachable",
      host,
      error: "no answer within 0.3 s",
    });
  }, 15_000);

  it("a host that lists the model but never embeds falls back as a failed query embed", async () => {
    const host = await hostThatNeverEmbeds();
    const { driver, model } = activeModelAt(host);
    const out = await embedQueryForSearch(driver, model, "pricing", undefined, { timeoutMs: 300 });
    expect(out.fallback).toMatchObject({
      reason: "query_embedding_failed",
      error: "no answer within 0.3 s",
    });
  }, 15_000);

  it("a caller's own abort is reported as cancelled, not as a timeout", async () => {
    const host = await silentHost();
    const { driver, model } = activeModelAt(host);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const out = await embedQueryForSearch(driver, model, "pricing", controller.signal, {
      timeoutMs: 5_000,
    });
    expect(out.fallback?.reason).toBe("query_embedding_failed");
    expect(out.fallback?.message).toContain("cancelled");
  }, 15_000);
});
