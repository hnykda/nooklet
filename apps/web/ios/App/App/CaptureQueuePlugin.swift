import Capacitor
import Foundation

/// The web layer's handle on `CaptureQueue` (ADR 033): list, read, remove. Nothing else, and no
/// write: only the App Intent adds to the queue. Lives in the app target and is registered by
/// `AppViewController`, so it needs no npm package and no `cap sync` step.
///
/// JS: `registerPlugin("NookletCapture")` in `apps/web/src/capture/native-queue.ts`.
@objc(CaptureQueuePlugin)
public class CaptureQueuePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CaptureQueuePlugin"
    public let jsName = "NookletCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    @objc func list(_ call: CAPPluginCall) {
        do {
            call.resolve(["ids": try CaptureQueue.appDefault().list()])
        } catch {
            call.reject("Could not list the capture queue: \(error)")
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        do {
            call.resolve(["json": try CaptureQueue.appDefault().read(id)])
        } catch {
            call.reject("Could not read capture \(id): \(error)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        do {
            try CaptureQueue.appDefault().remove(id)
            call.resolve()
        } catch {
            call.reject("Could not remove capture \(id): \(error)")
        }
    }
}
