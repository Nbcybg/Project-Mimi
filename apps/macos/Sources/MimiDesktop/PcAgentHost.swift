import Foundation
import MimiKit

/// A question of the PC agent before it changes something on this computer (MIMI_CONSENT_STDIO).
public struct ConsentRequest: Equatable, Sendable, Identifiable {
    public var id: String
    public var tool: String
    public var risk: String
    public var summary: String
}

/// The PC agent built into the app (Q7): packages/pc-agent runs with node, started, stopped and watched by the
/// app, as the Windows app (PcAgentHost.cs) and the Electron app (remote.cjs startPcAgent) do. The token goes in
/// through stdin, never the environment; closing stdin stops the agent. The agent asks for consent on stdout
/// lines that start with `@@mimi-consent@@` and gets the answer back as a JSON line on stdin.
@MainActor
public final class PcAgentHost {
    public nonisolated static let consentPrefix = "@@mimi-consent@@"

    /// What to run: node and the agent's main.ts, with the token and the environment.
    public struct Launch: Sendable {
        public var node: URL
        public var entry: URL
        public var token: String
        public var environment: [String: String]

        public init(node: URL, entry: URL, token: String, environment: [String: String]) {
            self.node = node
            self.entry = entry
            self.token = token
            self.environment = environment
        }
    }

    private let launch: @MainActor () -> Launch?
    private var child: ChildProcess?
    private var stopping = false
    private var retry: TimeInterval = 2
    private var restartGeneration = 0

    public private(set) var status = "ปิด" {
        didSet { onStatus?(status) }
    }

    public var running: Bool { child != nil }
    public var onStatus: ((String) -> Void)?
    /// Answer with `answer(_:allow:)`; no answer is a "no" once the agent gives up.
    public var onConsent: ((ConsentRequest) -> Void)?

    public init(launch: @escaping @MainActor () -> Launch?) {
        self.launch = launch
    }

    /// The variables the agent runs with: only what a shell needs, plus where to connect (remote.cjs).
    public nonisolated static func agentEnvironment(coreWsUrl: String, folders: [String], apps: [String], shell: Bool, browserProfile: String,
                                                    current: [String: String]) -> [String: String] {
        var env: [String: String] = [:]
        for name in ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL"] {
            if let value = current[name] { env[name] = value }
        }
        // Started from the Dock, PATH is only the system's: the tools people install (git, Homebrew) are added.
        let path = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        env["PATH"] = (path + ["/opt/homebrew/bin", "/usr/local/bin"].filter { !path.contains($0) }).joined(separator: ":")
        env["MIMI_TOKEN_STDIN"] = "1"
        env["MIMI_CONSENT_STDIO"] = "1"
        env["MIMI_PC_SHELL"] = shell ? "1" : "0"
        env["MIMI_CORE_URL"] = coreWsUrl
        env["ALLOWED_DIRS"] = folders.joined(separator: ";")
        env["MIMI_ALLOWED_APPS"] = apps.joined(separator: ";")
        env["MIMI_BROWSER_PROFILE"] = browserProfile
        env["MIMI_PC_NAME"] = "\(NSUserName())@\(Host.current().localizedName ?? "Mac")"
        return env
    }

    /// What one line of the agent's output means for its status; nil = nothing to show.
    public nonisolated static func status(of line: String) -> String? {
        if line.contains("connected to ") && !line.contains("disconnected") { return "เชื่อมต่อแล้ว" }
        if line.contains("rejected the token") { return "เซิร์ฟเวอร์ไม่รับ" }
        if line.contains("disconnected") { return "หลุด กำลังต่อใหม่…" }
        return nil
    }

    public nonisolated static func parseConsent(_ line: String) -> ConsentRequest? {
        guard line.hasPrefix(consentPrefix), let json = try? JSON(parsing: String(line.dropFirst(consentPrefix.count))), let id = json["id"].string else { return nil }
        // A malformed line can only be a bug; no action is safer than a guess.
        return ConsentRequest(id: id, tool: json["tool"].str, risk: json["risk"].str, summary: json["summary"].str)
    }

    public func start() {
        guard child == nil else { return }
        restartGeneration += 1
        stopping = false
        guard let what = launch() else {
            status = "ไม่มีโฟลเดอร์ที่ใช้ได้"
            return
        }
        let process = ChildProcess(executable: what.node, arguments: [what.entry.path], environment: what.environment, directory: what.entry.deletingLastPathComponent())
        process.onLine = { [weak self] line in
            guard let self else { return }
            if let request = Self.parseConsent(line) {
                onConsent?(request)
            } else if let next = Self.status(of: line) {
                if next == "เชื่อมต่อแล้ว" { retry = 2 }
                status = next
            }
        }
        process.onErrorLine = { [weak self] line in
            if let next = Self.status(of: line) { self?.status = next }
        }
        process.onExit = { [weak self, weak process] _ in
            guard let self, let process, self.child === process else { return }
            self.exited()
        }
        do {
            try process.start()
        } catch {
            status = "เริ่มไม่ได้: \(error.localizedDescription)"
            return
        }
        child = process
        status = "กำลังเชื่อมต่อ…"
        // stdin stays open: closing it stops the agent.
        process.write(what.token)
    }

    private func exited() {
        child = nil
        guard !stopping else {
            status = "ปิด"
            return
        }
        let wait = retry
        retry = min(retry * 2, 60)
        status = "หยุดไป กำลังเริ่มใหม่…"
        let generation = restartGeneration
        Task {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !self.stopping, self.restartGeneration == generation else { return }
            self.start()
        }
    }

    /// The person's answer to a consent question.
    public func answer(_ id: String, allow: Bool) {
        child?.write(ClientFrames.build("consent-response", ["id": .string(id), "allow": .bool(allow)]))
    }

    /// Stops the agent; it closes its browser on the way out (a few seconds at most).
    public func stop() async {
        stopping = true
        restartGeneration += 1
        guard let process = child else {
            status = "ปิด"
            return
        }
        child = nil
        await process.stop(within: 4)
        status = "ปิด"
    }
}
