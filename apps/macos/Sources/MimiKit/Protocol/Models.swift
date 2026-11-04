import Foundation

/// The client API this app is built against (docs/native/api-versioning.md).
public enum ClientApi {
    public static let version = 2
    /// The oldest core API this app works with. API 0 cores (before Phase 1) still chat, but lack
    /// `chat-turn-messages`, Range on files and push; the app copes (it reopens the chat after a turn).
    public static let minSupportedCoreApi = 0
}

/// Close codes of `/ws` (docs/native/realtime.md 7.4).
public enum CloseCodes {
    public static let helloTimeout = 4001
    public static let invalidToken = 4003
    public static let rateLimited = 4029
    public static let clientTooOld = 4426
    public static let gatewayCoreRefused = 4502
}

public struct Health: Equatable, Sendable {
    public var ok = false
    public var version = ""
    public var api = 0
    public var minClientApi = 0
    public var accounts = false

    public init(ok: Bool = false, version: String = "", api: Int = 0, minClientApi: Int = 0, accounts: Bool = false) {
        self.ok = ok
        self.version = version
        self.api = api
        self.minClientApi = minClientApi
        self.accounts = accounts
    }

    public init(json: JSON) {
        self.init(ok: json["ok"].bool, version: json["version"].str, api: Int(json["api"].int ?? 0), minClientApi: Int(json["minClientApi"].int ?? 0), accounts: json["accounts"].bool)
    }
}

public struct SpeechStyle: Equatable, Sendable {
    public var emotion: String?
    public var tone: String?
    public var voice: String?
    public var speed: Double?

    public init(emotion: String? = nil, tone: String? = nil, voice: String? = nil, speed: Double? = nil) {
        self.emotion = emotion
        self.tone = tone
        self.voice = voice
        self.speed = speed
    }

    public init?(json: JSON) {
        guard json.object != nil else { return nil }
        self.init(emotion: json["emotion"].string, tone: json["tone"].string, voice: json["voice"].string, speed: json["speed"].double)
    }

    public var isEmpty: Bool { emotion == nil && tone == nil && voice == nil && speed == nil }
}

public struct AttachmentView: Equatable, Sendable, Identifiable {
    public var id: String
    public var kind: String
    public var name: String
    public var mime: String
    public var size: Int64 = 0
    public var text = ""
    public var caption = ""
    public var deletedAt: String?

    public init(id: String, kind: String, name: String, mime: String, size: Int64 = 0, text: String = "", caption: String = "", deletedAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.mime = mime
        self.size = size
        self.text = text
        self.caption = caption
        self.deletedAt = deletedAt
    }

    public init?(json: JSON) {
        guard let id = json["id"].string else { return nil }
        self.init(id: id, kind: json["kind"].str, name: json["name"].str, mime: json["mime"].str, size: json["size"].int ?? 0, text: json["text"].str, caption: json["caption"].str, deletedAt: json["deletedAt"].string)
    }

    public var isImage: Bool { kind == "image" && deletedAt == nil }
}

public struct ToolSummary: Equatable, Sendable {
    public var name: String
    public var summary: String
}

public struct QuotedMessage: Equatable, Sendable {
    public var id: Int64
    public var role: String
    public var agent: String
    public var text: String
}

public struct ApprovalView: Equatable, Sendable {
    public var id: Int64
    public var status: String
    public var workflow: String
    public var expiresAt: String
    public var note: String?

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.id = id
        status = json["status"].str
        workflow = json["workflow"].str
        expiresAt = json["expiresAt"].str
        note = json["note"].string
    }
}

public struct ChatMessageView: Equatable, Sendable, Identifiable {
    public var id: Int64
    public var role: String
    public var agent = ""
    public var text = ""
    public var speech: SpeechStyle?
    public var createdAt = ""
    public var files: [AttachmentView] = []
    public var tools: [ToolSummary] = []
    public var replyTo: QuotedMessage?
    public var clientId: String?
    public var approval: ApprovalView?
    public var pinned = false
    /// Who wrote a forwarded message, and the chat it came from.
    public var forwardedFromName: String?
    public var forwardedFromChat = ""
    public var reactions: [String] = []

    public init(id: Int64, role: String, agent: String = "", text: String = "", createdAt: String = "", clientId: String? = nil) {
        self.id = id
        self.role = role
        self.agent = agent
        self.text = text
        self.createdAt = createdAt
        self.clientId = clientId
    }

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.init(id: id, role: json["role"].str, agent: json["agent"].str, text: json["text"].str, createdAt: json["createdAt"].str, clientId: json["clientId"].string)
        speech = SpeechStyle(json: json["speech"])
        files = json["attachments"].array.compactMap(AttachmentView.init(json:))
        tools = json["tools"].array.compactMap { tool in tool["name"].string.map { ToolSummary(name: $0, summary: tool["summary"].str) } }
        let quote = json["replyTo"]
        if let quoted = quote["id"].int { replyTo = QuotedMessage(id: quoted, role: quote["role"].str, agent: quote["agent"].str, text: quote["text"].str) }
        approval = ApprovalView(json: json["approval"])
        pinned = json["pinned"].bool
        if let from = json["forwardedFrom"]["from"].string {
            forwardedFromName = from
            forwardedFromChat = json["forwardedFrom"]["chat"].str
        }
        reactions = json["reactions"].array.compactMap(\.string)
    }

    public static func == (a: ChatMessageView, b: ChatMessageView) -> Bool {
        a.id == b.id && a.role == b.role && a.agent == b.agent && a.text == b.text && a.speech == b.speech && a.createdAt == b.createdAt
            && a.files == b.files && a.tools == b.tools && a.replyTo == b.replyTo && a.clientId == b.clientId && a.approval == b.approval
            && a.pinned == b.pinned && a.forwardedFromName == b.forwardedFromName && a.forwardedFromChat == b.forwardedFromChat && a.reactions == b.reactions
    }
}

/// A pinned message, as the pin bar lists it (protocol.ts PinView).
public struct PinView: Equatable, Sendable {
    public var id: Int64
    public var sessionId: Int64
    public var role: String
    public var agent: String
    public var text: String
    public var createdAt: String

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.id = id
        sessionId = json["sessionId"].int ?? 0
        role = json["role"].str
        agent = json["agent"].str
        text = json["text"].str
        createdAt = json["createdAt"].str
    }
}

public struct ChatView: Equatable, Sendable, Identifiable {
    public var id: Int64
    public var kind: String
    public var title = ""
    public var agents: [String] = []
    public var lastMessageAt: String?
    public var preview = ""
    public var unread = false

    public init(id: Int64, kind: String, title: String = "", agents: [String] = [], lastMessageAt: String? = nil, preview: String = "", unread: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.agents = agents
        self.lastMessageAt = lastMessageAt
        self.preview = preview
        self.unread = unread
    }

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.init(id: id, kind: json["kind"].str, title: json["title"].str, agents: json["agents"].array.compactMap(\.string),
                  lastMessageAt: json["lastMessageAt"].string, preview: json["preview"].str, unread: json["unread"].bool)
    }
}

public struct SessionView: Equatable, Sendable, Identifiable {
    public var id: Int64
    public var chatId: Int64
    public var title: String
    public var summary: String
    public var createdAt: String
    public var lastMessageAt: String
    public var unread: Bool

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.id = id
        chatId = json["chatId"].int ?? 0
        title = json["title"].str
        summary = json["summary"].str
        createdAt = json["createdAt"].str
        lastMessageAt = json["lastMessageAt"].str
        unread = json["unread"].bool
    }
}

public struct PermissionRequest: Equatable, Sendable, Identifiable {
    public var id: String
    public var tool: String
    public var agent: String
    public var risk: String
    public var input: JSON
    public var summary: String
    public var timeoutMs: Int64
    /// Only "once" may be answered (no lasting grant for this tool).
    public var noGrant: Bool

    public init(id: String, tool: String, agent: String = "", risk: String = "", input: JSON = .null, summary: String = "", noGrant: Bool = false) {
        self.id = id
        self.tool = tool
        self.agent = agent
        self.risk = risk
        self.input = input
        self.summary = summary
        timeoutMs = 0
        self.noGrant = noGrant
    }

    public init?(json: JSON) {
        guard let id = json["id"].string else { return nil }
        self.init(id: id, tool: json["tool"].str, agent: json["agent"].str, risk: json["risk"].str, input: json["input"], summary: json["summary"].str, noGrant: json["noGrant"].bool)
        timeoutMs = json["timeoutMs"].int ?? 0
    }
}

public struct LiveTool: Equatable, Sendable {
    public var id: String
    public var name: String
    public var arg: String
    public var risk: String?
    public var ok: Bool?
    public var output: String
}

public struct LiveTurnView: Equatable, Sendable {
    public var sessionId: Int64
    public var agent: String
    public var text: String
    public var speech: SpeechStyle?
    public var tools: [LiveTool]
    public var files: [AttachmentView]
    public var pendingPermissions: [PermissionRequest]?

    public init?(json: JSON) {
        guard json.object != nil else { return nil }
        sessionId = json["sessionId"].int ?? 0
        agent = json["agent"].str
        text = json["text"].str
        speech = SpeechStyle(json: json["speech"])
        tools = json["tools"].array.map { tool in
            LiveTool(id: tool["id"].str, name: tool["name"].str, arg: tool["arg"].str, risk: tool["risk"].string,
                     ok: tool["ok"].isNull ? nil : tool["ok"].bool, output: tool["output"].str)
        }
        files = json["attachments"].array.compactMap(AttachmentView.init(json:))
        pendingPermissions = json["pendingPermissions"].isNull ? nil : json["pendingPermissions"].array.compactMap(PermissionRequest.init(json:))
    }
}

/// The fields of an agent the chat screens use (the editor's are many more).
public struct AgentView: Equatable, Sendable, Identifiable {
    public var name: String
    public var displayName: String?
    public var description: String
    /// The picture's version stamp (`?v=`), when it has one.
    public var avatar: String?
    public var portrait: String?

    public var id: String { name }

    public init(name: String, displayName: String? = nil, description: String = "", avatar: String? = nil, portrait: String? = nil) {
        self.name = name
        self.displayName = displayName
        self.description = description
        self.avatar = avatar
        self.portrait = portrait
    }

    public init?(json: JSON) {
        guard let name = json["name"].string else { return nil }
        self.init(name: name, displayName: json["displayName"].string, description: json["description"].str, avatar: json["avatar"].string, portrait: json["portrait"].string)
    }

    public var shownName: String {
        guard let shown = displayName?.trimmingCharacters(in: .whitespaces), !shown.isEmpty else { return name }
        return shown
    }
}

public struct NotificationSyncItem: Equatable, Sendable, Identifiable {
    public var id: Int64
    public var kind: String
    public var title: String
    public var body: String
    public var chatId: Int64?
    public var createdAt: String
    public var read: Bool

    public init?(json: JSON) {
        guard let id = json["id"].int else { return nil }
        self.id = id
        kind = json["kind"].str
        title = json["title"].str
        body = json["body"].str
        chatId = json["chatId"].int
        createdAt = json["createdAt"].str
        read = json["read"].bool
    }
}

/// `GET /api/push/info`: the push services that work from this server (api 2).
public struct PushInfo: Equatable, Sendable {
    public var platforms: [String] = []
    public var wnsRemoteId: String?

    public init(json: JSON) {
        platforms = json["platforms"].array.compactMap(\.string)
        wnsRemoteId = json["wnsRemoteId"].string
    }

    public var apns: Bool { platforms.contains("apns") }
}
