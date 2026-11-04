import Foundation
import Testing
@testable import MimiKit

/// Frames as a core sent them (recorded from a local core, docs/native/realtime.md 4.2) — the same cases
/// as the Windows (ChatTimelineTests.cs) and Android apps.
struct ChatTimelineTests {
    static let turn = [
        #"{"type":"busy","chatId":1}"#,
        #"{"type":"chat-session","chatId":1,"session":{"id":1,"chatId":1,"title":"","summary":"","auto":true,"createdAt":"x","lastMessageAt":"x","readAt":"x","unread":false},"started":true}"#,
        #"{"type":"chat-message","chatId":1,"sessionId":1,"message":{"id":1,"role":"user","agent":"","text":"สวัสดี","createdAt":"x","attachments":[],"tools":[],"replyTo":null,"forwardedFrom":null,"clientId":"c-1"}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-start","traceId":"t","agent":"mimi","model":"mock/m1","userMessageId":1}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"สวัสดี"}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"ค่ะ "}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-call","call":{"id":"k1","name":"web_search","input":{"q":"x"}},"risk":"read"}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-result","result":{"callId":"k1","name":"web_search","ok":true,"output":"found"}}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"**ทดสอบ**"}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"usage","round":1,"usage":{"inputTokens":1,"outputTokens":1,"cachedTokens":0,"costUsd":0}}}"#,
        #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-finish","traceId":"t","reason":"stop","rounds":1,"usage":{},"contextTokens":1,"text":"**ทดสอบ**","speech":{"emotion":"ยินดี"}}}"#,
    ]

    static func fold(_ state: ChatTimeline, _ frames: [String]) -> ChatTimeline {
        frames.reduce(state) { $0.reduce(FrameParser.parse($1)) }
    }

    static func withSession(_ chatId: Int64, _ sessionId: Int64) -> ChatTimeline {
        var state = ChatTimeline(chatId: chatId)
        state.session = SessionView(json: ["id": .int(sessionId), "chatId": .int(chatId)])
        return state
    }

    @Test func aStreamedTurnBecomesABubbleWithToolsThenTheStoredMessagesReplaceIt() {
        var state = Self.fold(ChatTimeline(chatId: 1).adding(PendingMessage(clientId: "c-1", text: "สวัสดี", attachmentNames: [], failed: nil)), Self.turn)
        #expect(state.busy)
        #expect(state.pending.isEmpty)
        #expect(state.messages.map(\.id) == [1])
        let live = state.live!
        #expect(live.agent == "mimi")
        #expect(live.finished)
        #expect(live.speech?.emotion == "ยินดี")
        #expect(live.segments.count == 3)
        #expect(live.segments[0] == .text("สวัสดีค่ะ "))
        if case .tool(_, let name, let arg, _, let ok, let output) = live.segments[1] {
            #expect(name == "web_search")
            #expect(arg == #"{"q":"x"}"#)
            #expect(ok == true)
            #expect(output == "found")
        } else {
            Issue.record("the second part is not the tool")
        }
        #expect(live.segments[2] == .text("**ทดสอบ**"))

        state = Self.fold(state, [
            #"{"type":"chat-turn-messages","chatId":1,"sessionId":1,"afterId":1,"messages":[{"id":2,"role":"assistant","agent":"mimi","text":"**ทดสอบ**","speech":{"emotion":"ยินดี"},"createdAt":"x","attachments":[],"tools":[{"name":"web_search","summary":"x"}]}]}"#,
            #"{"type":"busy","chatId":1,"done":true}"#,
        ])
        #expect(state.live == nil)
        #expect(state.messages.map(\.id) == [1, 2])
        #expect(!state.busy)
    }

    @Test func framesOfAnotherChatOrAnOlderSessionChangeNothing() {
        let start = Self.withSession(1, 5)
        #expect(start.reduce(FrameParser.parse(#"{"type":"chat-event","chatId":2,"sessionId":9,"agent":"a","event":{"type":"text-delta","text":"x"}}"#)) == start)
        #expect(start.reduce(FrameParser.parse(#"{"type":"chat-event","chatId":1,"sessionId":4,"agent":"a","event":{"type":"text-delta","text":"x"}}"#)) == start)
    }

    @Test func aFailedSendMarksThePendingBubbleAndATurnErrorBecomesANote() {
        var state = ChatTimeline(chatId: 1).adding(PendingMessage(clientId: "c-9", text: "x", attachmentNames: [], failed: nil))
        state = state.reduce(FrameParser.parse(#"{"type":"error","message":"Chat #1 does not exist.","code":"E-CONFIG","clientId":"c-9","requestType":"chat-send"}"#))
        #expect(state.pending.map(\.failed) == ["Chat #1 does not exist."])
        state = state.reduce(FrameParser.parse(#"{"type":"error","message":"rate","code":"E-RATE-429","chatId":1}"#))
        #expect(state.notes.map(\.text) == ["[E-RATE-429] rate"])
    }

    @Test func afterIdAddsOnlyNewerMessagesAndAnOlderPageGoesInFront() {
        var state = ChatTimeline(chatId: 1).reduce(FrameParser.parse(#"{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":5,"role":"user","text":"a"},{"id":6,"role":"assistant","text":"b"}],"hasMore":true}"#))
        state = state.reduce(FrameParser.parse(#"{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":7,"role":"user","text":"c"}],"hasMore":false,"afterId":6}"#))
        #expect(state.messages.map(\.id) == [5, 6, 7])
        state = state.reduce(FrameParser.parse(#"{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":3,"role":"user","text":"z"}],"hasMore":false,"beforeId":5}"#))
        #expect(state.messages.map(\.id) == [3, 5, 6, 7])
        #expect(!state.hasMore)
    }

    @Test func aHandoffKeepsTheFirstAnswerUntilTheTurnsMessagesCome() {
        let state = Self.fold(Self.withSession(1, 1), [
            #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-start","agent":"a","model":"m"}}"#,
            #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"text-delta","text":"ส่งต่อนะ"}}"#,
            #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-finish","reason":"handoff","text":"ส่งต่อนะ","handoff":{"messageId":3,"to":"b"}}}"#,
            #"{"type":"chat-event","chatId":1,"sessionId":1,"agent":"b","event":{"type":"run-start","agent":"b","model":"m"}}"#,
        ])
        #expect(state.earlier.map(\.agent) == ["a"])
        #expect(state.live?.agent == "b")
        #expect(state.notes.map(\.text) == ["↪ ส่งต่อให้ b"])
    }

    @Test func permissionRequestsAlsoFromASubAgentWaitUntilResolved() {
        var state = ChatTimeline(chatId: 1).reduce(FrameParser.parse(#"{"type":"chat-event","chatId":1,"sessionId":0,"agent":"a","event":{"type":"agent-activity","agent":"helper","messageId":1,"event":{"type":"permission-request","request":{"id":"p1","traceId":"t","agent":"helper","tool":"write_file","risk":"write","input":{"path":"x"},"summary":"เขียนไฟล์","timeoutMs":900000,"createdAt":"x"}}}}"#))
        #expect(state.permissions.map(\.tool) == ["write_file"])
        state = state.reduce(FrameParser.parse(#"{"type":"permission-resolved","requestId":"p1","decision":{"allow":true,"via":"user"}}"#))
        #expect(state.permissions.isEmpty)
    }

    @Test func unknownOrBrokenFramesNeverThrow() {
        #expect(FrameParser.parse("not json") == .unknown(""))
        #expect(FrameParser.parse(#"{"type":"future-thing","x":1}"#) == .unknown("future-thing"))
        #expect(FrameParser.parse(#"{"type":"chat-message","chatId":1}"#) == .unknown("chat-message"))
        // A server older than api 2 still sends Mimiamp commands; this app has no player and skips them.
        #expect(FrameParser.parse(#"{"type":"mimiamp","command":{"action":"play","query":"x"}}"#) == .unknown("mimiamp"))
        guard case .welcome(let welcome) = FrameParser.parse(#"{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[3],"pendingPermissions":[],"ui":{"mimi.theme":"light"},"api":1,"minClientApi":1,"version":"0.8.1"}"#) else {
            Issue.record("no welcome")
            return
        }
        #expect(welcome.api == 1)
        #expect(welcome.busyChats == [3])
        #expect(welcome.agents.first?.shownName == "มิมิ")
        #expect(welcome.ui == ["mimi.theme": "light"])
    }

    @Test func clientFramesHaveTheShapeTheCoreExpects() throws {
        let hello = try JSON(parsing: ClientFrames.hello(token: "t", appVersion: "1.0"))
        #expect(hello == ["type": "hello", "role": "client", "token": "t", "name": "macos", "client": ["platform": "macos", "version": "1.0", "api": 2]])
        #expect(try JSON(parsing: ClientFrames.presence(chatId: nil, visible: false)) == ["type": "presence", "chatId": nil, "visible": false])
        #expect(try JSON(parsing: ClientFrames.chatSend(2, text: "ไฟล์", attachments: ["a"], clientId: "c")) == ["type": "chat-send", "chatId": 2, "text": "ไฟล์", "attachments": ["a"], "clientId": "c"])
        #expect(try JSON(parsing: ClientFrames.permissionResponse("p", allow: false)) == ["type": "permission-response", "requestId": "p", "allow": false])
        #expect(try JSON(parsing: ClientFrames.chatOpen(4, sessionId: 2, afterId: 9)) == ["type": "chat-open", "chatId": 4, "sessionId": 2, "afterId": 9])
        #expect(ClientFrames.chatSend(2, text: "ไทย", attachments: [], clientId: nil).contains("ไทย"), "Thai stays as it is")
    }
}
