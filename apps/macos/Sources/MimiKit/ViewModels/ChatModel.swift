import Foundation
import Observation

public struct FileItem: Equatable, Sendable {
    public var name: String
    public var mime: String
    public var kind: String
    public var path: String
    public var caption: String
    public var gone: Bool
    public var size: Int64

    public var isImage: Bool { kind == "image" && !gone }
}

public struct ToolRow: Equatable, Sendable {
    public var name: String
    public var arg: String
    public var risk: String?
    public var ok: Bool?
    public var output: String

    public var mark: String { ok == true ? "✓" : ok == false ? "✗" : "…" }
}

public enum LivePart: Equatable, Sendable {
    case text(String)
    case tool(ToolRow)
    case file(FileItem)
}

/// One row of the conversation, ready to show.
public enum ChatItem: Equatable, Identifiable, Sendable {
    case message(key: String, id: Int64, isUser: Bool, who: String, text: String, mood: String?, files: [FileItem], tools: String, time: String,
                 approval: ApprovalView?, quote: String?, forwarded: String?, reactions: [String], pinned: Bool)
    case pending(key: String, text: String, files: String, failed: String?)
    case live(key: String, who: String, parts: [LivePart], helper: String?, finished: Bool)
    case note(key: String, text: String, bad: Bool)
    case permission(key: String, request: PermissionRequest, who: String, detail: String)
    case task(key: String, id: String, goal: String, status: String, steps: String, summary: String)

    public var id: String {
        switch self {
        case .message(let key, _, _, _, _, _, _, _, _, _, _, _, _, _), .pending(let key, _, _, _), .live(let key, _, _, _, _),
             .note(let key, _, _), .permission(let key, _, _, _), .task(let key, _, _, _, _, _):
            return key
        }
    }
}

/// One open chat: the timeline folded from the socket's frames, turned into rows, and what the person does
/// there — send, stop, older messages, answer permission cards, approve (ChatViewModel.cs of the Windows app).
@MainActor
@Observable
public final class ChatModel {
    public static let love = "❤️"
    public static let quickReactions = ["❤️", "👍", "😂", "😮", "😢", "🙏"]

    @ObservationIgnored private let session: MimiSession
    @ObservationIgnored private var sent = 0

    public private(set) var timeline = ChatTimeline(chatId: 0)
    public private(set) var items: [ChatItem] = []
    public private(set) var chatId: Int64 = 0
    public var draft = ""
    public private(set) var staged: [AttachmentView] = []
    public private(set) var uploading = false
    public var error = ""
    public var replying: (id: Int64, who: String, text: String)?
    /// Bumped when rows are added at the bottom or the answer streams: the screen scrolls down.
    public private(set) var grew = 0
    /// "sent", "done" or "permission": the app plays its chat sounds (media.md 6).
    @ObservationIgnored public var sound: ((String) -> Void)?

    public init(session: MimiSession) {
        self.session = session
        session.listen { [weak self] frame in self?.onFrame(frame) }
        session.listenState { [weak self] state in
            // Back online: catch up with what happened while the socket was gone (realtime.md 7.3).
            guard let self, state.isOnline, chatId != 0 else { return }
            reopen()
        }
    }

    public var busy: Bool { timeline.busy }
    public var hasMore: Bool { timeline.hasMore }
    public var olderSession: Bool { timeline.loaded && !timeline.latest }
    public var canSend: Bool { !uploading && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !staged.isEmpty) }
    public var status: String { timeline.transcribing ? "กำลังถอดเสียง…" : timeline.viewing ? "AI กำลังดูรูป…" : "" }
    public var pins: [PinView] { timeline.pins }

    public var title: String {
        guard let chat = timeline.chat ?? session.chats.first(where: { $0.id == chatId }) else { return "" }
        return session.chatTitle(chat)
    }

    public var chat: ChatView? { timeline.chat ?? session.chats.first(where: { $0.id == chatId }) }

    /// Opens a chat: its newest session, or `sessionId` (a search hit, a pin of another session).
    public func open(_ id: Int64, sessionId: Int64? = nil) {
        if chatId == id, timeline.loaded, timeline.latest, sessionId == nil { return }
        let same = chatId == id
        chatId = id
        timeline = ChatTimeline(chatId: id, busy: session.busyChats.contains(id), pins: same ? timeline.pins : [])
        if !same {
            staged = []
            draft = ""
            replying = nil
        }
        error = ""
        render()
        session.send(ClientFrames.chatOpen(id, sessionId: sessionId))
        visible(true)
    }

    public func backToLatest() {
        if chatId != 0 { open(chatId, sessionId: nil) }
    }

    public func close() {
        visible(false)
        chatId = 0
        timeline = ChatTimeline(chatId: 0)
        items = []
        replying = nil
    }

    /// Whether the person looks at this chat: the core sends no notification for a chat someone is looking at.
    public func visible(_ on: Bool) {
        session.send(ClientFrames.presence(chatId: on && chatId != 0 ? chatId : nil, visible: on && chatId != 0))
    }

    private func reopen() {
        if session.coreApi >= 1, let sessionId = timeline.session?.id, let last = timeline.lastMessageId {
            session.send(ClientFrames.chatOpen(chatId, sessionId: sessionId, afterId: last))
        } else {
            session.send(ClientFrames.chatOpen(chatId))
        }
        visible(true)
    }

    private func onFrame(_ frame: ServerFrame) {
        guard chatId != 0 else { return }
        let before = timeline
        timeline = timeline.reduce(frame)
        switch frame {
        case .chatChanged(let id, _) where id == chatId && !timeline.busy:
            reopen()
        case .busy(let id?, true) where id == chatId:
            // A core before api 1 has no chat-turn-messages: the stored answer comes with chat-open.
            if session.coreApi < 1 { reopen() }
            if before.busy { sound?("done") }
        case .chatEvent(_, _, _, .permission) where timeline.permissions.count > before.permissions.count:
            sound?("permission")
        case .error(let message, _, _, nil, let requestType) where ["chat-send", "message-pin", "message-react"].contains(requestType ?? ""):
            error = message
        default:
            break
        }
        if timeline != before { render(before) }
    }

    private static let clock: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "HH:mm"
        return format
    }()

    private func file(_ attachment: AttachmentView) -> FileItem {
        FileItem(name: attachment.name, mime: attachment.mime, kind: attachment.kind, path: MimiAPI.filePath(attachment.id),
                 caption: attachment.caption.isEmpty ? attachment.text : attachment.caption, gone: attachment.deletedAt != nil, size: attachment.size)
    }

    private func who(_ role: String, _ agent: String) -> String { role == "user" ? "คุณ" : session.agentName(agent) }

    private func render(_ before: ChatTimeline? = nil) {
        var rows: [ChatItem] = []
        for message in timeline.messages {
            let user = message.role == "user"
            let parsed = user ? (text: message.text, speech: nil) : Speech.parse(message.text)
            let quote = message.replyTo.map { quoted in
                "\(who(quoted.role, quoted.agent)): \(quoted.text.isEmpty ? "(ไฟล์)" : MessageFormat.preview(Speech.parse(quoted.text).text, max: 140))"
            }
            rows.append(.message(
                key: "m:\(message.id)", id: message.id, isUser: user, who: who(message.role, message.agent),
                text: parsed.text.trimmingCharacters(in: .whitespacesAndNewlines), mood: (message.speech ?? parsed.speech)?.emotion,
                files: message.files.map(file), tools: message.tools.map { $0.summary.isEmpty ? $0.name : "\($0.name): \($0.summary)" }.joined(separator: " · "),
                time: ChatListModel.date(message.createdAt).map(Self.clock.string(from:)) ?? "", approval: message.approval, quote: quote,
                forwarded: message.forwardedFromName.map { "↪ ส่งต่อจาก \($0)\(message.forwardedFromChat.isEmpty ? "" : " · \(message.forwardedFromChat)")" },
                reactions: message.reactions, pinned: message.pinned))
        }
        for pending in timeline.pending {
            rows.append(.pending(key: "p:\(pending.clientId)", text: pending.text, files: pending.attachmentNames.joined(separator: ", "), failed: pending.failed))
        }
        let bubbles = timeline.earlier + (timeline.live.map { [$0] } ?? [])
        for (index, bubble) in bubbles.enumerated() {
            let parts: [LivePart] = bubble.segments.compactMap { segment in
                switch segment {
                case .text(let raw):
                    let shown = Speech.parse(raw, live: true).text
                    return shown.isEmpty ? nil : .text(shown)
                case .tool(_, let name, let arg, let risk, let ok, let output): return .tool(ToolRow(name: name, arg: arg, risk: risk, ok: ok, output: output))
                case .file(let attachment): return .file(file(attachment))
                }
            }
            rows.append(.live(key: "live:\(index)", who: session.agentName(bubble.agent), parts: parts, helper: bubble.helper.map(session.agentName), finished: bubble.finished))
        }
        for (index, note) in timeline.notes.enumerated() { rows.append(.note(key: "n:\(index)", text: note.text, bad: note.bad)) }
        for request in timeline.permissions {
            rows.append(.permission(key: "perm:\(request.id)", request: request, who: session.agentName(request.agent),
                                    detail: "\(request.tool) (\(request.risk)) \(ChatTimeline.preview(of: request.input))"))
        }
        for task in timeline.tasks {
            let steps = task.task["steps"].array.map { step in "\(step["status"].str == "done" ? "✓" : "•") \(step["title"].string ?? step["name"].str)" }
            rows.append(.task(key: "task:\(task.id)", id: task.id, goal: task.task["goal"].string ?? task.task["title"].str, status: task.status,
                              steps: steps.joined(separator: "\n"), summary: task.task["receipt"]["summary"].str))
        }
        let grewNow = rows.count > items.count || timeline.live != nil
        items = rows
        if grewNow { grew += 1 }
    }

    public func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !staged.isEmpty), chatId != 0, !uploading else { return }
        sent += 1
        let clientId = "m-\(UInt64(Date().timeIntervalSince1970 * 1000) & 0xFFFFFFF)-\(sent)"
        let files = staged
        // The message goes into the newest session: show that one, then send.
        if !timeline.latest { open(chatId) }
        timeline = timeline.adding(PendingMessage(clientId: clientId, text: text, attachmentNames: files.map(\.name), failed: nil))
        session.send(ClientFrames.chatSend(chatId, text: text, attachments: files.map(\.id), clientId: clientId, replyTo: replying?.id))
        draft = ""
        replying = nil
        staged = []
        sound?("sent")
        render()
    }

    public func stop() {
        if chatId != 0 { session.send(ClientFrames.abort(chatId)) }
    }

    public func loadOlder() {
        guard let first = timeline.messages.first else { return }
        session.send(ClientFrames.chatOpen(chatId, sessionId: timeline.session?.id, beforeId: first.id))
    }

    /// The answer to a permission card: scope once | task | session | always.
    public func answer(_ requestId: String, allow: Bool, scope: String = "once") {
        session.send(ClientFrames.permissionResponse(requestId, allow: allow, scope: scope))
    }

    public func approve(_ approvalId: Int64, _ approved: Bool) {
        session.send(ClientFrames.approvalDecide(approvalId, approved: approved))
    }

    public func react(_ messageId: Int64, _ emoji: String) { session.send(ClientFrames.messageReact(messageId, emoji: emoji)) }
    public func pin(_ messageId: Int64, _ pinned: Bool) { session.send(ClientFrames.messagePin(messageId, pinned: pinned)) }

    public func reply(to messageId: Int64) {
        guard let message = timeline.messages.first(where: { $0.id == messageId }) else { return }
        replying = (messageId, who(message.role, message.agent), Speech.parse(message.text).text)
    }

    /// Uploads a file to send with the next message (≤ 25 MB).
    public func attach(_ data: Data, name: String, mime: String, caption: String? = nil) async {
        guard data.count <= 25 * 1024 * 1024 else {
            error = "\(name) ใหญ่เกิน 25 MB"
            return
        }
        error = ""
        uploading = true
        defer { uploading = false }
        do {
            staged.append(try await session.api.upload(data, name: name, mime: mime, caption: caption))
        } catch {
            self.error = "ส่งไฟล์ \(name) ไม่ได้: \(error.localizedDescription)"
        }
    }

    public func unstage(_ id: String) { staged.removeAll { $0.id == id } }

    /// In a group, the members to offer for the "@…" the draft ends with; empty elsewhere.
    public var mentionOptions: [(name: String, shown: String)] {
        guard let chat, chat.kind == "group", let typed = Mentions.typed(draft) else { return [] }
        return Mentions.options(chat.agents.map { ($0, session.agentName($0)) }, typed: typed)
    }

    public func pickMention(_ name: String) { draft = Mentions.apply(draft, name: name) }
}
