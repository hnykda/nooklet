// Worker half of the capacitor-network probe (see index.html). Mirrors the exact URL construction
// `apps/web/src/sync/http-transport.ts` uses, since a Worker loaded from `capacitor://` resolves
// URLs differently than a page does (B-569).
self.onmessage = async (ev) => {
  const { BASE, TOKEN } = ev.data;
  const G = `${BASE}/g/default`;
  const post = (tag, ok, detail) => self.postMessage({ tag, ok, detail });
  post("worker.location", true, `origin=${self.location.origin} href=${self.location.href}`);
  let url;
  try {
    // http-transport.ts#pull: `new URL(`${base}/sync/pull`, self.location.origin)`
    url = new URL(`${G}/sync/pull`, self.location.origin);
    post("worker.newURL(abs, location.origin)", true, url.href);
  } catch (e) {
    post("worker.newURL(abs, location.origin)", false, String(e));
    url = new URL(`${G}/sync/pull`);
  }
  url.searchParams.set("device_id", "probe001");
  url.searchParams.set("since", "0");
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    post(
      "worker.sync/pull (preflighted GET)",
      r.ok,
      `${r.status} ${(await r.text()).slice(0, 60)}`,
    );
  } catch (e) {
    post("worker.sync/pull (preflighted GET)", false, String(e));
  }
  await new Promise((resolve) => {
    let ws;
    try {
      const u = new URL(`${G}/sync/live`, self.location.href);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(u.toString());
    } catch (e) {
      post("worker.ws construct", false, String(e));
      return resolve();
    }
    const t = setTimeout(() => {
      post("worker.ws", false, "timeout, no open/message within 8s");
      resolve();
    }, 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", device_id: "probe001", token: TOKEN }));
      post("worker.ws open", true, ws.url);
      // An authenticated hello is answered by nothing until a commit pokes; staying open 1.5s
      // after hello without a close is the success signal (a bad token closes the socket).
      setTimeout(() => {
        clearTimeout(t);
        post("worker.ws after hello", ws.readyState === 1, `readyState=${ws.readyState}`);
        ws.close();
        resolve();
      }, 1500);
    };
    ws.onclose = (e) =>
      post("worker.ws close", e.code === 1000 || e.code === 1005, `code=${e.code}`);
    ws.onerror = () => post("worker.ws error", false, "error event");
  });
  self.postMessage("done");
};
