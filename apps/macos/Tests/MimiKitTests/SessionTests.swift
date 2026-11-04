import Foundation
import Testing
@testable import MimiKit

/// A WebSocket that never touches the network: the test feeds what the core "sends" and reads what the app sent.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [(String?, Int?)] = []
    private var waiter: CheckedContinuation<(text: String?, closeCode: Int?), Never>?
    private(set) var sent: [String] = []
    private(set) var connectedTo: URL?

    func connect(_ url: URL) async throws { lock.withLock { connectedTo = url } }

    func send(_ text: String) async throws { lock.withLock { sent.append(text) } }

    func receive() async -> (text: String?, closeCode: Int?) {
        await withCheckedContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let next = inbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: (next.0, next.1))
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func push(_ text: String?, close: Int? = nil) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: (text, close))
        } else {
            inbox.append((text, close))
            lock.unlock()
        }
    }

    func abort() {}

    var sentTypes: [String] { lock.withLock { sent.compactMap { try? JSON(parsing: $0)["type"].string } } }
}

/// Answers HTTP like a core or gateway would.
struct FakeServer: HTTPTransport {
    let answer: @Sendable (URLRequest) -> (Int, JSON)

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = answer(request)
        return (Data(body.text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
func eventually(_ what: String, _ check: () -> Bool) async {
    for _ in 0..<200 {
        if check() { return }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    Issue.record("never: \(what)")
}

@MainActor
struct SessionTests {
    static let welcome = #"{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"ui":{},"api":2,"minClientApi":1}"#

    @Test func helloGoesFirstFramesWaitForWelcomeAndTheChatListLoads() async {
        let fake = FakeSocket()
        let session = MimiSession(appVersion: "1.0", transport: FakeServer { _ in (200, [:]) }, connect: { fake })
        session.send(ClientFrames.simple("search")) // before welcome: waits
        session.begin(server: "https://mimi.example.com", token: "tok-123456789012345678", username: "", gateway: false, coreApi: 0)
        await eventually("hello") { fake.sentTypes == ["hello"] }
        #expect(fake.connectedTo?.absoluteString == "wss://mimi.example.com/ws")
        fake.push(Self.welcome)
        await eventually("online") { session.state.isOnline }
        await eventually("the queued frame and the lists") { Set(fake.sentTypes) == ["hello", "search", "agents-list", "chats-list"] }
        #expect(session.agentName("mimi") == "มิมิ")
        #expect(session.coreApi == 2)
        fake.push(#"{"type":"chats","chats":[{"id":4,"kind":"direct","agents":["mimi"],"preview":"สวัสดี","lastMessageAt":"2026-11-03T02:00:00Z","unread":true}]}"#)
        await eventually("chats") { session.chats.count == 1 }
        let list = ChatListModel(session: session)
        #expect(list.rows.map(\.title) == ["มิมิ"])
        #expect(list.rows.first?.unread == true)
        session.end()
    }

    @Test func aDeadTokenSignsOutAndIsNeverRetried() async {
        let fake = FakeSocket()
        var made = 0
        let session = MimiSession(appVersion: "1.0", transport: FakeServer { _ in (200, [:]) }, connect: {
            made += 1
            return fake
        })
        session.begin(server: "https://mimi.example.com", token: "tok-123456789012345678", username: "", gateway: false, coreApi: 0)
        await eventually("hello") { fake.sentTypes == ["hello"] }
        fake.push(nil, close: CloseCodes.invalidToken)
        await eventually("signed out") { session.state == .signedOut }
        try? await Task.sleep(nanoseconds: 1_300_000_000)
        #expect(made == 1)
    }

    @Test func aChatOpensSendsAndStreams() async {
        let fake = FakeSocket()
        let session = MimiSession(appVersion: "1.0", transport: FakeServer { _ in (200, [:]) }, connect: { fake })
        session.begin(server: "https://mimi.example.com", token: "tok-123456789012345678", username: "", gateway: false, coreApi: 0)
        fake.push(Self.welcome)
        await eventually("online") { session.state.isOnline }
        let chat = ChatModel(session: session)
        chat.open(4)
        await eventually("chat-open") { fake.sentTypes.contains("chat-open") }
        fake.push(#"{"type":"chat-history","chat":{"id":4,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":4},"sessions":[{"id":1,"chatId":4}],"messages":[{"id":1,"role":"assistant","agent":"mimi","text":"[emotion: ยิ้ม]\nสวัสดีค่ะ"}],"hasMore":false}"#)
        await eventually("history") { chat.items.count == 1 }
        if case .message(_, _, let isUser, let who, let text, let mood, _, _, _, _, _, _, _, _) = chat.items[0] {
            #expect(!isUser)
            #expect(who == "มิมิ")
            #expect(text == "สวัสดีค่ะ")
            #expect(mood == "ยิ้ม")
        } else {
            Issue.record("not a message row")
        }
        chat.draft = "ทดสอบ"
        #expect(chat.canSend)
        chat.send()
        #expect(chat.draft.isEmpty)
        if case .pending(_, let text, _, _) = chat.items.last { #expect(text == "ทดสอบ") } else { Issue.record("no pending row") }
        await eventually("chat-send") { fake.sentTypes.contains("chat-send") }
        fake.push(#"{"type":"chat-event","chatId":4,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"กำลัง"}}"#)
        await eventually("the live row") {
            if case .live(_, _, let parts, _, _) = chat.items.last { return parts == [.text("กำลัง")] }
            return false
        }
        chat.close()
        session.end()
    }
}

@MainActor
struct ConnectTests {
    @Test func aSingleCoreAsksForItsTokenAndAWrongOneIsRefused() async {
        let server = FakeServer { request in
            switch request.url!.path {
            case "/health": return (200, ["ok": true, "version": "0.8.1", "api": 2, "minClientApi": 1])
            case "/api/widget": return request.value(forHTTPHeaderField: "Authorization") == "Bearer right-token" ? (200, ["chats": []]) : (401, ["error": "no"])
            default: return (404, [:])
            }
        }
        let connect = ConnectModel(transport: server)
        var signedIn: SignedIn?
        connect.done = { signedIn = $0 }
        connect.serverText = "http://localhost:8787"
        await connect.check()
        #expect(connect.step == .token)
        connect.token = "wrong"
        await connect.signIn()
        #expect(connect.error.contains("ไม่ถูกต้อง"))
        connect.token = "right-token"
        await connect.signIn()
        #expect(signedIn?.server == "http://localhost:8787")
        #expect(signedIn?.gateway == false)
        #expect(connect.token.isEmpty, "the token is not kept on the screen")
    }

    @Test func theGatewayAsksForTheCodeWhenTheAccountHasTwoFactor() async {
        let server = FakeServer { request in
            switch request.url!.path {
            case "/health": return (200, ["ok": true, "api": 2, "minClientApi": 1, "accounts": true])
            case "/auth/login":
                let body = (try? JSON(data: request.httpBody ?? Data())) ?? .null
                if body["code"].string == "123456" { return (200, ["token": "session-token", "username": "alice"]) }
                return (401, ["error": "Enter the code from your authenticator app.", "twoFactor": true])
            default: return (404, [:])
            }
        }
        let connect = ConnectModel(transport: server)
        var signedIn: SignedIn?
        connect.done = { signedIn = $0 }
        connect.serverText = "mimi.example.com"
        await connect.check()
        #expect(connect.step == .credentials)
        connect.username = "alice"
        connect.password = "pw"
        await connect.signIn()
        #expect(connect.needsCode)
        connect.code = "123456"
        await connect.signIn()
        #expect(signedIn?.token == "session-token")
        #expect(signedIn?.gateway == true)
        #expect(connect.password.isEmpty, "the password is gone after sign-in")
    }

    @Test func aServerThatNeedsANewerAppSaysSo() async {
        let connect = ConnectModel(transport: FakeServer { _ in (200, ["ok": true, "version": "9.0", "api": 9, "minClientApi": 9]) })
        connect.serverText = "mimi.example.com"
        await connect.check()
        #expect(connect.step == .server)
        #expect(connect.error.contains("อัปเดต"))
    }
}
