import AppKit
import MimiDesktop
import MimiKit
import SwiftUI

/// The native Mac app (Phase 3): a chat window, a menu bar item instead of the Electron tray, the PC agent built in.
@main
struct MimiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("Mimi", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 340, minHeight: 520)
                .tint(Palette.accent)
        }
        .defaultSize(width: 900, height: 760)
        .commands {
            CommandGroup(replacing: .appTermination) {
                Button("ออกจาก Mimi") { Task { await model.quit() } }.keyboardShortcut("q")
            }
        }

        Settings {
            SettingsView()
                .environment(model)
                .tint(Palette.accent)
        }

        MenuBarExtra("Mimi", systemImage: model.session.state.isOnline ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right") {
            MenuBarMenu()
                .environment(model)
        }
    }
}

/// Closing the window keeps Mimi in the menu bar (the Electron tray did the same); Quit is in the menu.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Run from the sources (`swift run`) there is no bundle: still a normal app with a window and a Dock icon.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

enum Palette {
    static let accent = Color(red: 0.898, green: 0.522, blue: 0.639)
    static let accentSoft = Color(red: 0.898, green: 0.522, blue: 0.639).opacity(0.16)
    static let userBubble = Color(red: 0.898, green: 0.522, blue: 0.639).opacity(0.22)
    static let panel = Color(nsColor: .controlBackgroundColor)
}

struct MenuBarMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("เปิด Mimi") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        if model.signedIn {
            Button("เปิดเบราว์เซอร์ของ Mimi") { model.openAgentBrowser() }
            Divider()
            Toggle("ให้ Mimi ใช้เครื่องนี้ (PC agent)", isOn: Binding(get: { model.config.pcAgentEnabled }, set: { on in Task { await model.setPcAgent(on) } }))
            Text("   สถานะ: \(model.config.pcAgentEnabled ? model.pcStatus : "ปิด")")
            Toggle("อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)", isOn: Binding(get: { model.config.pcAgentShell }, set: { on in Task { await model.setShell(on) } }))
            Menu("ออกจากระบบอัตโนมัติ") {
                ForEach(AppConfig.lockChoices, id: \.self) { minutes in
                    Button { model.setAutoLock(minutes) } label: {
                        Text(minutes == 0 ? "ไม่ใช้" : "\(minutes) นาที") + Text(model.config.autoLockMinutes == minutes ? "  ✓" : "")
                    }
                }
            }
        }
        Divider()
        SettingsLink { Text("ตั้งค่า…") }
        if !model.config.server.isEmpty { Button("เปลี่ยนเซิร์ฟเวอร์…") { Task { await model.signOut(changeServer: true) } } }
        if model.signedIn { Button("ออกจากระบบ") { Task { await model.signOut() } } }
        Button("ออกจาก Mimi") { Task { await model.quit() } }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.signedIn {
                MainView()
            } else {
                ConnectView()
            }
        }
        .sheet(item: Binding(get: { model.consent }, set: { if $0 == nil { model.answerConsent(false) } })) { request in
            ConsentSheet(request: request)
        }
    }
}

/// The PC agent asks before it changes something on this computer.
struct ConsentSheet: View {
    @Environment(AppModel.self) private var model
    let request: ConsentRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Mimi ขอใช้เครื่องนี้", systemImage: "exclamationmark.shield").font(.headline)
            Text(request.summary.isEmpty ? request.tool : request.summary)
            Text("\(request.tool) · ความเสี่ยง: \(request.risk)").font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("ไม่อนุญาต") { model.answerConsent(false) }.keyboardShortcut(.cancelAction)
                Button("อนุญาต") { model.answerConsent(true) }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 380)
    }
}
