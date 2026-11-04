import Foundation
import MimiKit
import Security

/// What the app keeps in `~/Library/Application Support/Mimi/config.json`: server address, auto-lock and PC agent
/// choices — no personal data and no token. The same fields as the Windows app's config.json (AppConfig.cs),
/// and fields this app does not know are kept as they were.
public struct AppConfig: Equatable, Sendable {
    public static let lockChoices = [0, 5, 15, 30, 60]

    public var server = ""
    public var autoLockMinutes = 0
    public var pcAgentEnabled = true
    public var pcAgentShell = false
    public var pcAgentFolders: [String] = []
    public var pcAgentApps: [String] = []
    /// Seen notification id: the next start shows only newer ones (push-and-background.md 1.2).
    public var lastNotificationId: Int64 = 0
    /// The app runs the core on this computer itself and starts it with the app.
    public var localServer = false
    private var extra: [String: JSON] = [:]

    public init() {}

    /// `MIMI_MACOS_HOME`: a test run with its own folder and keychain item, so a real install is never touched.
    public static var testHome: String? {
        ProcessInfo.processInfo.environment["MIMI_MACOS_HOME"].flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The same folder (and config.json) as the Electron app, so moving from it keeps the choices.
    public static func folder(home: String = NSHomeDirectory()) -> URL {
        if let test = testHome { return URL(fileURLWithPath: test, isDirectory: true) }
        return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/Mimi", isDirectory: true)
    }

    /// The defaults of a first start: one folder for the agent (~/Documents/Mimi), as the Windows app.
    public static func defaults(home: String = NSHomeDirectory()) -> AppConfig {
        var config = AppConfig()
        config.pcAgentFolders = [(home as NSString).appendingPathComponent("Documents/Mimi")]
        return config
    }

    public static func read(_ file: URL, home: String = NSHomeDirectory()) -> AppConfig {
        guard let data = try? Data(contentsOf: file), let json = try? JSON(data: data), let map = json.object else { return defaults(home: home) }
        var config = AppConfig()
        config.extra = map
        config.server = json["server"].str
        config.autoLockMinutes = lockChoices.contains(Int(json["autoLockMinutes"].int ?? 0)) ? Int(json["autoLockMinutes"].int ?? 0) : 0
        let pc = json["pcAgent"]
        config.pcAgentEnabled = pc["enabled"].isNull || pc["enabled"].bool
        config.pcAgentShell = pc["shell"].bool
        config.pcAgentFolders = pc["folders"].array.compactMap(\.string).filter { folderProblem($0, home: home) == nil }
        config.pcAgentApps = pc["apps"].array.compactMap(\.string).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let mine = json["macos"]
        config.lastNotificationId = max(0, mine["lastNotificationId"].int ?? 0)
        config.localServer = mine["localServer"].bool
        return config
    }

    public func write(_ file: URL) throws {
        var map = extra
        map["server"] = .string(server)
        map["autoLockMinutes"] = .number(Double(autoLockMinutes))
        map["pcAgent"] = ["enabled": .bool(pcAgentEnabled), "shell": .bool(pcAgentShell), "folders": .array(pcAgentFolders.map(JSON.string)), "apps": .array(pcAgentApps.map(JSON.string))]
        // This app's own choices live under "macos", which the other apps leave alone.
        map["macos"] = ["lastNotificationId": .int(lastNotificationId), "localServer": .bool(localServer)]
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(JSON.object(map).text.utf8).write(to: file, options: .atomic)
    }

    /// The PC agent may only use folders inside the account's home (and never the home itself, Library, keys).
    public static func folderProblem(_ dir: String, home: String = NSHomeDirectory()) -> String? {
        guard dir.hasPrefix("/") else { return "ต้องเป็นโฟลเดอร์แบบเต็ม (absolute path)" }
        let real = (URL(fileURLWithPath: dir).standardizedFileURL.path as NSString).standardizingPath
        let homeReal = (URL(fileURLWithPath: home).standardizedFileURL.path as NSString).standardizingPath
        if real.caseInsensitiveCompare(homeReal) == .orderedSame { return "เลือกโฟลเดอร์ย่อยในโฮม ไม่ใช่โฮมทั้งหมด" }
        guard real.lowercased().hasPrefix(homeReal.lowercased() + "/") else { return "ต้องอยู่ในโฮมของผู้ใช้เครื่องนี้" }
        let first = String(real.dropFirst(homeReal.count + 1)).split(separator: "/").first.map(String.init) ?? ""
        if ["library", ".ssh", ".gnupg", ".mimi", "appdata"].contains(first.lowercased()) { return "\"\(first)\" เป็นโฟลเดอร์ของระบบ ใช้ไม่ได้" }
        return nil
    }
}

/// The signed-in session: the token never leaves memory or the login keychain (auth-and-session.md 8).
public struct SavedSession: Equatable, Sendable {
    public var server: String
    public var token: String
    public var username: String
    public var gateway: Bool

    public init(server: String, token: String, username: String, gateway: Bool) {
        self.server = server
        self.token = token
        self.username = username
        self.gateway = gateway
    }
}

/// The token in the macOS login keychain (a generic password of this app), only while signed in and only
/// when "remember" is on — the Mac counterpart of the Windows app's DPAPI file.
public struct SessionVault: Sendable {
    public let service: String

    public init(service: String = AppConfig.testHome.map { "app.mimi.macos.session.test:\($0)" } ?? "app.mimi.macos.session") {
        self.service = service
    }

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "session"]
    }

    public func load(server: String) -> SavedSession? {
        var search = query()
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &found) == errSecSuccess, let data = found as? Data, let json = try? JSON(data: data) else { return nil }
        guard json["server"].str == server, let token = json["token"].string, !token.isEmpty else { return nil }
        return SavedSession(server: server, token: token, username: json["username"].str, gateway: json["gateway"].bool)
    }

    @discardableResult
    public func store(_ session: SavedSession) -> Bool {
        clear()
        var item = query()
        item[kSecValueData as String] = Data(JSON.object(["server": .string(session.server), "token": .string(session.token), "username": .string(session.username), "gateway": .bool(session.gateway)]).text.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecAttrLabel as String] = "Mimi"
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    public func clear() {
        SecItemDelete(query() as CFDictionary)
    }
}

/// "เปิดเบราว์เซอร์ของ Mimi" (AgentBrowser.cs): the agent's own browser profile in Edge / Chrome, with the PC agent's
/// flags (packages/pc-agent/src/browser/launcher.ts), so sites can be signed in to by hand and the agent takes the window over.
public enum AgentBrowser {
    public static let candidates = [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]

    public static func find(environment: [String: String] = ProcessInfo.processInfo.environment, exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> String? {
        if let chosen = environment["MIMI_BROWSER_PATH"], !chosen.isEmpty { return exists(chosen) ? chosen : nil }
        return candidates.first(where: exists)
    }

    public static func arguments(profile: String) -> [String] {
        ["--remote-debugging-port=0", "--remote-allow-origins=*", "--user-data-dir=\(profile)", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-size=1280,900", "about:blank"]
    }

    /// The profile of one account on one server, outside the user folder (backups never carry its cookies);
    /// named by a hash so the folder name does not tell whose it is.
    public static func profile(server: String, username: String, home: String = NSHomeDirectory()) -> String {
        let key = "\(server.lowercased())|\(username.lowercased())"
        var hash: UInt64 = 1469598103934665603
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return (home as NSString).appendingPathComponent("Library/Application Support/Mimi/agent-browser/\(String(hash, radix: 16))")
    }
}
