import Foundation
import Capacitor
import UIKit
import UserNotifications

enum CapgoNotificationError: Error {
    case tokenParsingFailed
}

enum CapgoNotificationsPermissions: String {
    case prompt
    case denied
    case granted
}

extension Notification.Name {
    static let capgoNotificationsRemoteNotification = Notification.Name("CapgoNotificationsRemoteNotification")
}

@objc(CapgoNotificationsPlugin)
public class CapgoNotificationsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapgoNotificationsPlugin"
    public let jsName = "CapgoNotifications"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregisterPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNativeInstallId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAppInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createDefaultChannel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createChannel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listChannels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteChannel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeliveredNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeDeliveredNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAllDeliveredNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeBackgroundNotification", returnType: CAPPluginReturnPromise)
    ]

    private let notificationDelegateHandler = CapgoNotificationsHandler()
    private let installIdKey = "capgo.notifications.nativeInstallId"

    private static let pendingLock = NSLock()
    private static weak var loadedInstance: CapgoNotificationsPlugin?
    private static var pendingRemoteNotifications: [([AnyHashable: Any], ((UIBackgroundFetchResult) -> Void)?)] = []

    /// Forward `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` here.
    /// Unlike the NotificationCenter forward, pushes that arrive before the bridge has
    /// loaded this plugin (cold background launch) are kept and handled on load.
    public static func didReceiveRemoteNotification(_ userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: ((UIBackgroundFetchResult) -> Void)? = nil) {
        pendingLock.lock()
        guard let instance = loadedInstance else {
            pendingRemoteNotifications.append((userInfo, completionHandler))
            pendingLock.unlock()
            return
        }
        pendingLock.unlock()
        DispatchQueue.main.async {
            instance.notificationDelegateHandler.handleRemoteNotification(userInfo, completionHandler: completionHandler)
        }
    }

    override public func load() {
        self.bridge?.notificationRouter.pushNotificationHandler = self.notificationDelegateHandler
        self.notificationDelegateHandler.plugin = self

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(self.didRegisterForRemoteNotificationsWithDeviceToken(notification:)),
                                               name: .capacitorDidRegisterForRemoteNotifications,
                                               object: nil)

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(self.didFailToRegisterForRemoteNotificationsWithError(notification:)),
                                               name: .capacitorDidFailToRegisterForRemoteNotifications,
                                               object: nil)

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(self.didReceiveRemoteNotification(notification:)),
                                               name: .capgoNotificationsRemoteNotification,
                                               object: nil)

        CapgoNotificationsPlugin.pendingLock.lock()
        CapgoNotificationsPlugin.loadedInstance = self
        let pending = CapgoNotificationsPlugin.pendingRemoteNotifications
        CapgoNotificationsPlugin.pendingRemoteNotifications = []
        CapgoNotificationsPlugin.pendingLock.unlock()
        // Let the bridge finish loading the remaining plugins (the updater) first.
        DispatchQueue.main.async {
            pending.forEach { userInfo, completionHandler in
                self.notificationDelegateHandler.handleRemoteNotification(userInfo, completionHandler: completionHandler)
            }
        }
    }

    /// Ask @capgo/capacitor-updater to run its native update pipeline now. The updater
    /// applies the bundle with its own install policy (next background, direct update).
    /// Called through the Objective-C runtime so the updater stays an optional dependency.
    /// Returns the updater status (`queued`, `already_running`, `unavailable`,
    /// `preview_session`) or `unsupported` when the updater cannot be triggered natively.
    func triggerNativeUpdateCheck() -> String {
        guard let updater = self.bridge?.plugin(withName: "CapacitorUpdater") else {
            return "unsupported"
        }
        let selector = NSSelectorFromString("triggerUpdateCheck:")
        guard updater.responds(to: selector) else {
            return "unsupported"
        }
        var status = "failed"
        let call = CAPPluginCall(callbackId: "capgo-notifications-update-check",
                                 methodName: "triggerUpdateCheck",
                                 options: [:],
                                 success: { result, _ in
                                    status = result?.data?["status"] as? String ?? "queued"
                                 },
                                 error: { _ in
                                    status = "failed"
                                 })
        let invoke = { _ = updater.perform(selector, with: call) }
        if Thread.isMainThread {
            invoke()
        } else {
            DispatchQueue.main.sync(execute: invoke)
        }
        return status
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func registerPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
        call.resolve()
    }

    @objc func unregisterPush(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
            call.resolve()
        }
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        self.notificationDelegateHandler.requestPermissions { granted, error in
            guard error == nil else {
                call.reject(error?.localizedDescription ?? "unknown error in permissions request")
                return
            }
            call.resolve(["receive": granted ? CapgoNotificationsPermissions.granted.rawValue : CapgoNotificationsPermissions.denied.rawValue])
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        self.notificationDelegateHandler.checkPermissions { status in
            var result: CapgoNotificationsPermissions = .prompt
            switch status {
            case .notDetermined:
                result = .prompt
            case .denied:
                result = .denied
            case .ephemeral, .authorized, .provisional:
                result = .granted
            @unknown default:
                result = .prompt
            }
            call.resolve(["receive": result.rawValue])
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(0, call.getInt("count") ?? 0)
        setBadgeCount(count) { error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            call.resolve(["count": count])
        }
    }

    @objc func clearBadge(_ call: CAPPluginCall) {
        setBadgeCount(0) { error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            call.resolve(["count": 0])
        }
    }

    @objc func getBadge(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["count": UIApplication.shared.applicationIconBadgeNumber])
        }
    }

    @objc func getNativeInstallId(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        if let installId = defaults.string(forKey: installIdKey), !installId.isEmpty {
            call.resolve(["nativeInstallId": installId])
            return
        }
        let installId = UUID().uuidString
        defaults.set(installId, forKey: installIdKey)
        call.resolve(["nativeInstallId": installId])
    }

    @objc func getAppInfo(_ call: CAPPluginCall) {
        let bundle = Bundle.main
        call.resolve([
            "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "",
            "id": bundle.bundleIdentifier ?? ""
        ])
    }

    @objc func getDeliveredNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getDeliveredNotifications(completionHandler: { notifications in
            let ret = notifications.map({ notification -> [String: Any] in
                return self.notificationDelegateHandler.makeNotificationRequestJSObject(notification.request)
            })
            call.resolve(["notifications": ret])
        })
    }

    @objc func removeDeliveredNotifications(_ call: CAPPluginCall) {
        guard let notifications = call.getArray("notifications", JSObject.self) else {
            call.reject("Must supply notifications to remove")
            return
        }
        let ids = notifications.map { $0["id"] as? String ?? "" }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        call.resolve()
    }

    @objc func removeAllDeliveredNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        setBadgeCount(0) { _ in
            call.resolve()
        }
    }

    @objc func completeBackgroundNotification(_ call: CAPPluginCall) {
        let resultValue = call.getString("result") ?? "newData"
        let result: UIBackgroundFetchResult
        switch resultValue {
        case "failed":
            result = .failed
        case "noData":
            result = .noData
        default:
            result = .newData
        }
        let completed = self.notificationDelegateHandler.completeBackgroundNotification(call.getString("backgroundTaskId"), result: result)
        call.resolve(["completed": completed])
    }

    @objc func createDefaultChannel(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func createChannel(_ call: CAPPluginCall) {
        call.unimplemented("Not available on iOS")
    }

    @objc func deleteChannel(_ call: CAPPluginCall) {
        call.unimplemented("Not available on iOS")
    }

    @objc func listChannels(_ call: CAPPluginCall) {
        call.resolve(["channels": []])
    }

    @objc public func didRegisterForRemoteNotificationsWithDeviceToken(notification: NSNotification) {
        if let deviceToken = notification.object as? Data {
            let deviceTokenString = deviceToken.reduce("", { $0 + String(format: "%02X", $1) })
            notifyListeners("registration", data: ["value": deviceTokenString], retainUntilConsumed: true)
        } else if let stringToken = notification.object as? String {
            notifyListeners("registration", data: ["value": stringToken], retainUntilConsumed: true)
        } else {
            notifyListeners("registrationError", data: ["error": CapgoNotificationError.tokenParsingFailed.localizedDescription], retainUntilConsumed: true)
        }
    }

    @objc public func didFailToRegisterForRemoteNotificationsWithError(notification: NSNotification) {
        guard let error = notification.object as? Error else { return }
        notifyListeners("registrationError", data: ["error": error.localizedDescription], retainUntilConsumed: true)
    }

    @objc public func didReceiveRemoteNotification(notification: NSNotification) {
        let payload = notification.userInfo?["userInfo"] as? [AnyHashable: Any]
        let directPayload = notification.object as? [AnyHashable: Any]
        guard let userInfo = payload ?? directPayload else { return }
        let completionHandler = notification.userInfo?["completionHandler"] as? ((UIBackgroundFetchResult) -> Void)
        self.notificationDelegateHandler.handleRemoteNotification(userInfo, completionHandler: completionHandler)
    }

    private func setBadgeCount(_ count: Int, completion: @escaping (Error?) -> Void) {
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(count) { error in
                    completion(error)
                }
            } else {
                UIApplication.shared.applicationIconBadgeNumber = count
                completion(nil)
            }
        }
    }
}
