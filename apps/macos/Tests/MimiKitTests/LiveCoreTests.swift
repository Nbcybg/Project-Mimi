import Foundation
import Testing
@testable import MimiKit

/// Against a real core on this computer (the real URLSession HTTP and WebSocket, no fakes): sign in with its
/// token, connect, start the direct chat with an agent, send, and see the answer stream in and get stored.
/// Skipped unless MIMI_MAC_TEST_CORE (e.g. http://127.0.0.1:8790) and MIMI_MAC_TEST_TOKEN are set — the core
/// needs an agent and an LLM that answers (apps/windows/tests/tools/mock-llm.cjs does).
@MainActor
struct LiveCoreTests {
    nonisolated static let core = ProcessInfo.processInfo.environment["MIMI_MAC_TEST_CORE"] ?? ""
    nonisolated static let token = ProcessInfo.processInfo.environment["MIMI_MAC_TEST_TOKEN"] ?? ""

    @Test(.enabled(if: !core.isEmpty && !token.isEmpty))
    func signInChatAndStreamAgainstARealCore() async throws {
        let connect = ConnectModel()
        var signed: SignedIn?
        connect.done = { signed = $0 }
        connect.serverText = Self.core
        await connect.check()
        #expect(connect.step == .token, "\(connect.error)")
        #expect(connect.health.api >= 2)
        connect.token = "wrong-token-0123456789"
        await connect.signIn()
        #expect(signed == nil)
        connect.token = Self.token
        await connect.signIn()
        let signedIn = try #require(signed)

        let session = MimiSession(appVersion: "test")
        session.begin(server: signedIn.server, token: signedIn.token, username: "", gateway: false, coreApi: signedIn.health.api)
        await waitFor("online") { session.state.isOnline }
        await waitFor("agents") { !session.agents.isEmpty }
        let list = ChatListModel(session: session)
        let chat = ChatModel(session: session)
        var opened: Int64?
        list.openRequested = { id in
            opened = id
            chat.open(id)
        }
        list.newChat(session.defaultAgent.isEmpty ? session.agents.keys.sorted()[0] : session.defaultAgent)
        await waitFor("the chat") { opened != nil }
        if chat.chatId == 0, let opened { chat.open(opened) }
        await waitFor("history") { chat.timeline.loaded }

        let stamp = "ทดสอบจากแอป Mac \(Int(Date().timeIntervalSince1970))"
        chat.draft = stamp
        chat.send()
        await waitFor("my message stored", seconds: 30) { chat.timeline.messages.contains { $0.role == "user" && $0.text == stamp } }
        await waitFor("the answer stored", seconds: 60) {
            !chat.busy && chat.timeline.messages.contains { $0.role == "assistant" && $0.text.contains(stamp) }
        }
        let answer = chat.items.compactMap { item -> String? in
            if case .message(_, _, false, _, let text, _, _, _, _, _, _, _, _, _) = item { return text }
            return nil
        }.last ?? ""
        #expect(answer.contains("streaming"))
        #expect(chat.timeline.live == nil, "the streamed bubble gave way to the stored message")
        chat.close()
        session.end()
        #expect(session.state == .idle)
    }

    private func waitFor(_ what: String, seconds: Double = 15, _ check: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if check() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        Issue.record("never: \(what)")
    }
}
