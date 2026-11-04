import Foundation

/// A Node program this app runs and talks to by lines (the PC agent, the core on this computer): stdin stays
/// open (closing it asks the program to stop), stdout and stderr come back one line at a time on the main actor.
final class ChildProcess: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var outBuffer = Data()
    private var errBuffer = Data()
    private let lock = NSLock()

    var onLine: (@MainActor (String) -> Void)?
    var onErrorLine: (@MainActor (String) -> Void)?
    var onExit: (@MainActor (Int32) -> Void)?

    init(executable: URL, arguments: [String], environment: [String: String], directory: URL?) {
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = directory
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
    }

    func start() throws {
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in self?.take(handle.availableData, error: false) }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in self?.take(handle.availableData, error: true) }
        process.terminationHandler = { [weak self] child in
            let code = child.terminationStatus
            self?.output.fileHandleForReading.readabilityHandler = nil
            self?.errors.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in self?.onExit?(code) }
        }
        try process.run()
    }

    private func take(_ data: Data, error: Bool) {
        guard !data.isEmpty else { return }
        var lines: [String] = []
        lock.withLock {
            if error { errBuffer.append(data) } else { outBuffer.append(data) }
            while true {
                let buffer = error ? errBuffer : outBuffer
                guard let end = buffer.firstIndex(of: 0x0A) else { break }
                let line = String(decoding: buffer[buffer.startIndex..<end], as: UTF8.self).trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
                let rest = Data(buffer[buffer.index(after: end)...])
                if error { errBuffer = rest } else { outBuffer = rest }
                lines.append(line)
            }
        }
        guard !lines.isEmpty else { return }
        Task { @MainActor in
            for line in lines { if error { self.onErrorLine?(line) } else { self.onLine?(line) } }
        }
    }

    func write(_ line: String) {
        try? input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
    }

    func closeInput() {
        try? input.fileHandleForWriting.close()
    }

    var running: Bool { process.isRunning }

    func terminate() {
        if process.isRunning { process.terminate() }
    }

    /// Closes stdin, waits up to `seconds` for the program to end, then terminates it.
    func stop(within seconds: Double) async {
        closeInput()
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning, Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
        if process.isRunning {
            process.terminate()
            try? await Task.sleep(nanoseconds: 500_000_000)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

/// Where node is: the one inside Mimi.app, else the first on the usual paths (an app started from the Dock has
/// a bare PATH, so Homebrew's folders are tried too).
public enum NodeLocator {
    public static func find(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment, exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> URL? {
        if let bundled = bundle.resourceURL?.appendingPathComponent("node/bin/node"), exists(bundled.path) { return bundled }
        let path = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for dir in path + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let candidate = (dir as NSString).appendingPathComponent("node")
            if exists(candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    /// `relative` inside the app's resources (a packaged build), else in the repository above `start` (a build from the sources).
    public static func source(_ relative: String, bundle: Bundle = .main, start: URL = URL(fileURLWithPath: #filePath), exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> (entry: URL, root: URL)? {
        if let resources = bundle.resourceURL {
            let packaged = resources.appendingPathComponent("mimi").appendingPathComponent(relative)
            if exists(packaged.path) { return (packaged, resources.appendingPathComponent("mimi")) }
        }
        var dir = start.deletingLastPathComponent()
        while dir.path != "/" {
            let candidate = dir.appendingPathComponent(relative)
            if exists(candidate.path) { return (candidate, dir) }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }
}
