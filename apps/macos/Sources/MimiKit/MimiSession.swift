import Foundation
import Observation

/// One signed-in connection to a core or gateway: the HTTP client, the socket, and what every screen
/// shares (agents, chats, who is busy). Frames arrive on the main actor (MimiSession.cs of the Windows app).
@MainActor
@Observable
public final class MimiSession {
    public let api: MimiAPI
    @ObservationIgnored public private(set) var socket: MimiSocket!
    public let appVersion: String

    public private(set) var username = ""
    /// Signed in through the accounts gateway (username + password) rather than one core's token.
    public private(set) var gateway = false
    public private(set) var coreApi = 0
    public private(set) var state: SocketState = .idle
    public private(set) var agents: [String: AgentView] = [:]
    public private(set) var defaultAgent = ""
    public private(set) var chats: [ChatView] = []
    public private(set) var busyChats: Set<Int64> = []
    public private(set) var pcOnline = false
    /// Screen settings shared by the user's devices (welcome.ui, `ui` frames).
    public private(set) var shared: [String: String] = [:]

    @ObservationIgnored private var listeners: [UUID: (ServerFrame) -> Void] = [:]
    @ObservationIgnored private var stateListeners: [UUID: (SocketState) -> Void] = [:]

    public init(appVersion: String, transport: HTTPTransport = URLSessionTransport(), connect: @escaping () -> WebSocketConnection = { URLSessionWebSocket() }, pingEvery: TimeInterval = 25) {
        self.appVersion = appVersion
        api = MimiAPI(transport: transport)
        let api = self.api
        socket = MimiSocket(connect: connect, session: { (api.server, api.token) }, appVersion: appVersion, pingEvery: pingEvery)
        socket.onFrame = { [weak self] frame in self?.onFrame(frame) }
        socket.onState = { [weak self] next in self?.onState(next) }
    }

    public var server: String? { api.server }
    public var token: String? { api.token }

    /// Every frame of the socket, after the shared state above is updated. Returns a handle for `unlisten`.
    @discardableResult
    public func listen(_ handler: @escaping (ServerFrame) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = handler
        return id
    }

    @discardableResult
    public func listenState(_ handler: @escaping (SocketState) -> Void) -> UUID {
        let id = UUID()
        stateListeners[id] = handler
        return id
    }

    public func unlisten(_ id: UUID) {
        listeners[id] = nil
        stateListeners[id] = nil
    }

    public func begin(server: String, token: String, username: String, gateway: Bool, coreApi: Int) {
        api.server = server
        api.token = token
        self.username = username
        self.gateway = gateway
        self.coreApi = coreApi
        socket.start()
    }

    /// Forgets the token and closes the socket (the caller ends the gateway session first).
    public func end() {
        socket.stop()
        api.token = nil
        username = ""
        agents = [:]
        busyChats = []
        chats = []
        shared = [:]
    }

    public func send(_ frame: String) { socket.send(frame) }

    public func uiValue(_ key: String) -> String? { shared[key] }

    /// Changes a shared screen setting (nil removes it); the user's other devices hear of it.
    public func setUi(_ key: String, _ value: String?) {
        shared[key] = value
        send(ClientFrames.build("ui-set", ["values": .object([key: .optional(value)])]))
    }

    public func agentName(_ name: String) -> String { agents[name]?.shownName ?? name }

    public func chatTitle(_ chat: ChatView) -> String {
        if !chat.title.isEmpty { return chat.title }
        let names = chat.agents.map(agentName)
        return names.isEmpty ? "แชต #\(chat.id)" : names.joined(separator: ", ")
    }

    private func onState(_ next: SocketState) {
        state = next
        if case .online(let welcome) = next {
            coreApi = welcome.api
            busyChats = Set(welcome.busyChats)
            for summary in welcome.agents where agents[summary.name] == nil { agents[summary.name] = summary }
            defaultAgent = welcome.defaultAgent
            shared = welcome.ui
            pcOnline = false
            // The minimum for the chat screens (realtime.md 2.1).
            send(ClientFrames.simple("agents-list"))
            send(ClientFrames.simple("chats-list"))
        }
        for listener in stateListeners.values { listener(next) }
    }

    private func onFrame(_ frame: ServerFrame) {
        switch frame {
        case .agents(let list, let fallback):
            agents = Dictionary(list.map { ($0.name, $0) }, uniquingKeysWith: { _, last in last })
            if let fallback, !fallback.isEmpty { defaultAgent = fallback }
        case .chats(let list):
            chats = list
        case .busy(nil, _):
            busyChats = []
        case .busy(let id?, let done):
            if done { busyChats.remove(id) } else { busyChats.insert(id) }
        case .pcStatus(let online, _):
            pcOnline = online
        case .ui(let values):
            for (key, value) in values { shared[key] = value ?? nil }
        default:
            break
        }
        for listener in listeners.values { listener(frame) }
    }
}
