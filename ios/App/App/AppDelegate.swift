import UIKit
import Capacitor
import CapacitorUpdaterPlugin

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    private let nativeConfirmedPreviewParam = "nativeConfirmedPreview"
    private let previewBundlePath = "/preview/bundle"
    private let previewChannelPath = "/preview/channel"
    private var previewConfirmationVisible = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        resetUpdaterStateForDebugWebBundle()

        // Override point for customization after application launch.
        if #available(macOS 13.3, iOS 16.4, tvOS 16.4, *) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
                    if let vc = self.window?.rootViewController as? CAPBridgeViewController {
                        vc.bridge?.webView?.isInspectable = true;
                    }
            }
        }
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

    private func handlePreviewURLIfNeeded(_ url: URL, proceed: @escaping (URL) -> Void) -> Bool {
        guard isPreviewDeepLink(url) else {
            return false
        }

        if previewConfirmationVisible {
            return true
        }

        previewConfirmationVisible = true
        DispatchQueue.main.async {
            self.presentPreviewConfirmation(for: url, proceed: proceed)
        }
        return true
    }

    private func presentPreviewConfirmation(for url: URL, proceed: @escaping (URL) -> Void) {
        guard let presenter = topViewController() else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.presentPreviewConfirmation(for: url, proceed: proceed)
            }
            return
        }

        let alert = UIAlertController(title: "Load preview?", message: previewConfirmationMessage(for: url), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "No", style: .cancel) { _ in
            self.previewConfirmationVisible = false
        })
        alert.addAction(UIAlertAction(title: "Load preview", style: .default) { _ in
            self.previewConfirmationVisible = false
            proceed(self.withNativeConfirmedPreview(url))
        })
        presenter.present(alert, animated: true)
    }

    private func topViewController(from viewController: UIViewController? = nil) -> UIViewController? {
        let source = viewController ?? window?.rootViewController
        if let presented = source?.presentedViewController {
            return topViewController(from: presented)
        }
        if let navigationController = source as? UINavigationController {
            return topViewController(from: navigationController.visibleViewController)
        }
        if let tabController = source as? UITabBarController {
            return topViewController(from: tabController.selectedViewController)
        }
        return source
    }

    private func withNativeConfirmedPreview(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }

        var queryItems = components.queryItems ?? []
        if !queryItems.contains(where: { $0.name == nativeConfirmedPreviewParam }) {
            queryItems.append(URLQueryItem(name: nativeConfirmedPreviewParam, value: "1"))
            components.queryItems = queryItems
        }
        return components.url ?? url
    }

    private func isPreviewDeepLink(_ url: URL) -> Bool {
        let path = previewPath(from: url)
        return path == previewBundlePath || path == previewChannelPath
    }

    private func previewPath(from url: URL) -> String {
        if url.scheme == "capgo" {
            let path = "/\(url.host ?? "")\(url.path)"
            return path.replacingOccurrences(of: "/+", with: "/", options: .regularExpression)
        }

        return url.path
    }

    private func previewConfirmationMessage(for url: URL) -> String {
        let appLabel = firstQueryValue(url, names: ["appId", "app"]) ?? "Unknown app"
        return "A preview link wants to load:\n\nApp: \(appLabel)\nTarget: \(previewTargetLabel(for: url))"
    }

    private func previewTargetLabel(for url: URL) -> String {
        if previewPath(from: url) == previewChannelPath {
            if let channel = firstQueryValue(url, names: ["channel", "channelName"]) {
                return "Channel \(channel)"
            }
            return "Channel preview"
        }

        if let version = firstQueryValue(url, names: ["versionId", "bundleId"]) {
            return "Bundle \(version)"
        }
        return "Bundle preview"
    }

    private func firstQueryValue(_ url: URL, names: [String]) -> String? {
        guard let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return nil
        }

        for name in names {
            if let value = queryItems.first(where: { $0.name == name })?.value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ _: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(name: Notification.Name("CapgoNotificationsRemoteNotification"), object: nil, userInfo: [
            "userInfo": userInfo,
            "completionHandler": completionHandler,
        ])
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

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if handlePreviewURLIfNeeded(url, proceed: { confirmedUrl in
            _ = ApplicationDelegateProxy.shared.application(app, open: confirmedUrl, options: options)
        }) {
            return true
        }

        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        if let url = userActivity.webpageURL, handlePreviewURLIfNeeded(url, proceed: { confirmedUrl in
            userActivity.webpageURL = confirmedUrl
            _ = ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
        }) {
            return true
        }

        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
