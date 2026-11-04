import Foundation
import Testing
@testable import MimiKit

struct TextAndAddressTests {
    @Test func aDirectionLineIsTakenOffAndHeldBackWhileItStreams() {
        let parsed = Speech.parse("[emotion: ดีใจ][speed: 3]\nสวัสดีค่ะ")
        #expect(parsed.text == "สวัสดีค่ะ")
        #expect(parsed.speech == SpeechStyle(emotion: "ดีใจ", speed: 2.0))
        #expect(Speech.parse("[emotion: ดีใจ", live: true).text == "")
        #expect(Speech.parse("[link: x]\nข้อความ").text == "[link: x]\nข้อความ", "not a direction line")
        #expect(Speech.parse("ธรรมดา").speech == nil)
    }

    @Test func messagesAreCutIntoBlocksAndSpansLikeTheWeb() {
        #expect(MessageFormat.blocks("ก่อน\n```js\nlet x = 1\n```\nหลัง") == [.paragraph([.plain("ก่อน")]), .code("let x = 1"), .paragraph([.plain("หลัง")])])
        #expect(MessageFormat.spans("**หนา** *ยิ้ม* `x` https://a.example/b @mimi") == [
            .bold("หนา"), .plain(" "), .action("ยิ้ม"), .plain(" "), .code("x"), .plain(" "), .link("https://a.example/b"), .plain(" "), .mention("@mimi"),
        ])
        // Counted in whole characters: a Thai vowel mark is never cut from its letter (ตั is one).
        #expect(MessageFormat.preview("[emotion: x]\n**ตัวหนา**\n\nบรรทัด", max: 9) == "ตัวหนา บรร…")
    }

    @Test func serverAddressesAreOriginsHttpsUnlessLocal() throws {
        #expect(try ServerAddress.normalize(" mimi.example.com/chat ") == "https://mimi.example.com")
        #expect(try ServerAddress.normalize("http://localhost:8787") == "http://localhost:8787")
        #expect(try ServerAddress.normalize("https://Mimi.Example.com:443") == "https://mimi.example.com")
        #expect(throws: ServerAddress.Problem.self) { try ServerAddress.normalize("http://mimi.example.com") }
        #expect(throws: ServerAddress.Problem.self) { try ServerAddress.normalize("https://a:b@mimi.example.com") }
        #expect(throws: ServerAddress.Problem.self) { try ServerAddress.normalize("") }
        #expect(ServerAddress.webSocketURL("https://mimi.example.com")?.absoluteString == "wss://mimi.example.com/ws")
        #expect(ServerAddress.webSocketURL("http://127.0.0.1:8787")?.absoluteString == "ws://127.0.0.1:8787/ws")
    }

    @Test func listDatesAreTimeTodayAndThaiMonthsBefore() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Bangkok")!
        let now = ChatListModel.date("2026-11-03T10:00:00.000Z")!
        #expect(ChatListModel.when("2026-11-03T02:05:00.000Z", now: now, calendar: calendar) == "09:05")
        #expect(ChatListModel.when("2026-01-15T02:05:00Z", now: now, calendar: calendar) == "15 ม.ค.")
        #expect(ChatListModel.when(nil, now: now) == "")
    }
}

struct MentionTests {
    @Test func aMentionIsOfferedWhileTheTextEndsInAnAtWord() {
        #expect(Mentions.typed("hey @mi") == "mi")
        #expect(Mentions.typed("ถามหน่อย @โน") == "โน")
        #expect(Mentions.typed("mail@mi") == nil)
        #expect(Mentions.typed("@mi there") == nil)
        let members = [(name: "mimi", shown: "มิมิ"), (name: "milo", shown: "Milo"), (name: "nora", shown: "โนร่า")]
        #expect(Mentions.options(members, typed: "MI").map(\.name) == ["mimi", "milo"])
        #expect(Mentions.options(members, typed: "โน").map(\.name) == ["nora"])
        #expect(Mentions.apply("hey @mi", name: "mimi") == "hey @mimi ")
    }
}
