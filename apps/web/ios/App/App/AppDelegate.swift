import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if DEBUG
        DebugLaunchHooks.run()
        #endif
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

#if DEBUG
/// Simulator verification hooks (ADR 033), compiled into Debug builds only and reachable only
/// through launch arguments, which only whoever launches the process can set (Xcode, or
/// `xcrun simctl launch <udid> sh.nooklet.app -NookletDebugEnqueue "text"`). Never a URL: a link
/// that wrote silently is exactly what the capture design forbids.
///
/// - `-NookletDebugEnqueue <text>` runs `AddToNookletIntent.enqueue`, the code the App Intent
///   runs, before any web view exists.
/// - `-NookletDebugExitAfterEnqueue YES` then exits, so the web layer never starts: the file is
///   left in the queue for inspection, as after an intent run with the app closed.
/// - `-NookletDebugQuickAction <type>` runs the quick-action handler for that
///   `UIApplicationShortcutItemType` once the app is up (`xcrun simctl` cannot long-press).
enum DebugLaunchHooks {
    static func run() {
        let defaults = UserDefaults.standard
        if let text = defaults.string(forKey: "NookletDebugEnqueue"), #available(iOS 16.0, *) {
            do {
                try AddToNookletIntent.enqueue(text)
                NSLog("[nooklet-debug] enqueued a capture")
            } catch {
                NSLog("[nooklet-debug] enqueue failed: \(error)")
            }
            if defaults.bool(forKey: "NookletDebugExitAfterEnqueue") { exit(0) }
        }
        if let type = defaults.string(forKey: "NookletDebugQuickAction") {
            DispatchQueue.main.async {
                NSLog("[nooklet-debug] quick action \(type): \(QuickActions.handle(type: type))")
            }
        }
    }
}
#endif
