// B-736: does a page's `<a download>` click become a saved file in an embedded WKWebView, given the
// delegate wry installs once a Tauri download handler is set — and does nothing without one?
//
// The desktop shell (apps/desktop/src-tauri/src/main.rs) now sets `on_download`. wry 0.55's
// `navigation_policy` (src/wkwebview/navigation.rs) then answers a navigation action whose
// `shouldPerformDownload` is true with `.download` (without a handler: `.cancel`), and its
// `WKDownloadDelegate` picks `~/Downloads/<suggestedFilename>`. This probe installs the same two
// answers on a bare WKWebView, writes into a temp dir instead, and has the page do exactly what
// `apps/web/src/editor/render/image-actions.ts` does for the desktop host: a throwaway
// `<a href=<absolute http URL> download=<name>>` and `.click()`. A blob: URL is tried too, for
// comparison, and the run is repeated with the handler absent (`.cancel`).
//
// Run (needs a server for the page and the picture; the page must be http, as in the app):
//   dir=$(mktemp -d) && cp <any>.png "$dir/pic.png" && echo '<!doctype html><body>probe</body>' > "$dir/index.html"
//   (cd "$dir" && python3 -m http.server 6479 --bind 127.0.0.1) &
//   swiftc -O tools/probes/wkwebview-download.swift -o /tmp/wkdl && /tmp/wkdl http://127.0.0.1:6479/
//
// Result 2026-10-04, macOS 27.0.1: http URL with the handler → `shouldPerformDownload=true`,
// WKDownload with suggestedFilename = the `download` attribute ("garden shed.png"), file written
// (70 B, the picture's size). blob: URL with the handler → the same. No handler (`.cancel`) →
// nothing written, nothing reported — the silent no-op B-736 describes. The clicks here come from
// `evaluateJavaScript`, i.e. WITHOUT a user gesture, so a real click is not more restricted.

import AppKit
import WebKit

let base = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:6479/"
let outDir = FileManager.default.temporaryDirectory.appendingPathComponent("wkdl-\(getpid())")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var webView: WKWebView!
  var window: NSWindow!
  var handlerSet = true
  var events: [String] = []
  var step = 0

  func log(_ s: String) { print(s); fflush(stdout) }

  // wry's navigation_policy, minus the url callback.
  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload {
      log("  navigationAction shouldPerformDownload=true url=\(action.request.url?.absoluteString ?? "?") -> \(handlerSet ? "download" : "cancel")")
      decisionHandler(handlerSet ? .download : .cancel)
    } else {
      decisionHandler(.allow)
    }
  }
  func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }
  func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }
  // wry's download_policy: <download dir>/<suggestedFilename>.
  func download(_ d: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let dest = outDir.appendingPathComponent(suggestedFilename)
    try? FileManager.default.removeItem(at: dest)
    log("  download suggestedFilename=\(suggestedFilename) mime=\(response.mimeType ?? "?")")
    completionHandler(dest)
  }
  func downloadDidFinish(_ d: WKDownload) {
    let files = (try? FileManager.default.contentsOfDirectory(atPath: outDir.path)) ?? []
    let sizes = files.map { f -> String in
      let n = (try? FileManager.default.attributesOfItem(atPath: outDir.appendingPathComponent(f).path)[.size]) ?? 0
      return "\(f)=\(n)B"
    }
    log("  FINISHED ok — dir now: \(sizes.joined(separator: ", "))")
    next()
  }
  func download(_ d: WKDownload, didFailWithError e: Error, resumeData: Data?) {
    log("  FAILED: \(e.localizedDescription)")
    next()
  }

  let cases: [(String, Bool, String)] = [
    ("http URL, handler set", true, "const a=document.createElement('a');a.href=new URL('pic.png',location.href).href;a.download='garden shed.png';document.body.append(a);a.click();a.remove();"),
    ("blob URL, handler set", true, "fetch('pic.png').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='from blob.png';document.body.append(a);a.click();a.remove();});"),
    ("http URL, NO handler (cancel)", false, "const a=document.createElement('a');a.href=new URL('pic.png',location.href).href;a.download='should not exist.png';document.body.append(a);a.click();a.remove();"),
  ]

  func next() {
    guard step < cases.count else {
      let files = (try? FileManager.default.contentsOfDirectory(atPath: outDir.path)) ?? []
      log("DONE files=\(files.sorted())")
      exit(0)
    }
    let (label, handler, js) = cases[step]
    step += 1
    handlerSet = handler
    log("case: \(label)")
    webView.evaluateJavaScript("{ " + js + " }; 0") { _, err in if let err { self.log("  js error: \(err)") } }
    // A cancelled download reports nothing; move on after a while either way.
    let mine = step
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
      if self.step == mine { self.log("  (no download event within 4 s)"); self.next() }
    }
  }

  func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
    log("loaded \(w.url?.absoluteString ?? "?") macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
    next()
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    webView = WKWebView(frame: .init(x: 0, y: 0, width: 300, height: 200), configuration: WKWebViewConfiguration())
    webView.navigationDelegate = self
    window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = webView
    webView.load(URLRequest(url: URL(string: base)!))
  }
}

let app = NSApplication.shared
let probe = Probe()
app.delegate = probe
app.setActivationPolicy(.prohibited)
DispatchQueue.global().asyncAfter(deadline: .now() + 60) { print("TIMEOUT"); exit(2) }
app.run()
