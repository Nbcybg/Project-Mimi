import Foundation
import Testing
@testable import MimiDesktop

/// The real PC agent (packages/pc-agent with node) started by the app's host against a real core: it takes the
/// token from stdin and reports itself connected. Skipped unless MIMI_MAC_TEST_CORE and MIMI_MAC_TEST_TOKEN are set.
@MainActor
struct LivePcAgentTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["MIMI_MAC_TEST_CORE"] != nil))
    func theBuiltInAgentConnectsWithTheTokenFromStdin() async throws {
        let env = ProcessInfo.processInfo.environment
        let core = try #require(env["MIMI_MAC_TEST_CORE"])
        let token = try #require(env["MIMI_MAC_TEST_TOKEN"])
        let node = try #require(NodeLocator.find())
        let source = try #require(NodeLocator.source("packages/pc-agent/src/main.ts"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mimi-agent-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let ws = core.replacingOccurrences(of: "http://", with: "ws://") + "/ws"
        var statuses: [String] = []
        let host = PcAgentHost {
            PcAgentHost.Launch(node: node, entry: source.entry, token: token,
                               environment: PcAgentHost.agentEnvironment(coreWsUrl: ws, folders: [folder.path], apps: [], shell: false, browserProfile: folder.appendingPathComponent("browser").path, current: env))
        }
        host.onStatus = { statuses.append($0) }
        host.start()
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, host.status != "เชื่อมต่อแล้ว" { try await Task.sleep(nanoseconds: 100_000_000) }
        #expect(host.status == "เชื่อมต่อแล้ว", "statuses: \(statuses)")
        await host.stop()
        #expect(!host.running)
        #expect(host.status == "ปิด")
    }
}
