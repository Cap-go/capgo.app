import Capacitor
import UIKit
import UserNotifications
public class CapgoNotificationsHandler: NSObject, NotificationHandlerProtocol {
    public weak var plugin: CAPPlugin?

    private let backgroundCompletionQueue = DispatchQueue(label: "app.capgo.notifications.backgroundCompletion")
    private var backgroundCompletions: [String: (UIBackgroundFetchResult) -> Void] = [:]
    private let backgroundCompletionTimeout: TimeInterval = 25.0

    public func requestPermissions(with completion: ((Bool, Error?) -> Void)? = nil) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            completion?(granted, error)
        }
    }

    public func checkPermissions(with completion: ((UNAuthorizationStatus) -> Void)? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            completion?(settings.authorizationStatus)
        }
    }

    public func completeBackgroundNotification(_ taskId: String?, result: UIBackgroundFetchResult = .newData) -> Bool {
        guard let taskId = taskId else { return false }
        let completion = backgroundCompletionQueue.sync { () -> ((UIBackgroundFetchResult) -> Void)? in
            return self.backgroundCompletions.removeValue(forKey: taskId)
        }
        guard let completion = completion else { return false }
        DispatchQueue.main.async {
            completion(result)
        }
        return true
    }

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        let notificationData = makeNotificationRequestJSObject(notification.request)
        self.plugin?.notifyListeners("notificationReceived", data: notificationData, retainUntilConsumed: true)

        if isCapgoBackgroundPayload(notification.request.content.userInfo) {
            self.plugin?.notifyListeners("backgroundNotification", data: notificationData, retainUntilConsumed: true)
            return UNNotificationPresentationOptions.init(rawValue: 0)
        }

        if let optionsArray = self.plugin?.getConfig().getArray("presentationOptions") as? [String] {
            var presentationOptions = UNNotificationPresentationOptions.init()
            optionsArray.forEach { option in
                switch option {
                case "alert":
                    presentationOptions.insert(.alert)
                case "badge":
                    presentationOptions.insert(.badge)
                case "sound":
                    presentationOptions.insert(.sound)
                default:
                    print("Unrecognized presentation option: (option)")
                }
            }
            return presentationOptions
        }

        return []
    }

    public func didReceive(response: UNNotificationResponse) {
        var data = JSObject()
        let originalNotificationRequest = response.notification.request
        let actionId = response.actionIdentifier

        if actionId == UNNotificationDefaultActionIdentifier {
            data["actionId"] = "tap"
        } else if actionId == UNNotificationDismissActionIdentifier {
            data["actionId"] = "dismiss"
        } else {
            data["actionId"] = actionId
        }

        if let inputType = response as? UNTextInputNotificationResponse {
            data["inputValue"] = inputType.userText
        }

        data["notification"] = makeNotificationRequestJSObject(originalNotificationRequest)
        self.plugin?.notifyListeners("notificationOpened", data: data, retainUntilConsumed: true)
    }

    public func handleRemoteNotification(_ userInfo: [AnyHashable: Any], completionHandler: ((UIBackgroundFetchResult) -> Void)? = nil) {
        let isBackground = isCapgoBackgroundPayload(userInfo)
        var notificationData = makeRemoteNotificationJSObject(userInfo)

        if isBackground, let completionHandler = completionHandler {
            let taskId = UUID().uuidString
            backgroundCompletionQueue.sync {
                self.backgroundCompletions[taskId] = completionHandler
            }
            notificationData["backgroundTaskId"] = taskId
            DispatchQueue.main.asyncAfter(deadline: .now() + backgroundCompletionTimeout) { [weak self] in
                _ = self?.completeBackgroundNotification(taskId, result: .newData)
            }
        }

        self.plugin?.notifyListeners("notificationReceived", data: notificationData, retainUntilConsumed: true)

        if isBackground {
            self.plugin?.notifyListeners("backgroundNotification", data: notificationData, retainUntilConsumed: true)
            return
        }

        guard let completionHandler = completionHandler else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            completionHandler(.noData)
        }
    }

    func makeNotificationRequestJSObject(_ request: UNNotificationRequest) -> JSObject {
        return [
            "id": request.identifier,
            "title": request.content.title,
            "subtitle": request.content.subtitle,
            "badge": request.content.badge ?? 0,
            "body": request.content.body,
            "data": JSTypes.coerceDictionaryToJSObject(request.content.userInfo) ?? [:]
        ]
    }

    private func makeRemoteNotificationJSObject(_ userInfo: [AnyHashable: Any]) -> JSObject {
        let aps = userInfo["aps"] as? [String: Any]
        let alert = aps?["alert"] as? [String: Any]
        return [
            "id": (userInfo["gcm.message_id"] as? String) ?? (userInfo["google.message_id"] as? String) ?? (userInfo["message_id"] as? String) ?? UUID().uuidString,
            "title": alert?["title"] as? String ?? "",
            "subtitle": alert?["subtitle"] as? String ?? "",
            "badge": aps?["badge"] as? Int ?? 0,
            "body": alert?["body"] as? String ?? "",
            "data": JSTypes.coerceDictionaryToJSObject(userInfo) ?? [:]
        ]
    }

    private func isCapgoBackgroundPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        let action = (userInfo["capgoAction"] as? String) ?? (userInfo["capgo_action"] as? String) ?? ""
        return action == "update_check" || action == "capgo_update_check" || action == "background"
    }
}
