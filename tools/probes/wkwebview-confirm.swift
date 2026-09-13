// What do `window.confirm()` and `window.alert()` do inside the desktop app's webview?
//
// wry 0.55.1 (the webview Tauri 2.11 uses) installs a WKUIDelegate that implements the file-upload
// panel, media-capture permission and new-window handling — and NOT
// `webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:` or its alert
// sibling (read in ~/.cargo/registry/src/*/wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs,
// 2026-09-13). This reproduces exactly that: a UI delegate with no dialog methods, and reports
// what `confirm()` returns and whether it blocked.
//
// Run: swift tools/probes/wkwebview-confirm.swift
// Prints e.g. `confirm returned false after 0 ms` — a confirm the person never saw.

import AppKit
import WebKit

let indexHTML = """
<!doctype html><meta charset="utf-8"><title>confirm probe</title>
<body><script>
const say = (m) => window.webkit.messageHandlers.probe.postMessage(String(m));
let t = performance.now();
const r = window.confirm("Delete this page?");
say("confirm returned " + r + " after " + Math.round(performance.now() - t) + " ms");
t = performance.now();
const a = window.alert("Something failed");
say("alert returned " + a + " after " + Math.round(performance.now() - t) + " ms");
say("__EXIT__");
</script>
"""

/// Like wry's delegate: a WKUIDelegate that implements none of the JavaScript panel methods.
final class NoDialogsDelegate: NSObject, WKUIDelegate {}

final class Probe: NSObject, WKScriptMessageHandler, NSApplicationDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  let uiDelegate = NoDialogsDelegate()

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    let s = "\(m.body)"
    if s == "__EXIT__" { fflush(stdout); exit(0) }
    print(s); fflush(stdout)
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let cfg = WKWebViewConfiguration()
    cfg.userContentController.add(self, name: "probe")
    webView = WKWebView(frame: .init(x: 0, y: 0, width: 400, height: 300), configuration: cfg)
    webView.uiDelegate = uiDelegate
    window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    webView.loadHTMLString(indexHTML, baseURL: URL(string: "https://probe.localhost/"))
  }
}

let app = NSApplication.shared
let probe = Probe()
app.delegate = probe
app.setActivationPolicy(.accessory)
// A confirm that DID block would wait for a click nobody makes; stop rather than hang.
DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
  print("TIMEOUT after 20s — confirm() blocked waiting for an answer (a dialog was shown)"); exit(2)
}
app.run()
