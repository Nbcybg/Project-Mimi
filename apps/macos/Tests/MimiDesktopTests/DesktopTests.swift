import Foundation
import Testing
@testable import MimiDesktop

struct DesktopTests {
    @Test func theAgentsLinesAreReadAsStatusAndConsentQuestions() {
        #expect(PcAgentHost.status(of: "pc-agent: connected to ws://127.0.0.1:8787/ws") == "เชื่อมต่อแล้ว")
        #expect(PcAgentHost.status(of: "pc-agent: disconnected (1006)") == "หลุด กำลังต่อใหม่…")
        #expect(PcAgentHost.status(of: "the core rejected the token") == "เซิร์ฟเวอร์ไม่รับ")
        #expect(PcAgentHost.status(of: "anything else") == nil)
        let question = PcAgentHost.parseConsent(#"@@mimi-consent@@{"id":"c1","tool":"delete_path","risk":"destructive","summary":"ลบไฟล์ a.txt"}"#)
        #expect(question == ConsentRequest(id: "c1", tool: "delete_path", risk: "destructive", summary: "ลบไฟล์ a.txt"))
        #expect(PcAgentHost.parseConsent("@@mimi-consent@@{oops") == nil)
        #expect(PcAgentHost.parseConsent(#"{"id":"c1"}"#) == nil)
    }

    @Test func theAgentGetsOnlyWhatItNeedsAndNeverTheToken() {
        let env = PcAgentHost.agentEnvironment(coreWsUrl: "wss://mimi.example.com/ws", folders: ["/Users/x/Documents/Mimi", "/Users/x/Work"], apps: ["Mail"], shell: false,
                                               browserProfile: "/p", current: ["PATH": "/usr/bin:/bin", "HOME": "/Users/x", "MIMI_TOKEN": "secret", "AWS_SECRET_ACCESS_KEY": "k"])
        #expect(env["ALLOWED_DIRS"] == "/Users/x/Documents/Mimi;/Users/x/Work")
        #expect(env["MIMI_TOKEN_STDIN"] == "1")
        #expect(env["MIMI_PC_SHELL"] == "0")
        #expect(env["MIMI_TOKEN"] == nil)
        #expect(env["AWS_SECRET_ACCESS_KEY"] == nil)
        #expect(env["PATH"]?.hasSuffix("/opt/homebrew/bin:/usr/local/bin") == true)
    }

    @Test func foldersMustBeInsideHomeAndNotSystemOnes() {
        let home = "/Users/x"
        #expect(AppConfig.folderProblem("/Users/x/Documents/Mimi", home: home) == nil)
        #expect(AppConfig.folderProblem("/Users/x", home: home) != nil)
        #expect(AppConfig.folderProblem("/Users/x/Library/Keychains", home: home) != nil)
        #expect(AppConfig.folderProblem("/Users/x/.ssh", home: home) != nil)
        #expect(AppConfig.folderProblem("/etc", home: home) != nil)
        #expect(AppConfig.folderProblem("/Users/x/../y/a", home: home) != nil)
        #expect(AppConfig.folderProblem("Documents", home: home) != nil)
    }

    @Test func theConfigKeepsWhatItDoesNotKnow() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mimi-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("config.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"server":"https://a.example","autoLockMinutes":7,"somethingNew":"kept","pcAgent":{"folders":["/Users/x/Work","/etc"],"shell":true}}"#.utf8).write(to: file)
        var config = AppConfig.read(file, home: "/Users/x")
        #expect(config.server == "https://a.example")
        #expect(config.autoLockMinutes == 0, "not one of the choices")
        #expect(config.pcAgentFolders == ["/Users/x/Work"])
        #expect(config.pcAgentShell)
        config.lastNotificationId = 41
        try config.write(file)
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(text.contains(#""somethingNew":"kept""#))
        #expect(AppConfig.read(file, home: "/Users/x").lastNotificationId == 41)
        #expect(AppConfig.read(dir.appendingPathComponent("none.json"), home: "/Users/x").pcAgentFolders == ["/Users/x/Documents/Mimi"])
    }

    @Test func theAgentsBrowserIsEdgeOrChromeWithTheAgentsFlags() {
        #expect(AgentBrowser.find(environment: [:], exists: { $0.contains("Chrome") }) == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        #expect(AgentBrowser.find(environment: [:], exists: { _ in true })?.contains("Edge") == true)
        #expect(AgentBrowser.find(environment: ["MIMI_BROWSER_PATH": "/x/brave"], exists: { _ in false }) == nil)
        #expect(AgentBrowser.arguments(profile: "/p").contains("--user-data-dir=/p"))
        let profile = AgentBrowser.profile(server: "https://mimi.example.com", username: "alice", home: "/Users/x")
        #expect(!profile.contains("alice"))
        #expect(profile == AgentBrowser.profile(server: "https://MIMI.example.com", username: "Alice", home: "/Users/x"))
    }

    @Test func theReadyLineOfTheCoreHost() {
        #expect(LocalCore.parseReady(#"@@mimi-host@@{"port":8787,"token":"t0k","version":"0.8.1"}"#) == LocalCoreReady(port: 8787, token: "t0k", external: false, error: nil))
        #expect(LocalCore.parseReady(#"@@mimi-host@@{"port":8787,"token":"t0k","external":true}"#)?.external == true)
        #expect(LocalCore.parseReady(#"@@mimi-host@@{"error":"EACCES"}"#)?.error == "EACCES")
        #expect(LocalCore.parseReady(#"@@mimi-host@@{"port":0,"token":"x"}"#) == nil)
        #expect(LocalCore.parseReady("Mimi is running") == nil)
    }

    @MainActor
    @Test func aCoreHostStartsAnswersItsAddressAndStopsWhenStdinCloses() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mimi-host-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // Stands in for native-host.ts: says where it listens, then runs until its stdin closes.
        let script = dir.appendingPathComponent("host.sh")
        try Data("echo 'starting'\necho '@@mimi-host@@{\"port\":18787,\"token\":\"local-token\"}'\ncat > /dev/null\necho bye > \"$(dirname \"$0\")/stopped\"\n".utf8).write(to: script)
        let core = LocalCore()
        let ready = try await core.start(LocalCore.Launch(node: URL(fileURLWithPath: "/bin/sh"), entry: script, workingDirectory: dir))
        #expect(ready.address == "http://127.0.0.1:18787")
        #expect(ready.token == "local-token")
        #expect(core.running)
        await core.stop()
        #expect(!core.running)
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped").path), "it ended by itself once stdin closed")
    }
}
