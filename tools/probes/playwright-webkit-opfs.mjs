// Settles: does Playwright's WebKit build support OPFS sync access handles inside a dedicated
// worker, the way Safari/WKWebView do? (2026-09-12, WebKit 26.6 / playwright webkit v2359)
//
// Answer: NO. `navigator.storage.getDirectory()` itself rejects inside a worker with
// `UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).`
// Chromium (1243) passes every step, including a second sync handle on the same file.
//
// Why it matters: the client's replica lives in `opfs-sahpool` (apps/web/src/db/), which needs
// exactly this API. A Playwright WebKit run therefore cannot open the database at all, every
// worker RPC rejects, and the app never renders a real outliner — so WebKit cannot be used as a
// stand-in for the Mac app's WKWebView in e2e, at least not without an in-memory storage
// fallback. The real WKWebView is fine: `wkwebview-opfs.swift` wrote 1.2 GB through it.
//
// Run from `e2e/` (so `@playwright/test` resolves) against any nooklet server:
//   BASE=http://127.0.0.1:6188 node ../tools/probes/playwright-webkit-opfs.mjs
import { chromium, webkit } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6188";

for (const [name, engine] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  const b = await engine.launch();
  const p = await b.newPage();
  await p.goto(`${BASE}/healthz`);
  const r = await p.evaluate(async () => {
    const out = {
      locks: typeof navigator.locks,
      getDirectory: typeof navigator.storage?.getDirectory,
    };
    const src = `
      self.onmessage = async () => {
        const log = [];
        try {
          const root = await navigator.storage.getDirectory(); log.push("getDirectory ok");
          const fh = await root.getFileHandle("probe.bin", { create: true }); log.push("getFileHandle ok");
          log.push("createSyncAccessHandle: " + typeof fh.createSyncAccessHandle);
          const h = await fh.createSyncAccessHandle(); log.push("createSyncAccessHandle ok, size=" + h.getSize());
          h.write(new Uint8Array([1, 2, 3]), { at: 0 }); h.flush(); log.push("write ok size=" + h.getSize()); h.close();
          try { const h2 = await fh.createSyncAccessHandle(); log.push("second handle ok"); h2.close(); }
          catch (e) { log.push("second handle: " + e.name + " " + e.message); }
        } catch (e) { log.push("ERR " + e.name + ": " + e.message); }
        self.postMessage(log);
      };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    out.worker = await new Promise((res) => {
      w.onmessage = (e) => res(e.data);
      w.onerror = (e) => res([`worker error ${e.message}`]);
      w.postMessage(1);
    });
    return out;
  });
  console.log(name, JSON.stringify(r));
  await b.close();
}
