import Foundation

/// What a tool, a sub-agent or the model did during a turn (packages/shared/src/events.ts).
public indirect enum AgentEvent: Equatable, Sendable {
    case runStart(agent: String, model: String)
    case textDelta(String)
    case toolCall(id: String, name: String, input: JSON, risk: String?)
    case toolResult(callId: String, ok: Bool, output: String)
    case attachment(AttachmentView)
    case permission(PermissionRequest)
    case permissionDecision(requestId: String)
    /// A sub-agent working for this one.
    case activity(agent: String, event: AgentEvent)
    case runFinish(reason: String, text: String, speech: SpeechStyle?, error: String?, errorCode: String?, handoffTo: String?)
    /// A task card event (task-start / -update / -step / -plan / -receipt / -finish), kept as JSON.
    case task(type: String, json: JSON)
    /// Usage and anything newer: not shown by this version of the app.
    case other(String)
}

public struct WelcomeFrame: Equatable, Sendable {
    public var agents: [AgentView]
    public var defaultAgent: String
    public var busyChats: [Int64]
    public var pendingPermissions: [PermissionRequest]
    public var version: String?
    public var api: Int
    public var minClientApi: Int
    /// Screen settings shared by the user's devices.
    public var ui: [String: String]
}

public struct ChatHistoryFrame: Equatable, Sendable {
    public var chat: ChatView
    public var session: SessionView?
    public var sessions: [SessionView]
    public var messages: [ChatMessageView]
    public var hasMore: Bool
    public var beforeId: Int64?
    public var afterId: Int64?
    public var live: LiveTurnView?
    public var pins: [PinView]?
}

public struct SessionContext: Equatable, Sendable {
    public var chatId: Int64
    public var sessionId: Int64
    public var usedTokens: Int64
    public var windowTokens: Int64
    public var costUsd: Double
}

/// Frames the core sends (protocol.ts ServerMessage); only the ones this app uses are typed.
public enum ServerFrame: Equatable, Sendable {
    case welcome(WelcomeFrame)
    case pong
    case chats([ChatView])
    case agents([AgentView], defaultAgent: String?)
    case chatHistory(ChatHistoryFrame)
    case chatSession(chatId: Int64, session: SessionView, started: Bool)
    case chatMessage(chatId: Int64, sessionId: Int64, message: ChatMessageView)
    case chatEvent(chatId: Int64, sessionId: Int64, agent: String, event: AgentEvent)
    case chatTurnMessages(chatId: Int64, sessionId: Int64, afterId: Int64, messages: [ChatMessageView])
    case busy(chatId: Int64?, done: Bool)
    case transcribing(chatId: Int64, on: Bool)
    case viewing(chatId: Int64, on: Bool)
    case chatChanged(chatId: Int64, sessionId: Int64)
    case permissionResolved(requestId: String)
    case notification(kind: String, title: String, body: String, chatId: Int64?, id: Int64?)
    /// An event of background work outside any chat (it may ask for permission).
    case background(AgentEvent)
    case error(message: String, code: String?, chatId: Int64?, clientId: String?, requestType: String?)
    case securityAlert(at: String)
    case pcStatus(online: Bool, name: String?)
    case sessionContext(SessionContext)
    /// Shared screen settings that changed (nil = removed).
    case ui([String: String?])
    case messageMarks(chatId: Int64, sessionId: Int64, messageId: Int64, pinned: Bool, reactions: [String], pins: [PinView])
    case unknown(String)

    public var type: String {
        switch self {
        case .welcome: "welcome"
        case .pong: "pong"
        case .chats: "chats"
        case .agents: "agents"
        case .chatHistory: "chat-history"
        case .chatSession: "chat-session"
        case .chatMessage: "chat-message"
        case .chatEvent: "chat-event"
        case .chatTurnMessages: "chat-turn-messages"
        case .busy: "busy"
        case .transcribing: "chat-transcribing"
        case .viewing: "chat-viewing"
        case .chatChanged: "chat-changed"
        case .permissionResolved: "permission-resolved"
        case .notification: "notification"
        case .background: "event"
        case .error: "error"
        case .securityAlert: "security-alert"
        case .pcStatus: "pc-status"
        case .sessionContext: "session-context"
        case .ui: "ui"
        case .messageMarks: "message-marks"
        case .unknown(let type): type
        }
    }
}

private struct Missing: Error {}

/// Parses the text frames of `/ws`. Never throws: a broken frame is `.unknown` (api-versioning.md: skip quietly).
public enum FrameParser {
    public static func parseEvent(_ json: JSON) -> AgentEvent {
        let type = json["type"].str
        switch type {
        case "run-start": return .runStart(agent: json["agent"].str, model: json["model"].str)
        case "text-delta": return .textDelta(json["text"].str)
        case "tool-call":
            let call = json["call"]
            guard call.object != nil else { return .other(type) }
            return .toolCall(id: call["id"].str, name: call["name"].str, input: call["input"], risk: json["risk"].string)
        case "tool-result":
            let result = json["result"]
            guard result.object != nil else { return .other(type) }
            return .toolResult(callId: result["callId"].str, ok: result["ok"].bool, output: result["output"].str)
        case "attachment":
            return AttachmentView(json: json["attachment"]).map(AgentEvent.attachment) ?? .other(type)
        case "permission-request":
            return PermissionRequest(json: json["request"]).map(AgentEvent.permission) ?? .other(type)
        case "permission-decision": return .permissionDecision(requestId: json["requestId"].str)
        case "agent-activity":
            let inner = json["event"]
            return .activity(agent: json["agent"].str, event: inner.object != nil ? parseEvent(inner) : .other("?"))
        case "run-finish":
            return .runFinish(reason: json["reason"].str, text: json["text"].str, speech: SpeechStyle(json: json["speech"]),
                              error: json["error"].string, errorCode: json["errorCode"].string, handoffTo: json["handoff"]["to"].string)
        case "task-start", "task-update", "task-step", "task-plan", "task-receipt", "task-finish":
            return .task(type: type, json: json)
        default: return .other(type)
        }
    }

    public static func parse(_ text: String) -> ServerFrame {
        guard let json = try? JSON(parsing: text), json.object != nil else { return .unknown("") }
        let type = json["type"].str
        do {
            return try parseKnown(json, type)
        } catch {
            return .unknown(type)
        }
    }

    private static func need<T>(_ value: T?) throws -> T {
        guard let value else { throw Missing() }
        return value
    }

    private static func parseKnown(_ json: JSON, _ type: String) throws -> ServerFrame {
        switch type {
        case "welcome":
            var ui: [String: String] = [:]
            for (key, value) in json["ui"].object ?? [:] { if let text = value.string { ui[key] = text } }
            return .welcome(WelcomeFrame(
                agents: json["agents"].array.compactMap(AgentView.init(json:)),
                defaultAgent: json["defaultAgent"].str,
                busyChats: json["busyChats"].array.compactMap(\.int),
                pendingPermissions: json["pendingPermissions"].array.compactMap(PermissionRequest.init(json:)),
                version: json["version"].string,
                api: Int(json["api"].int ?? 0),
                minClientApi: Int(json["minClientApi"].int ?? 0),
                ui: ui))
        case "pong": return .pong
        case "chats": return .chats(json["chats"].array.compactMap(ChatView.init(json:)))
        case "agents": return .agents(json["agents"].array.compactMap(AgentView.init(json:)), defaultAgent: json["defaultAgent"].string)
        case "chat-history":
            return .chatHistory(ChatHistoryFrame(
                chat: try need(ChatView(json: json["chat"])),
                session: SessionView(json: json["session"]),
                sessions: json["sessions"].array.compactMap(SessionView.init(json:)),
                messages: json["messages"].array.compactMap(ChatMessageView.init(json:)),
                hasMore: json["hasMore"].bool,
                beforeId: json["beforeId"].int,
                afterId: json["afterId"].int,
                live: LiveTurnView(json: json["live"]),
                pins: json["pins"].isNull ? nil : json["pins"].array.compactMap(PinView.init(json:))))
        case "chat-session":
            return .chatSession(chatId: try need(json["chatId"].int), session: try need(SessionView(json: json["session"])), started: json["started"].bool)
        case "chat-message":
            return .chatMessage(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0, message: try need(ChatMessageView(json: json["message"])))
        case "chat-event":
            guard json["event"].object != nil else { throw Missing() }
            return .chatEvent(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0, agent: json["agent"].str, event: parseEvent(json["event"]))
        case "chat-turn-messages":
            return .chatTurnMessages(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0, afterId: json["afterId"].int ?? 0,
                                     messages: json["messages"].array.compactMap(ChatMessageView.init(json:)))
        case "busy": return .busy(chatId: json["chatId"].int, done: json["done"].bool)
        case "chat-transcribing": return .transcribing(chatId: try need(json["chatId"].int), on: json["on"].bool)
        case "chat-viewing": return .viewing(chatId: try need(json["chatId"].int), on: json["on"].bool)
        case "chat-changed": return .chatChanged(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0)
        case "permission-resolved": return .permissionResolved(requestId: json["requestId"].str)
        case "notification":
            let item = json["notification"]
            guard item.object != nil else { throw Missing() }
            return .notification(kind: item["kind"].str, title: item["title"].str, body: item["body"].str, chatId: item["chatId"].int, id: item["id"].int)
        case "event":
            guard json["event"].object != nil else { return .unknown(type) }
            return .background(parseEvent(json["event"]))
        case "error":
            return .error(message: json["message"].str, code: json["code"].string, chatId: json["chatId"].int, clientId: json["clientId"].string, requestType: json["requestType"].string)
        case "security-alert": return .securityAlert(at: json["at"].str)
        case "pc-status": return .pcStatus(online: json["online"].bool, name: json["name"].string)
        case "session-context":
            let context = json["context"]
            guard context.object != nil else { throw Missing() }
            return .sessionContext(SessionContext(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0,
                                                  usedTokens: Int64(context["usedTokens"].double ?? 0), windowTokens: Int64(context["windowTokens"].double ?? 0),
                                                  costUsd: context["costUsd"].double ?? 0))
        case "ui":
            var values: [String: String?] = [:]
            for (key, value) in json["values"].object ?? [:] { values[key] = value.string }
            return .ui(values)
        case "message-marks":
            return .messageMarks(chatId: try need(json["chatId"].int), sessionId: json["sessionId"].int ?? 0, messageId: try need(json["messageId"].int),
                                 pinned: json["pinned"].bool, reactions: json["reactions"].array.compactMap(\.string), pins: json["pins"].array.compactMap(PinView.init(json:)))
        default: return .unknown(type)
        }
    }
}

/// Builders for what the app sends (protocol.ts ClientMessage).
public enum ClientFrames {
    public static func build(_ type: String, _ fields: [String: JSON] = [:]) -> String {
        var map = fields.filter { !$0.value.isNull }
        map["type"] = .string(type)
        return JSON.object(map).text
    }

    public static func hello(token: String, appVersion: String) -> String {
        build("hello", ["role": "client", "token": .string(token), "name": "macos",
                        "client": ["platform": "macos", "version": .string(appVersion), "api": .number(Double(ClientApi.version))]])
    }

    public static func simple(_ type: String) -> String { build(type) }

    public static func presence(chatId: Int64?, visible: Bool) -> String {
        // chatId: null is meaningful here (no chat on screen), so it is written out.
        var map: [String: JSON] = ["type": "presence", "visible": .bool(visible)]
        map["chatId"] = chatId.map { .int($0) } ?? .null
        return JSON.object(map).text
    }

    public static func chatOpen(_ chatId: Int64, sessionId: Int64? = nil, beforeId: Int64? = nil, afterId: Int64? = nil) -> String {
        build("chat-open", ["chatId": .int(chatId), "sessionId": .optional(sessionId), "beforeId": .optional(beforeId), "afterId": .optional(afterId)])
    }

    public static func chatCreateDirect(_ agent: String) -> String {
        build("chat-create", ["kind": "direct", "agents": [.string(agent)]])
    }

    public static func chatSend(_ chatId: Int64, text: String, attachments: [String], clientId: String?, replyTo: Int64? = nil) -> String {
        build("chat-send", ["chatId": .int(chatId), "text": .string(text), "attachments": attachments.isEmpty ? .null : .array(attachments.map(JSON.string)),
                            "clientId": .optional(clientId), "replyTo": .optional(replyTo)])
    }

    public static func abort(_ chatId: Int64) -> String { build("abort", ["chatId": .int(chatId)]) }

    /// `scope`: once | task | session | always (left out when denying).
    public static func permissionResponse(_ requestId: String, allow: Bool, scope: String = "once") -> String {
        build("permission-response", ["requestId": .string(requestId), "allow": .bool(allow), "scope": allow ? .string(scope) : .null])
    }

    public static func approvalDecide(_ id: Int64, approved: Bool) -> String {
        build("approval-decide", ["id": .int(id), "approved": .bool(approved)])
    }

    public static func messagePin(_ messageId: Int64, pinned: Bool) -> String { build("message-pin", ["messageId": .int(messageId), "pinned": .bool(pinned)]) }
    public static func messageReact(_ messageId: Int64, emoji: String) -> String { build("message-react", ["messageId": .int(messageId), "emoji": .string(emoji)]) }
    public static func search(_ query: String) -> String { build("search", ["query": .string(query)]) }
}
