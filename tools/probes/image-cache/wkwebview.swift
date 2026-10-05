// B-738: the WKWebView half of `probe.mjs`. Playwright's WebKit is not the Mac app's engine
// configuration (it runs with no disk cache at all, which `probe.mjs` shows), so this drives a real
// WKWebView with a PERSISTENT data store, as Tauri's wry and Capacitor both use, through the same
// steps. It prints `BEGIN <step>` / `END <step>` lines; `probe.mjs` counts the requests that reach
// the server in between. Not meant to be run on its own.
//
//   swiftc -O tools/probes/image-cache/wkwebview.swift -o <scratch>/wk-image-cache
//   <scratch>/wk-image-cache <mode> <base> <store-uuid> <asset-url>...
//
// mode `desktop`: the app itself, loaded from the server's own origin (the Mac app's shape).
// mode `capacitor`: a page from a custom scheme (`capacitor://localhost`, served here by a
//   WKURLSchemeHandler as Capacitor's own handler does) showing the asset URLs cross-origin.
// mode `relaunch-*`: the same, in a fresh process on the same data store: is the cache on disk?

import AppKit
import WebKit

let args = CommandLine.arguments
let mode = args[1]
let base = args[2]
let storeId = UUID(uuidString: args[3])!
let assets = Array(args.dropFirst(4))

func say(_ s: String) { print(s); fflush(stdout) }

let capacitorHTML = """
<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
window.showAll = () => Promise.all(\(assets.map { "\"\($0)\"" }).map((src) => new Promise((ok, no) => {
  const img = new Image(); img.className = "vr-image"; img.style.width = "300px";
  img.onload = ok; img.onerror = () => no(new Error("load failed " + src)); img.src = src;
  document.body.append(img);
})));
window.removeAll = () => document.querySelectorAll("img").forEach((i) => i.remove());
</script>
"""

final class Scheme: NSObject, WKURLSchemeHandler {
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "text/html; charset=utf-8"])!
    task.didReceive(resp)
    task.didReceive(capacitorHTML.data(using: .utf8)!)
    task.didFinish()
  }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

let decoded = """
  for (let i = 0; i < 1200; i++) {
    const imgs = [...document.querySelectorAll("img.vr-image")];
    // Scrolled into view one by one: the app's pictures are `loading="lazy"`, and a window is only
    // as tall as the screen.
    for (const img of imgs) if (!img.complete) { img.scrollIntoView(); break; }
    if (imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
"""

@MainActor
final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var loaded: CheckedContinuation<Void, Never>?

  func makeView() -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: storeId)
    cfg.setURLSchemeHandler(Scheme(), forURLScheme: "capacitor")
    // `*-nosw` modes: the app as if the browser had no service workers (`sw/register.ts` checks
    // `"serviceWorker" in navigator`), to tell the service worker's part from the rest.
    if mode.hasSuffix("-nosw") {
      cfg.userContentController.addUserScript(WKUserScript(
        source: "delete Navigator.prototype.serviceWorker;",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    let v = WKWebView(frame: .init(x: 0, y: 0, width: 1200, height: 900), configuration: cfg)
    v.navigationDelegate = self
    return v
  }

  nonisolated func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded?.resume()
      loaded = nil
    }
  }

  // The probe's https proxy has a throwaway self-signed certificate (`probe.mjs`); accept it, and
  // only it: everything here talks to 127.0.0.1.
  func webView(_ w: WKWebView, respondTo challenge: URLAuthenticationChallenge) async
    -> (URLSession.AuthChallengeDisposition, URLCredential?)
  {
    say("challenge \(challenge.protectionSpace.host) \(challenge.protectionSpace.authenticationMethod)")
    if challenge.protectionSpace.host == "127.0.0.1", let trust = challenge.protectionSpace.serverTrust {
      return (.useCredential, URLCredential(trust: trust))
    }
    return (.performDefaultHandling, nil)
  }

  func load(_ v: WKWebView, _ url: String) async {
    await withCheckedContinuation { c in
      loaded = c
      v.load(URLRequest(url: URL(string: url)!))
    }
  }

  func reload(_ v: WKWebView) async {
    await withCheckedContinuation { c in
      loaded = c
      v.reload()
    }
  }

  func js(_ v: WKWebView, _ body: String) async -> Any? {
    do {
      return try await v.callAsyncJavaScript(body, contentWorld: .page)
    } catch {
      say("JS ERROR \(error)")
      return nil
    }
  }

  func step(_ label: String, _ body: () async -> Void) async {
    say("BEGIN \(label)")
    let t0 = Date()
    await body()
    say("END \(label) \(Int(Date().timeIntervalSince(t0) * 1000))")
  }

  func show(_ v: WKWebView) {
    window = NSWindow(contentRect: v.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = v
    window.makeKeyAndOrderFront(nil)
  }

  func runDesktop(relaunch: Bool) async {
    let v = makeView()
    show(v)
    let photos = "\(base)/page/Photos"
    await step(relaunch ? "R new process, same data store" : "1 first visit") {
      await load(v, photos)
      _ = await js(v, decoded)
    }
    let sw = await js(v, """
      if (!("serviceWorker" in navigator)) return "no serviceWorker API";
      await new Promise((r) => setTimeout(r, 1500));
      const regs = await navigator.serviceWorker.getRegistrations();
      return `registrations=${regs.length} controller=${navigator.serviceWorker.controller ? "yes" : "no"}`;
      """)
    say("service worker: \(sw ?? "?")")
    if relaunch { return }
    await step("2 in-app away and Back") {
      _ = await js(v, """
        [...document.querySelectorAll(".vr-outliner a")].find((a) => a.textContent.includes("Elsewhere")).click();
        for (let i = 0; i < 100 && !location.pathname.includes("Elsewhere"); i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 500));
        history.back();
        await new Promise((r) => setTimeout(r, 300));
        """ + decoded)
    }
    await step("3 reload") {
      await reload(v)
      _ = await js(v, decoded)
    }
    await step("4 second view, same data store") {
      let v2 = makeView()
      v2.frame = v.frame
      window.contentView = v2
      await load(v2, photos)
      _ = await js(v2, decoded)
    }
  }

  func runCapacitor(relaunch: Bool) async {
    let v = makeView()
    show(v)
    await load(v, "capacitor://localhost/index.html")
    let diag = await js(v, """
      try { await fetch("\(assets[0])", { mode: "no-cors" }); return "fetch ok"; }
      catch (e) { return "fetch failed: " + e; }
      """)
    say("diag \(diag ?? "?")")
    await step(relaunch ? "R new process, same data store" : "5a cross-origin, first") {
      _ = await js(v, "await showAll(); return true;")
    }
    if relaunch { return }
    await step("5b cross-origin, removed and shown again") {
      _ = await js(v, "removeAll(); await new Promise((r) => setTimeout(r, 300)); await showAll(); return true;")
    }
    await step("5c cross-origin, after reload") {
      await reload(v)
      _ = await js(v, "await showAll(); return true;")
    }
  }

  /** The proxy's control pictures (`probe.mjs`, `CONTROLS`): first view, reload, second view. */
  func runControl(relaunch: Bool) async {
    let v = makeView()
    show(v)
    let page = "\(base)/ctl/page"
    await step(relaunch ? "C new process" : "C1 control, first") {
      await load(v, page)
      _ = await js(v, decoded)
    }
    if relaunch { return }
    await step("C2 control, reload") {
      await reload(v)
      _ = await js(v, decoded)
    }
    await step("C3 control, second view") {
      let v2 = makeView()
      v2.frame = v.frame
      window.contentView = v2
      await load(v2, page)
      _ = await js(v2, decoded)
    }
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    Task { @MainActor in
      switch mode {
      case "desktop", "desktop-nosw": await runDesktop(relaunch: false)
      case "relaunch-desktop", "relaunch-desktop-nosw": await runDesktop(relaunch: true)
      case "capacitor": await runCapacitor(relaunch: false)
      case "relaunch-capacitor": await runCapacitor(relaunch: true)
      case "control": await runControl(relaunch: false)
      case "relaunch-control": await runControl(relaunch: true)
      default: say("unknown mode \(mode)")
      }
      say("DONE")
      exit(0)
    }
  }
}

let app = NSApplication.shared
let probe = MainActor.assumeIsolated { Probe() }
app.delegate = probe
app.setActivationPolicy(.accessory)
DispatchQueue.global().asyncAfter(deadline: .now() + 300) {
  print("TIMEOUT after 300s")
  exit(2)
}
app.run()
