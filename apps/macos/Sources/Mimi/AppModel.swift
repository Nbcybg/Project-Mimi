import AppKit
import Foundation
import MimiDesktop
import MimiKit
import Observation

/// The whole app's state and life: config, the signed-in session, the PC agent, the core on this computer,
/// notifications and auto-lock — what App.xaml.cs does for the Windows app.
@MainActor
@Observable
final class AppModel {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0-dev"

    let session = MimiSession(appVersion: AppModel.version)
    let connect = ConnectModel()
    let list: ChatListModel
    let chat: ChatModel
    let notifier = Notifier()

    var config: AppConfig
    var signedIn = false
    var selectedChat: Int64?
    var pcStatus = "ปิด"
    var consent: ConsentRequest?
    var localStarting = false
    var banner = ""

    @ObservationIgnored private let configFile = AppConfig.folder().appendingPathComponent("config.json")
    @ObservationIgnored private let vault = SessionVault()
    @ObservationIgnored private var current: SavedSession?
    @ObservationIgnored private var pc: PcAgentHost!
    @ObservationIgnored private let localCore = LocalCore()
    @ObservationIgnored private var lockTimer: Timer?
    @ObservationIgnored private var caughtUp = false

    init() {
        config = AppConfig.read(AppConfig.folder().appendingPathComponent("config.json"))
        list = ChatListModel(session: session)
        chat = ChatModel(session: session)
        pc = PcAgentHost { [weak self] in self?.pcLaunch() }
        pc.onStatus = { [weak self] status in self?.pcStatus = status }
        pc.onConsent = { [weak self] request in
            self?.consent = request
            NSApp.activate(ignoringOtherApps: true)
        }
        connect.canUseLocal = LocalCore.find() != nil
        connect.done = { [weak self] signed in self?.onSignedIn(signed) }
        list.openRequested = { [weak self] id in self?.open(id) }
        notifier.opened = { [weak self] chatId in
            NSApp.activate(ignoringOtherApps: true)
            if let chatId { self?.open(chatId) }
        }
        session.listen { [weak self] frame in self?.onFrame(frame) }
        session.listenState { [weak self] state in self?.onState(state) }
        localCore.onEnded = { [weak self] code in self?.banner = "เซิร์ฟเวอร์ในเครื่องนี้หยุดไป (รหัส \(code))" }
        watchLock()
        Task { await start() }
    }

    private func save() {
        try? config.write(configFile)
    }

    // ---------- start, sign-in, sign-out ----------

    private func start() async {
        notifier.setUp()
        if config.localServer, let launch = LocalCore.find() {
            // The core this app runs comes up with the app, and its own token signs in.
            localStarting = true
            defer { localStarting = false }
            if let ready = try? await localCore.start(launch) {
                connect.serverText = ready.address
                await connect.check()
                if connect.step == .token {
                    connect.token = ready.token
                    await connect.signIn()
                    return
                }
            }
        }
        guard !config.server.isEmpty else { return }
        if let saved = vault.load(server: config.server) {
            begin(saved)
        } else {
            await connect.resume(config.server)
        }
    }

    func useLocalServer() async {
        guard let launch = LocalCore.find() else { return }
        localStarting = true
        defer { localStarting = false }
        await connect.useLocal {
            let ready = try await self.localCore.start(launch)
            return (ready.address, ready.token)
        }
        if signedIn {
            config.localServer = true
            save()
        }
    }

    private func onSignedIn(_ signed: SignedIn) {
        config.server = signed.server
        save()
        let saved = SavedSession(server: signed.server, token: signed.token, username: signed.username, gateway: signed.gateway)
        if signed.remember { vault.store(saved) } else { vault.clear() }
        begin(saved, coreApi: signed.health.api)
    }

    private func begin(_ saved: SavedSession, coreApi: Int = 0) {
        current = saved
        caughtUp = false
        session.begin(server: saved.server, token: saved.token, username: saved.username, gateway: saved.gateway, coreApi: coreApi)
        signedIn = true
    }

    /// Ends this device's session and forgets what was kept for it (config.json stays).
    func signOut(_ reason: String = "logout", changeServer: Bool = false) async {
        guard let was = current else { return }
        current = nil
        await pc.stop()
        if config.localServer {
            config.localServer = false
            await localCore.stop()
        }
        if was.gateway { await session.api.logout(was.token) }
        chat.close()
        session.end()
        vault.clear()
        selectedChat = nil
        signedIn = false
        if reason == "locked" { notifier.show(title: "Mimi ออกจากระบบแล้ว", body: "ไม่ได้ใช้งานนานเกินเวลาที่ตั้งไว้ เข้าสู่ระบบใหม่เพื่อใช้ต่อ", chatId: nil) }
        if reason == "expired" { notifier.show(title: "Mimi ออกจากระบบแล้ว", body: "การเข้าสู่ระบบหมดอายุหรือถูกยกเลิก เข้าสู่ระบบใหม่เพื่อใช้ต่อ", chatId: nil) }
        connect.back()
        if changeServer {
            config.server = ""
            connect.serverText = ""
        }
        save()
        if !changeServer, !config.server.isEmpty { await connect.resume(config.server) }
    }

    func quit() async {
        await pc.stop()
        // Closing its stdin stops the core this app started (a Mimi that was already running stays).
        await localCore.stop()
        NSApp.terminate(nil)
    }

    // ---------- the socket ----------

    private func onState(_ state: SocketState) {
        switch state {
        case .signedOut where current != nil:
            Task { await signOut("expired") }
        case .online:
            Task { await catchUp() }
            if config.pcAgentEnabled { pc.start() }
        default:
            break
        }
    }

    private func onFrame(_ frame: ServerFrame) {
        switch frame {
        case .notification(let kind, let title, let body, let chatId, let id) where kind != "info":
            if let id, id > config.lastNotificationId {
                config.lastNotificationId = id
                save()
            }
            // Not for the chat the person is looking at.
            if !(NSApp.isActive && selectedChat == chatId) { notifier.show(title: title, body: MessageFormat.preview(body, max: 300), chatId: chatId) }
        case .securityAlert:
            notifier.show(title: "Mimi: มีการเข้าสู่ระบบใหม่", body: "บัญชีนี้เพิ่งเข้าสู่ระบบจากอุปกรณ์อื่น ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่าน", chatId: nil)
        default:
            break
        }
    }

    /// What came while the socket was gone; the very first time only remembers where things stand.
    private func catchUp() async {
        guard !caughtUp else { return }
        caughtUp = true
        do {
            let first = config.lastNotificationId == 0
            let items = try await session.api.notifications(after: config.lastNotificationId)
            for item in items where !first && !item.read && item.kind != "info" {
                notifier.show(title: item.title, body: MessageFormat.preview(item.body, max: 300), chatId: item.chatId)
            }
            if let newest = items.map(\.id).max() {
                config.lastNotificationId = max(config.lastNotificationId, newest)
                save()
            }
        } catch {
            caughtUp = false
        }
    }

    // ---------- chats ----------

    func open(_ id: Int64) {
        selectedChat = id
        chat.open(id)
    }

    // ---------- the PC agent (Q7: built into the app) ----------

    private func pcLaunch() -> PcAgentHost.Launch? {
        guard let current, let node = NodeLocator.find(), let source = NodeLocator.source("packages/pc-agent/src/main.ts"),
              let ws = ServerAddress.webSocketURL(current.server) else { return nil }
        let usable = config.pcAgentFolders.filter { AppConfig.folderProblem($0) == nil }
        guard !usable.isEmpty else { return nil }
        for dir in usable { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }
        let env = PcAgentHost.agentEnvironment(coreWsUrl: ws.absoluteString, folders: usable, apps: config.pcAgentApps, shell: config.pcAgentShell,
                                               browserProfile: AgentBrowser.profile(server: current.server, username: current.username),
                                               current: ProcessInfo.processInfo.environment)
        return PcAgentHost.Launch(node: node, entry: source.entry, token: current.token, environment: env)
    }

    func setPcAgent(_ on: Bool) async {
        config.pcAgentEnabled = on
        save()
        if on, signedIn { pc.start() } else { await pc.stop() }
    }

    func setShell(_ on: Bool) async {
        config.pcAgentShell = on
        save()
        await restartAgent()
    }

    func addFolder(_ url: URL) async -> String? {
        if let problem = AppConfig.folderProblem(url.path) { return problem }
        if !config.pcAgentFolders.contains(url.path) { config.pcAgentFolders.append(url.path) }
        save()
        await restartAgent()
        return nil
    }

    func removeFolder(_ path: String) async {
        config.pcAgentFolders.removeAll { $0 == path }
        save()
        await restartAgent()
    }

    private func restartAgent() async {
        guard pc.running else { return }
        await pc.stop()
        if config.pcAgentEnabled, signedIn { pc.start() }
    }

    func answerConsent(_ allow: Bool) {
        guard let request = consent else { return }
        pc.answer(request.id, allow: allow)
        consent = nil
    }

    /// "เปิดเบราว์เซอร์ของ Mimi": the agent's own profile, to sign in to sites by hand.
    func openAgentBrowser() {
        guard let current else { return }
        guard let browser = AgentBrowser.find() else {
            banner = "ไม่พบ Edge หรือ Chrome บนเครื่องนี้ (หรือตั้ง MIMI_BROWSER_PATH)"
            return
        }
        let profile = AgentBrowser.profile(server: current.server, username: current.username)
        try? FileManager.default.createDirectory(atPath: profile, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: browser)
        process.arguments = AgentBrowser.arguments(profile: profile)
        do { try process.run() } catch { banner = "เปิดเบราว์เซอร์ของ Mimi ไม่ได้: \(error.localizedDescription)" }
    }

    func openWeb() {
        if let server = session.server, let url = URL(string: server) { NSWorkspace.shared.open(url) }
    }

    // ---------- auto-lock (remote.cjs: idle time or the screen locking) ----------

    func setAutoLock(_ minutes: Int) {
        config.autoLockMinutes = minutes
        save()
    }

    private func watchLock() {
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.current != nil, self.config.autoLockMinutes > 0 else { return }
                await self.signOut("locked")
            }
        }
        lockTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.current != nil, self.config.autoLockMinutes > 0 else { return }
                let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
                if idle >= Double(self.config.autoLockMinutes * 60) { await self.signOut("locked") }
            }
        }
    }
}
