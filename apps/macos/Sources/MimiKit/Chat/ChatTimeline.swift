import Foundation

public struct PendingMessage: Equatable, Sendable {
    public var clientId: String
    public var text: String
    public var attachmentNames: [String]
    public var failed: String?
}

public struct Note: Equatable, Sendable {
    public var text: String
    public var bad: Bool
}

/// A task of this chat as its card shows it (the TaskView JSON, updated by the task events).
public struct TaskCard: Equatable, Sendable {
    public var id: String
    public var task: JSON
    public var status: String { task["status"].str }
}

public enum LiveSegment: Equatable, Sendable {
    case text(String)
    case tool(id: String, name: String, arg: String, risk: String?, ok: Bool?, output: String)
    case file(AttachmentView)
}

public struct LiveBubble: Equatable, Sendable {
    public var agent: String
    public var segments: [LiveSegment] = []
    public var speech: SpeechStyle?
    /// A sub-agent working for this one, shown as a small line.
    public var helper: String?
    public var finished = false

    public init(agent: String) {
        self.agent = agent
    }
}

/// What one open chat looks like, folded from the frames of `/ws` (docs/native/realtime.md 4).
/// Pure data and a pure reducer — the same rules as the Windows (ChatTimeline.cs) and Android apps.
public struct ChatTimeline: Equatable, Sendable {
    public var chatId: Int64
    public var chat: ChatView?
    public var session: SessionView?
    public var messages: [ChatMessageView] = []
    public var hasMore = false
    public var loaded = false
    /// Sent by this device, not yet echoed by the core.
    public var pending: [PendingMessage] = []
    /// The answer streaming in now.
    public var live: LiveBubble?
    /// Answers of this turn that finished before a handoff, until the turn's messages arrive.
    public var earlier: [LiveBubble] = []
    public var permissions: [PermissionRequest] = []
    public var busy = false
    public var transcribing = false
    public var viewing = false
    /// Lines under the conversation: errors, "stopped", handoffs.
    public var notes: [Note] = []
    public var pins: [PinView] = []
    /// False while an older session is on screen: new turns land in the newest one.
    public var latest = true
    public var sessions: [SessionView] = []
    public var tasks: [TaskCard] = []
    public var context: SessionContext?

    public init(chatId: Int64, busy: Bool = false, pins: [PinView] = []) {
        self.chatId = chatId
        self.busy = busy
        self.pins = pins
    }

    public var lastMessageId: Int64? { messages.last?.id }

    public func adding(_ message: PendingMessage) -> ChatTimeline {
        var next = self
        next.pending.append(message)
        return next
    }

    static func merge(_ a: [ChatMessageView], _ b: [ChatMessageView]) -> [ChatMessageView] {
        var byId: [Int64: ChatMessageView] = [:]
        for message in a { byId[message.id] = message }
        for message in b { byId[message.id] = message }
        return byId.values.sorted { $0.id < $1.id }
    }

    static func adding(_ list: [PermissionRequest], _ more: [PermissionRequest]) -> [PermissionRequest] {
        var seen = Set<String>()
        return (list + more).filter { seen.insert($0.id).inserted }
    }

    public static func preview(of input: JSON) -> String {
        let raw: String
        switch input {
        case .null: raw = ""
        case .string(let text): raw = text
        default: raw = input.text
        }
        let flat = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return flat.count > 160 ? String(flat.prefix(160)) + "…" : flat
    }

    public static func bubble(_ live: LiveTurnView) -> LiveBubble {
        var bubble = LiveBubble(agent: live.agent)
        for tool in live.tools { bubble.segments.append(.tool(id: tool.id, name: tool.name, arg: tool.arg, risk: tool.risk, ok: tool.ok, output: tool.output)) }
        for file in live.files { bubble.segments.append(.file(file)) }
        if !live.text.isEmpty { bubble.segments.append(.text(live.text)) }
        bubble.speech = live.speech
        return bubble
    }

    /// True when the frame belongs to this chat's session on screen (an older session's events are ignored).
    private func showing(_ chatId: Int64, _ sessionId: Int64) -> Bool {
        chatId == self.chatId && (session == nil || sessionId == 0 || session!.id == sessionId)
    }

    public func reduce(_ frame: ServerFrame) -> ChatTimeline {
        var next = self
        switch frame {
        case .chatHistory(let history):
            guard history.chat.id == chatId else { return self }
            return onHistory(history)
        case .chatSession(let id, let newest, let started):
            guard id == chatId else { return self }
            // An older session on screen stays there; the turn is in the newest one.
            if !latest, let shown = session, newest.id != shown.id { return self }
            if let shown = session, newest.id != shown.id, started {
                next.messages = []
                next.live = nil
                next.notes = []
            }
            next.session = newest
        case .sessionContext(let context):
            guard context.chatId == chatId, session == nil || context.sessionId == session!.id else { return self }
            next.context = context
        case .messageMarks(let id, _, let messageId, let pinned, let reactions, let pins):
            guard id == chatId else { return self }
            next.pins = pins
            next.messages = messages.map { message in
                guard message.id == messageId else { return message }
                var marked = message
                marked.pinned = pinned
                marked.reactions = reactions
                return marked
            }
        case .chatMessage(let id, let sessionId, let message):
            guard id == chatId else { return self }
            next.pending = pending.filter { !(message.clientId != nil && $0.clientId == message.clientId) }
            if showing(id, sessionId) { next.messages = Self.merge(messages, [message]) }
        case .chatEvent(let id, let sessionId, let agent, let event):
            guard showing(id, sessionId) else { return self }
            return apply(agent, event)
        case .chatTurnMessages(let id, _, _, let turn):
            guard id == chatId else { return self }
            next.messages = Self.merge(messages, turn)
            next.live = nil
            next.earlier = []
        case .busy(let id, let done):
            if id == nil {
                next.busy = false
                next.transcribing = false
                next.viewing = false
            } else if id != chatId {
                return self
            } else if done {
                next.busy = false
                next.transcribing = false
                next.viewing = false
                next.live = live?.finished == true ? live : nil
            } else {
                next.busy = true
            }
        case .transcribing(let id, let on):
            guard id == chatId else { return self }
            next.transcribing = on
        case .viewing(let id, let on):
            guard id == chatId else { return self }
            next.viewing = on
        case .permissionResolved(let requestId):
            next.permissions = permissions.filter { $0.id != requestId }
        case .error(let message, let code, let errorChat, let clientId, _):
            if let clientId, pending.contains(where: { $0.clientId == clientId }) {
                next.pending = pending.map { sent in
                    var marked = sent
                    if sent.clientId == clientId { marked.failed = message }
                    return marked
                }
            } else if errorChat == chatId {
                next.notes.append(Note(text: "[\(code ?? "E-INTERNAL")] \(message)", bad: true))
            } else {
                return self
            }
        case .welcome(let welcome):
            next.permissions = Self.adding(permissions, welcome.pendingPermissions)
            next.busy = welcome.busyChats.contains(chatId)
        default:
            return self
        }
        return next
    }

    private func onHistory(_ frame: ChatHistoryFrame) -> ChatTimeline {
        var next = self
        if frame.beforeId != nil {
            next.messages = Self.merge(frame.messages, messages)
            next.hasMore = frame.hasMore
            return next
        }
        if frame.afterId != nil, frame.session?.id == session?.id {
            next.chat = frame.chat
            next.messages = Self.merge(messages, frame.messages)
            next.loaded = true
            if let pins = frame.pins { next.pins = pins }
            return next
        }
        next.chat = frame.chat
        next.session = frame.session
        next.latest = frame.session == nil || frame.sessions.isEmpty || frame.sessions[0].id == frame.session!.id
        if !frame.sessions.isEmpty { next.sessions = frame.sessions }
        if context?.sessionId != frame.session?.id { next.context = nil }
        if let pins = frame.pins { next.pins = pins }
        next.messages = frame.messages
        next.hasMore = frame.hasMore
        next.loaded = true
        if let streaming = frame.live { next.live = Self.bubble(streaming) }
        else if !(busy && live?.finished == false) { next.live = nil }
        if let waiting = frame.live?.pendingPermissions { next.permissions = waiting }
        // What was sent but never echoed is gone once the log says so.
        next.pending = pending.filter { sent in !frame.messages.contains { $0.role == "user" && $0.text == sent.text } }
        return next
    }

    /// task-start / -update carry the whole task; the others patch a part of the card.
    private func onTask(_ type: String, _ json: JSON) -> [TaskCard] {
        if json["task"].object != nil, let id = json["task"]["id"].string {
            let card = TaskCard(id: id, task: json["task"])
            return tasks.contains { $0.id == id } ? tasks.map { $0.id == id ? card : $0 } : tasks + [card]
        }
        guard let key = json["taskId"].string, let known = tasks.first(where: { $0.id == key }), var node = known.task.object else { return tasks }
        switch type {
        case "task-step" where json["step"].object != nil:
            var steps = node["steps"]?.array ?? []
            let step = json["step"]
            if let stepId = step["id"].string, let at = steps.firstIndex(where: { $0["id"].string == stepId }) { steps[at] = step } else { steps.append(step) }
            node["steps"] = .array(steps)
        case "task-plan" where json["plan"].object != nil:
            node["plan"] = json["plan"]
        case "task-receipt" where json["receipt"].object != nil:
            node[json["undo"].bool ? "undoReceipt" : "receipt"] = json["receipt"]
        case "task-finish":
            if let status = json["status"].string { node["status"] = .string(status) }
            if !json["receipt"].isNull { node["receipt"] = json["receipt"] }
        default: break
        }
        return tasks.map { $0.id == key ? TaskCard(id: key, task: .object(node)) : $0 }
    }

    private func apply(_ agent: String, _ event: AgentEvent) -> ChatTimeline {
        var next = self
        var bubble = live ?? LiveBubble(agent: agent)
        switch event {
        case .runStart(let starter, _):
            if let done = live, done.finished { next.earlier.append(done) }
            next.live = LiveBubble(agent: starter.isEmpty ? agent : starter)
            next.busy = true
        case .textDelta(let text):
            if case .text(let last)? = bubble.segments.last { bubble.segments[bubble.segments.count - 1] = .text(last + text) } else { bubble.segments.append(.text(text)) }
            next.live = bubble
        case .toolCall(let id, let name, let input, let risk):
            bubble.segments.append(.tool(id: id, name: name, arg: Self.preview(of: input), risk: risk, ok: nil, output: ""))
            next.live = bubble
        case .toolResult(let callId, let ok, let output):
            guard var current = live else { return self }
            current.segments = current.segments.map { segment in
                if case .tool(let id, let name, let arg, let risk, _, _) = segment, id == callId {
                    return .tool(id: id, name: name, arg: arg, risk: risk, ok: ok, output: String(output.prefix(4000)))
                }
                return segment
            }
            next.live = current
        case .attachment(let file):
            bubble.segments.append(.file(file))
            next.live = bubble
        case .permission(let request):
            next.permissions = Self.adding(permissions, [request])
        case .task(let type, let json):
            next.tasks = onTask(type, json)
        case .permissionDecision(let requestId):
            next.permissions = permissions.filter { $0.id != requestId }
        case .activity(let helper, let inner):
            if var current = live {
                current.helper = helper
                next.live = current
            }
            // A sub-agent's permission question is the user's to answer too.
            if case .permission(let request) = inner { next.permissions = Self.adding(permissions, [request]) }
            if case .permissionDecision(let requestId) = inner { next.permissions = permissions.filter { $0.id != requestId } }
        case .runFinish(let reason, let text, let speech, let error, let errorCode, let handoffTo):
            // The final text replaces what streamed in (it lacks the direction line for sure).
            if !text.isEmpty {
                if let at = bubble.segments.lastIndex(where: { if case .text = $0 { return true } else { return false } }) { bubble.segments[at] = .text(text) }
                else { bubble.segments.append(.text(text)) }
            }
            bubble.speech = speech ?? bubble.speech
            bubble.finished = true
            next.live = bubble
            switch reason {
            case "error": next.notes.append(Note(text: "ผิดพลาด [\(errorCode ?? "E-INTERNAL")]: \(error ?? "")", bad: true))
            case "handoff": if let to = handoffTo { next.notes.append(Note(text: "↪ ส่งต่อให้ \(to)", bad: false)) }
            case "stop": break
            default: next.notes.append(Note(text: "หยุด: \(reason)", bad: true))
            }
        case .other:
            return self
        }
        return next
    }
}
