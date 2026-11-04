import Foundation
import MimiKit

/// Where the core on this computer listens and its token.
public struct LocalCoreReady: Equatable, Sendable {
    public var port: Int
    public var token: String
    /// A Mimi already ran here (another app of this account): it is used as it is and left running.
    public var external: Bool
    public var error: String?

    public var address: String { "http://127.0.0.1:\(port)" }
}

public struct LocalCoreError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

/// "เซิร์ฟเวอร์ในเครื่องนี้": the app starts the core on this computer itself — packages/core/src/app/native-host.ts,
/// the same host the Windows app uses (LocalCore.cs) — reads its address and token from one stdout line, and
/// stops it by closing its stdin when the app quits.
@MainActor
public final class LocalCore {
    public nonisolated static let mark = "@@mimi-host@@"

    public struct Launch: Sendable {
        public var node: URL
        public var entry: URL
        public var workingDirectory: URL
    }

    private var child: ChildProcess?
    private var waiting: [CheckedContinuation<LocalCoreReady, Error>] = []
    private var ready: LocalCoreReady?

    /// The core stopped by itself (not asked to).
    public var onEnded: ((Int32) -> Void)?

    public init() {}

    public var running: Bool { child != nil }

    /// One line of the host's stdout, read: nil when it is not the ready line.
    public nonisolated static func parseReady(_ line: String) -> LocalCoreReady? {
        guard line.hasPrefix(mark), let json = try? JSON(parsing: String(line.dropFirst(mark.count))) else { return nil }
        if let error = json["error"].string { return LocalCoreReady(port: 0, token: "", external: false, error: error) }
        guard let port = json["port"].int, port > 0, let token = json["token"].string, !token.isEmpty else { return nil }
        return LocalCoreReady(port: Int(port), token: token, external: json["external"].bool, error: nil)
    }

    /// The core inside Mimi.app (Resources/mimi/…), else the repository's; nil when neither is there or there is no node.
    public static func find() -> Launch? {
        guard let node = NodeLocator.find(), let source = NodeLocator.source("packages/core/src/app/native-host.ts") else { return nil }
        return Launch(node: node, entry: source.entry, workingDirectory: source.root)
    }

    /// Starts the core (once) and waits for its address; throws when it cannot start.
    public func start(_ launch: Launch, environment: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 60) async throws -> LocalCoreReady {
        if let ready { return ready }
        if child != nil { return try await withCheckedThrowingContinuation { waiting.append($0) } }
        var arguments: [String] = []
        let env = launch.workingDirectory.appendingPathComponent(".env")
        if FileManager.default.fileExists(atPath: env.path) { arguments.append("--env-file=\(env.path)") }
        arguments.append(launch.entry.path)
        let process = ChildProcess(executable: launch.node, arguments: arguments, environment: environment, directory: launch.workingDirectory)
        var lastError = ""
        process.onLine = { [weak self] line in
            guard let self, let found = Self.parseReady(line) else { return }
            if let error = found.error { self.finish(.failure(LocalCoreError(message: error))) } else { self.finish(.success(found)) }
        }
        process.onErrorLine = { line in if !line.isEmpty { lastError = line } }
        process.onExit = { [weak self, weak process] code in
            guard let self, let process, self.child === process else { return }
            self.child = nil
            if self.ready == nil {
                self.finish(.failure(LocalCoreError(message: lastError.isEmpty ? "core หยุดไปก่อนพร้อม (รหัส \(code))" : lastError)))
            } else if self.ready?.external == false {
                // A host that handed over to a Mimi already running ends at once with 0: that is not a failure.
                self.ready = nil
                self.onEnded?(code)
            }
        }
        do {
            try process.start()
        } catch {
            throw LocalCoreError(message: "เปิด node ไม่ได้: \(error.localizedDescription)")
        }
        child = process
        Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if self.ready == nil, self.child === process {
                self.finish(.failure(LocalCoreError(message: "core ไม่ตอบภายในเวลาที่กำหนด")))
                await self.stop()
            }
        }
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }

    private func finish(_ result: Result<LocalCoreReady, Error>) {
        if case .success(let found) = result { ready = found }
        let all = waiting
        waiting = []
        for continuation in all { continuation.resume(with: result) }
    }

    /// Asks the core to stop (stdin closes) and ends it when it has not gone after a few seconds.
    public func stop() async {
        ready = nil
        guard let process = child else { return }
        child = nil
        await process.stop(within: 6)
    }
}
