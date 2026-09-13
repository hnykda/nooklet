/**
 * Probe (2026-09-13, m11/search-fallback): what does a hybrid `search` do when a model is active
 * and its embedding host accepts the connection but never answers — an Ollama wedged mid-load, a
 * host behind a dropped VPN, a stopped container whose port is still forwarded?
 *
 * B-520's `fallback` only helps if the search comes back at all. A refused port fails at once
 * (`search-fallback.http.test.ts` covers that); a silent one is the other half. The query embed
 * passes only the request's own signal to `fetch`, so the question is whether anything bounds it.
 *
 * Run from the repo root:
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/search-embed-silent-host.ts [capSeconds]
 *
 * Prints how long `search` took, or that it was still pending at the cap.
 */
import { createServer } from "node:net";
import {
  activateModel,
  registerModel,
  setEmbeddingSettings,
} from "../../packages/server/src/embeddings/index.js";
import { makeTestServer, post } from "../../packages/server/src/test-helpers.js";

const capSeconds = Number(process.argv[2] ?? 30);

// Accepts TCP, reads the request, never writes a byte back.
const sockets: import("node:net").Socket[] = [];
const silent = createServer((socket) => {
  sockets.push(socket);
  socket.on("data", () => {});
});
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
const port = (silent.address() as import("node:net").AddressInfo).port;
const host = `http://127.0.0.1:${port}`;

const s = makeTestServer();
await post(s.app, "/api/v1/page.create", s.writeToken, {
  name: "Silent Host Probe",
  markdown: "- pricing notes",
});
const driver = s.serverCtx.driver;
setEmbeddingSettings(driver, { provider: "ollama", model: "bge-m3", host });
activateModel(driver, registerModel(driver, { provider: "ollama", model: "bge-m3", dims: 8 }).id);

const t0 = Date.now();
const searching = post(s.app, "/api/v1/search", s.readToken, { query: "pricing", mode: "hybrid" });
const outcome = await Promise.race([
  searching.then((r) => ({ done: true as const, r })),
  new Promise<{ done: false }>((resolve) =>
    setTimeout(() => resolve({ done: false }), capSeconds * 1000),
  ),
]);
if (outcome.done) {
  console.log(
    `search answered after ${Date.now() - t0} ms: status ${outcome.r.status}, mode_used ${outcome.r.json.mode_used}, fallback ${JSON.stringify(outcome.r.json.fallback)}`,
  );
} else {
  console.log(`search still pending after ${capSeconds} s against a host that never answers`);
}
for (const socket of sockets) socket.destroy();
silent.close();
process.exit(0);
