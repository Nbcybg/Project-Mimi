import Foundation
import UserNotifications

/// macOS notifications (push-and-background.md: the menu-bar app listens on the socket while it runs, and
/// catches up from `/api/notifications?afterId=` after a reconnect). A click opens the chat. Only inside
/// Mimi.app: a bare `swift run` binary has no bundle, and the notification center refuses it.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private var ready = false
    var opened: ((Int64?) -> Void)?

    func setUp() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in self.ready = granted }
        }
    }

    func show(title: String, body: String, chatId: Int64?) {
        guard ready else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let chatId {
            content.userInfo = ["chat": chatId]
            content.threadIdentifier = "chat-\(chatId)"
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let chat = (response.notification.request.content.userInfo["chat"] as? NSNumber)?.int64Value
        await MainActor.run { opened?(chat) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
