// Does OPFS hold a real SQLite-sized database inside an embedded WKWebView?
//
// This mimics Tauri's origin model: content is served from a custom scheme via a
// WKURLSchemeHandler (exactly what wry does), NOT from file:// or http://localhost, because the
// secure-context and quota rules differ per origin and we want the answer for the real thing.
//
// Reports: isSecureContext, navigator.storage.estimate(), and how many MB can actually be written
// into ONE OPFS file via createSyncAccessHandle before it fails.

import AppKit
import WebKit

let SCHEME = "nooklet"
let TARGET_MB = Int(ProcessInfo.processInfo.environment["TARGET_MB"] ?? "400")!

let indexHTML = """
<!doctype html><meta charset="utf-8"><title>opfs probe</title>
<body><pre id="out">starting…</pre><script type="module">
const say = (m) => { document.getElementById('out').textContent += "\\n" + m;
                     window.webkit.messageHandlers.probe.postMessage(m); };

say("origin=" + location.origin);
say("isSecureContext=" + window.isSecureContext);
say("hasStorageManager=" + !!navigator.storage);
say("hasGetDirectory=" + !!(navigator.storage && navigator.storage.getDirectory));
say("hasLocks=" + !!navigator.locks);

try {
  const est = await navigator.storage.estimate();
  say("estimate.quota=" + est.quota + " (" + (est.quota/1048576).toFixed(0) + " MiB)");
  say("estimate.usage=" + est.usage);
} catch (e) { say("estimate THREW: " + e); }

// createSyncAccessHandle is worker-only, which is how sqlite-wasm's opfs-sahpool VFS uses it.
const workerSrc = await (await fetch("/worker.js")).text();
const w = new Worker(URL.createObjectURL(new Blob([workerSrc], {type:"text/javascript"})), {type:"module"});
w.onmessage = (e) => {
  say(e.data);
  if (e.data.startsWith("DONE") || e.data.startsWith("FATAL")) {
    window.webkit.messageHandlers.probe.postMessage("__EXIT__");
  }
};
w.onerror = (e) => say("worker error: " + e.message);
w.postMessage({ targetMb: \(TARGET_MB) });
</script>
"""

let workerJS = """
self.onmessage = async (ev) => {
  const targetMb = ev.data.targetMb;
  const say = (m) => self.postMessage(m);
  try {
    say("worker isSecureContext=" + self.isSecureContext);
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("probe.db", { create: true });
    if (!fh.createSyncAccessHandle) { say("FATAL no createSyncAccessHandle"); return; }
    const h = await fh.createSyncAccessHandle();
    const chunk = new Uint8Array(1024 * 1024); chunk.fill(65);
    let written = 0;
    for (let i = 0; i < targetMb; i++) {
      try {
        h.write(chunk, { at: written });
        written += chunk.byteLength;
      } catch (e) {
        say("WRITE FAILED at " + (written/1048576).toFixed(0) + " MiB: " + e.name + ": " + e.message);
        break;
      }
      if ((i+1) % 50 === 0) say("  wrote " + ((i+1)) + " MiB…");
    }
    h.flush();
    const size = h.getSize();
    h.close();
    say("final file size = " + (size/1048576).toFixed(1) + " MiB");
    const est = await navigator.storage.estimate();
    say("post-write estimate.usage=" + (est.usage/1048576).toFixed(1) + " MiB quota=" + (est.quota/1048576).toFixed(0) + " MiB");
    say("DONE wrote=" + (written/1048576).toFixed(0) + " MiB of " + targetMb + " MiB requested");
  } catch (e) { say("FATAL " + e.name + ": " + e.message); }
};
"""

final class Handler: NSObject, WKURLSchemeHandler {
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    let path = task.request.url?.path ?? "/"
    let (body, mime) = path.hasSuffix("worker.js")
      ? (workerJS, "text/javascript") : (indexHTML, "text/html")
    let data = body.data(using: .utf8)!
    let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "\(mime); charset=utf-8", "Access-Control-Allow-Origin": "*"])!
    task.didReceive(resp); task.didReceive(data); task.didFinish()
  }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Probe: NSObject, WKScriptMessageHandler, NSApplicationDelegate {
  var window: NSWindow!
  var webView: WKWebView!

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    let s = "\(m.body)"
    if s == "__EXIT__" { fflush(stdout); exit(0) }
    print(s); fflush(stdout)
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(Handler(), forURLScheme: SCHEME)
    cfg.userContentController.add(self, name: "probe")
    // A persistent data store is what a real app uses; the default is already persistent, but be
    // explicit so nobody reads this result as "it passed because everything was in memory".
    cfg.websiteDataStore = .default()
    webView = WKWebView(frame: .init(x: 0, y: 0, width: 700, height: 500), configuration: cfg)
    window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    webView.load(URLRequest(url: URL(string: "\(SCHEME)://localhost/index.html")!))
  }
}

let app = NSApplication.shared
let probe = Probe()
app.delegate = probe
app.setActivationPolicy(.accessory)
// Hard stop so a hang can never wedge the session.
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
  print("TIMEOUT after 180s"); exit(2)
}
app.run()
