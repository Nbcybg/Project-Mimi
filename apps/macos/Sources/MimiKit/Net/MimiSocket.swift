import Foundation

public enum SocketState: Equatable, Sendable {
    case idle
    case connecting
    case online(WelcomeFrame)
    /// Lost; tries again by itself after `retryIn` seconds.
    case offline(retryIn: TimeInterval)
    /// close 4003: the token no longer works. Never retried.
    case signedOut
    /// close 4426: this app is older than the core serves. Never retried.
    case appTooOld
    /// close 4029: too many wrong tokens from this address. Retried after 15 minutes.
    case rateLimited

    public var isOnline: Bool {
        if case .online = self { return true }
        return false
    }
}

/// The bits of a WebSocket the client needs; tests give a fake one.
public protocol WebSocketConnection: AnyObject {
    func connect(_ url: URL) async throws
    func send(_ text: String) async throws
    /// The next text frame, or nil with the close code when the socket ended.
    func receive() async -> (text: String?, closeCode: Int?)
    func abort()
}

public final class URLSessionWebSocket: WebSocketConnection {
    private var task: URLSessionWebSocketTask?

    public init() {}

    public func connect(_ url: URL) async throws {
        // No Origin header and no cookies: the token goes in `hello` (auth-and-session.md 2).
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 8 * 1024 * 1024
        self.task = task
        task.resume()
    }

    public func send(_ text: String) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        try await task.send(.string(text))
    }

    public func receive() async -> (text: String?, closeCode: Int?) {
        guard let task else { return (nil, nil) }
        do {
            switch try await task.receive() {
            case .string(let text): return (text, nil)
            case .data(let data): return (String(decoding: data, as: UTF8.self), nil)
            @unknown default: return ("", nil)
            }
        } catch {
            let code = task.closeCode.rawValue
            return (nil, code == 0 ? nil : code)
        }
    }

    public func abort() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}

/// The one WebSocket to `/ws` (docs/native/realtime.md): `hello` first, an app-level ping every 25 s,
/// a fresh socket when nothing was heard for a while, backoff 1 s → 15 s, and no retry after the core
/// said the token is dead (4003) or the app too old (4426). The same rules as the Windows and Android apps.
@MainActor
public final class MimiSocket {
    private let connect: () -> WebSocketConnection
    private let session: () -> (server: String?, token: String?)
    private let appVersion: String
    private let ping: TimeInterval
    private var socket: WebSocketConnection?
    private var generation = 0
    private var retry: TimeInterval = 1
    private var lastTraffic = Date()
    private var wanted = false
    private var waiting: [String] = []

    public private(set) var state: SocketState = .idle {
        didSet { onState?(state) }
    }

    public var onFrame: ((ServerFrame) -> Void)?
    /// Every frame but pongs and chat events as JSON, after `onFrame`: (type, frame).
    public var onRaw: ((String, JSON) -> Void)?
    public var onState: ((SocketState) -> Void)?

    public init(connect: @escaping () -> WebSocketConnection = { URLSessionWebSocket() }, session: @escaping () -> (server: String?, token: String?), appVersion: String, pingEvery: TimeInterval = 25) {
        self.connect = connect
        self.session = session
        self.appVersion = appVersion
        ping = pingEvery
    }

    public var isOnline: Bool { state.isOnline }

    /// Connects (and keeps reconnecting) while a token is stored.
    public func start() {
        wanted = true
        guard socket == nil else { return }
        let (server, token) = session()
        guard let server, let token, !server.isEmpty, !token.isEmpty, let url = ServerAddress.webSocketURL(server) else { return }
        generation += 1
        let number = generation
        let mine = connect()
        socket = mine
        lastTraffic = Date()
        state = .connecting
        Task { await loop(mine, number, url, token) }
    }

    /// Closes for good (sign-out).
    public func stop() {
        wanted = false
        generation += 1
        let old = socket
        socket = nil
        waiting.removeAll()
        old?.abort()
        state = .idle
    }

    /// Back on screen / network back: a socket that heard nothing for 12 s is presumed dead and replaced.
    public func wake() {
        wanted = true
        if let current = socket, Date().timeIntervalSince(lastTraffic) > 12 {
            dropAndRetry(current, after: 0)
        } else if socket == nil, state != .signedOut, state != .appTooOld {
            retry = 1
            start()
        }
    }

    /// Sends now, or once the next `welcome` arrives (at most 100 waiting frames).
    public func send(_ frame: String) {
        guard state.isOnline, let current = socket else {
            if waiting.count < 100 { waiting.append(frame) }
            return
        }
        Task { try? await current.send(frame) }
    }

    private func dropAndRetry(_ current: WebSocketConnection, after delay: TimeInterval) {
        guard socket === current else { return }
        generation += 1
        socket = nil
        current.abort()
        scheduleRetry(delay, quiet: false)
    }

    private func scheduleRetry(_ delay: TimeInterval, quiet: Bool) {
        guard wanted else { return }
        if !quiet { state = .offline(retryIn: delay) }
        let number = generation
        Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            // Stopped, or another socket started meanwhile.
            guard self.wanted, self.generation == number else { return }
            self.start()
        }
    }

    private func loop(_ mine: WebSocketConnection, _ number: Int, _ url: URL, _ token: String) async {
        var closeCode: Int?
        do {
            try await mine.connect(url)
            try await mine.send(ClientFrames.hello(token: token, appVersion: appVersion))
            let beat = Task { await heartbeat(mine, number) }
            defer { beat.cancel() }
            while true {
                let (text, code) = await mine.receive()
                guard let text else {
                    closeCode = code
                    break
                }
                guard number == generation else { return }
                lastTraffic = Date()
                let frame = FrameParser.parse(text)
                if case .welcome(let welcome) = frame {
                    retry = 1
                    let queued = waiting
                    waiting.removeAll()
                    state = .online(welcome)
                    for frameText in queued { try? await mine.send(frameText) }
                }
                if frame != .pong { onFrame?(frame) }
                // The management screens read frames as plain JSON (all but the stream's own events).
                if let onRaw, frame != .pong, frame.type != "chat-event", let json = try? JSON(parsing: text), let type = json["type"].string { onRaw(type, json) }
            }
        } catch {
            // the connection never opened; retried below
        }
        ended(mine, number, closeCode)
    }

    private func heartbeat(_ mine: WebSocketConnection, _ number: Int) async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(ping * 1_000_000_000))
            if Task.isCancelled || number != generation { return }
            // Nothing heard for three pings: the socket is dead even if the system has not noticed.
            if Date().timeIntervalSince(lastTraffic) > ping * 3 {
                dropAndRetry(mine, after: 0)
                return
            }
            try? await mine.send(ClientFrames.simple("ping"))
        }
    }

    private func ended(_ mine: WebSocketConnection, _ number: Int, _ code: Int?) {
        guard number == generation else { return }
        socket = nil
        let wait = retry
        retry = min(retry * 2, 15)
        mine.abort()
        switch code {
        case CloseCodes.invalidToken: state = .signedOut
        case CloseCodes.clientTooOld: state = .appTooOld
        case CloseCodes.rateLimited:
            state = .rateLimited
            scheduleRetry(15 * 60, quiet: true)
        default: scheduleRetry(wait, quiet: false)
        }
    }
}
