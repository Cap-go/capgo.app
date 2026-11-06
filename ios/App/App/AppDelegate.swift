import UIKit
import Capacitor
import CapacitorUpdaterPlugin
import CapgoNotificationsPlugin

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        resetUpdaterStateForDebugWebBundle()

        // Override point for customization after application launch.
        // The window, deep links and universal links are handled in SceneDelegate.
        return true
    }

    private func resetUpdaterStateForDebugWebBundle() {
        #if DEBUG
        let defaults = UserDefaults.standard
        let markerKey = "capgoDebugWebBundleMarker"
        let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public")
        let attributes = indexURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
        let modifiedAt = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let size = attributes?[.size] as? NSNumber
        let marker = "\(modifiedAt):\(size?.stringValue ?? "0")"

        guard defaults.string(forKey: markerKey) != marker else {
            return
        }

        for key in ["serverBasePath", "pastVersion", "nextVersion", "previewFallbackVersion"] {
            defaults.removeObject(forKey: key)
        }
        defaults.set(marker, forKey: markerKey)
        defaults.synchronize()
        #endif
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ _: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // The static entry point keeps pushes that arrive before the bridge loads the plugin
        // (silent push launching the app in the background).
        CapgoNotificationsPlugin.didReceiveRemoteNotification(userInfo, fetchCompletionHandler: completionHandler)
    }
    
    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits. Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later. If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
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
}
