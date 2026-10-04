import Capacitor
import UIKit

/// The app's bridge view controller. Exists only to register plugins that live in the app target
/// rather than in an npm package (Capacitor's documented way for local plugins:
/// `registerPluginInstance` from `capacitorDidLoad`).
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CaptureQueuePlugin())
    }
}

/// Hands a `nooklet://` URL to the web layer exactly as if iOS had opened it: Capacitor's
/// `@capacitor/app` delivers it as `appUrlOpen`, and remembers it as `getLaunchUrl()` for a cold
/// start, when the web view is not listening yet. Quick actions and the "Open nooklet to add"
/// intent use this, so the web layer has one entry for every native action
/// (`apps/web/src/capture/AppLinkHandler.tsx`).
enum AppLinkForwarder {
    @MainActor
    static func open(_ url: URL) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    static func captureURL(text: String? = nil, url: String? = nil, title: String? = nil) -> URL {
        var c = URLComponents()
        c.scheme = "nooklet"
        c.host = "capture"
        let items = [("text", text), ("url", url), ("title", title)].compactMap { key, value in
            value.flatMap { $0.isEmpty ? nil : URLQueryItem(name: key, value: $0) }
        }
        if !items.isEmpty { c.queryItems = items }
        // swiftlint:disable:next force_unwrapping
        return c.url!
    }
}

/// Home Screen quick actions (`UIApplicationShortcutItems` in Info.plist). Each becomes a
/// `nooklet://` link; the web layer decides what it opens.
enum QuickActions {
    static let links: [String: String] = [
        "sh.nooklet.app.capture": "nooklet://capture",
        "sh.nooklet.app.today": "nooklet://today",
        "sh.nooklet.app.search": "nooklet://search",
    ]

    @MainActor
    @discardableResult
    static func handle(_ item: UIApplicationShortcutItem) -> Bool {
        handle(type: item.type)
    }

    @MainActor
    @discardableResult
    static func handle(type: String) -> Bool {
        guard let link = links[type], let url = URL(string: link) else { return false }
        AppLinkForwarder.open(url)
        return true
    }
}
