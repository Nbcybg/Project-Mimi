import Foundation
import Observation

public struct ChatRow: Equatable, Identifiable, Sendable {
    public var id: Int64
    public var title: String
    public var preview: String
    public var when: String
    public var unread: Bool
    public var busy: Bool
    public var group: Bool
    /// Server path of the agent's avatar (with its `?v=`), or nil.
    public var avatar: String?
    public var initial: String
}

/// The list of chats (realtime.md 4): direct and group tabs, unread, typing, and a new chat with an agent.
@MainActor
@Observable
public final class ChatListModel {
    @ObservationIgnored private let session: MimiSession
    @ObservationIgnored private var waitingFor: String?
    @ObservationIgnored private var waitingGroup: [String]?
    /// The screen opens this chat.
    @ObservationIgnored public var openRequested: ((Int64) -> Void)?

    public var showingDirect = true

    public init(session: MimiSession) {
        self.session = session
        session.listen { [weak self] frame in
            guard let self, case .chatHistory(let history) = frame else { return }
            // chat-create answers this socket with the chat's history: open it.
            if let agent = waitingFor, history.chat.agents.contains(agent) {
                waitingFor = nil
                openRequested?(history.chat.id)
            } else if let group = waitingGroup, history.chat.kind == "group", history.chat.agents == group {
                waitingGroup = nil
                showingDirect = false
                openRequested?(history.chat.id)
            }
        }
    }

    public var agents: [AgentView] {
        session.agents.values.sorted { a, b in
            if (a.name == session.defaultAgent) != (b.name == session.defaultAgent) { return a.name == session.defaultAgent }
            return a.shownName.localizedCompare(b.shownName) == .orderedAscending
        }
    }

    public var rows: [ChatRow] {
        let now = Date()
        return session.chats
            .filter { ($0.kind == "group") != showingDirect }
            .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
            .map { chat in
                let agent = chat.agents.first.flatMap { session.agents[$0] }
                let title = session.chatTitle(chat)
                return ChatRow(id: chat.id, title: title, preview: MessageFormat.preview(chat.preview, max: 90), when: Self.when(chat.lastMessageAt, now: now),
                               unread: chat.unread, busy: session.busyChats.contains(chat.id), group: chat.kind == "group",
                               avatar: agent.flatMap { found in found.avatar.map { MimiAPI.agentImagePath(found.name, "avatar", stamp: $0) } },
                               initial: title.first.map { String($0).uppercased() } ?? "?")
            }
    }

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format
    }()

    nonisolated public static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        return iso.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// "HH:mm" today, "d MMM" this year, "d MMM yy" before (Thai month names, as the web shows them).
    nonisolated public static func when(_ text: String?, now: Date, calendar: Calendar = .current) -> String {
        guard let at = date(text) else { return "" }
        let format = DateFormatter()
        format.locale = Locale(identifier: "th_TH")
        format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = calendar.timeZone
        if calendar.isDate(at, inSameDayAs: now) { format.dateFormat = "HH:mm" }
        else if calendar.component(.year, from: at) == calendar.component(.year, from: now) { format.dateFormat = "d MMM" }
        else { format.dateFormat = "d MMM yy" }
        return format.string(from: at)
    }

    /// Starts (or reopens: one direct chat per agent) the chat with an agent.
    public func newChat(_ agent: String) {
        if let existing = session.chats.first(where: { $0.kind == "direct" && $0.agents == [agent] }) {
            openRequested?(existing.id)
            return
        }
        waitingFor = agent
        session.send(ClientFrames.chatCreateDirect(agent))
    }

    /// A group chat: at least two agents, the first answers when nobody is addressed. Returns a problem, or nil.
    public func newGroup(title: String, agents: [String]) -> String? {
        guard agents.count >= 2 else { return "กลุ่มต้องมี agent อย่างน้อย 2 ตัว" }
        waitingGroup = agents
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        session.send(ClientFrames.build("chat-create", ["kind": "group", "agents": .array(agents.map(JSON.string)), "title": trimmed.isEmpty ? .null : .string(trimmed)]))
        return nil
    }
}
