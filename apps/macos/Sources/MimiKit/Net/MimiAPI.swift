import Foundation

/// Checks a server address the way the other apps do (remote-lib.cjs normalizeServerUrl, ServerAddress.cs).
public enum ServerAddress {
    public struct Problem: Error, Equatable, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    public static func isLocal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) || host.hasSuffix(".localhost")
    }

    /// Only an origin; https, except a server on this computer. A bare host gets https://.
    public static func normalize(_ raw: String) throws -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw Problem(message: "ใส่ที่อยู่เซิร์ฟเวอร์ เช่น https://mimi.example.com") }
        if !text.contains("://") { text = "https://" + text }
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(), let host = parts.host, !host.isEmpty, let url = parts.url else {
            throw Problem(message: "ที่อยู่ไม่ถูกต้อง ใส่แบบ https://mimi.example.com")
        }
        if scheme != "https" && !(scheme == "http" && isLocal(url)) { throw Problem(message: "ต้องเป็น https:// (http:// ใช้ได้เฉพาะเซิร์ฟเวอร์ในเครื่องนี้)") }
        if parts.user != nil || parts.password != nil { throw Problem(message: "ที่อยู่ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่านอยู่ข้างใน") }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = parts.port.map { $0 == defaultPort ? "" : ":\($0)" } ?? ""
        let shownHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "\(scheme)://\(shownHost.lowercased())\(port)"
    }

    /// The socket of a server: ws(s)://host/ws.
    public static func webSocketURL(_ server: String) -> URL? {
        guard var parts = URLComponents(string: server) else { return nil }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.path = "/ws"
        return parts.url
    }
}

/// A refusal of the server, with its own message (`{"error": …}`, api-contract.md 0).
public struct MimiHTTPError: Error, Equatable, LocalizedError {
    public let status: Int
    public let message: String
    /// The password was right, the account wants its authenticator code (auth-and-session.md 3.1).
    public let twoFactor: Bool

    public var errorDescription: String? { message }
}

/// What the HTTP side needs from a transport; tests give a stand-in.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// The HTTP side of the core / gateway (docs/native/api-contract.md part A). Every `/api/*` request
/// carries the Bearer token; there are no cookies.
public final class MimiAPI: @unchecked Sendable {
    private let transport: HTTPTransport
    private let lock = NSLock()
    private var _server: String?
    private var _token: String?

    public init(transport: HTTPTransport = URLSessionTransport(), server: String? = nil, token: String? = nil) {
        self.transport = transport
        _server = server
        _token = token
    }

    public var server: String? {
        get { lock.withLock { _server } }
        set { lock.withLock { _server = newValue } }
    }

    public var token: String? {
        get { lock.withLock { _token } }
        set { lock.withLock { _token = newValue } }
    }

    /// A path the server gave (e.g. `/api/files/12`) made absolute.
    public func absolute(_ path: String) -> URL? {
        guard let server, let base = URL(string: server) else { return nil }
        return URL(string: path, relativeTo: base)?.absoluteURL
    }

    public func request(_ method: String, _ path: String, auth: Bool = true, body: Data? = nil, contentType: String? = nil) throws -> URLRequest {
        guard let url = absolute(path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = method
        if auth, let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    @discardableResult
    public func send(_ request: URLRequest) async throws -> JSON {
        let (data, response) = try await transport.send(request)
        let json = (try? JSON(data: data)) ?? .null
        guard (200..<300).contains(response.statusCode) else {
            let message = json["error"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "HTTP \(response.statusCode)"
            throw MimiHTTPError(status: response.statusCode, message: message, twoFactor: json["twoFactor"].bool)
        }
        return json
    }

    public func get(_ path: String) async throws -> JSON { try await send(try request("GET", path)) }

    public func post(_ path: String, _ body: JSON = [:], auth: Bool = true) async throws -> JSON {
        try await send(try request("POST", path, auth: auth, body: Data(body.text.utf8)))
    }

    // ---------- connecting (auth-and-session.md) ----------

    /// `GET /health` of any server address, before one is chosen.
    public func health(_ address: String) async throws -> Health {
        guard let url = URL(string: "\(address)/health") else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "GET"
        let (data, response) = try await transport.send(request)
        guard response.statusCode == 200 else { throw MimiHTTPError(status: response.statusCode, message: "ไม่ใช่เซิร์ฟเวอร์ Mimi", twoFactor: false) }
        return Health(json: (try? JSON(data: data)) ?? .null)
    }

    /// `POST /auth/login` of the gateway: the session token and the shown username.
    public func login(username: String, password: String, code: String?) async throws -> (token: String, username: String) {
        var body: [String: JSON] = ["username": .string(username), "password": .string(password)]
        if let code { body["code"] = .string(code) }
        let reply = try await post("/auth/login", .object(body), auth: false)
        guard let token = reply["token"].string else { throw MimiHTTPError(status: 502, message: "เซิร์ฟเวอร์ตอบผิดรูปแบบ", twoFactor: false) }
        return (token, reply["username"].string ?? username)
    }

    /// Ends a gateway session; offline is fine (the session lapses by itself).
    public func logout(_ sessionToken: String) async {
        guard var request = try? request("POST", "/auth/logout", auth: false) else { return }
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        _ = try? await transport.send(request)
    }

    /// A core has no login endpoint: a call that needs the token tells right from wrong (401).
    public func checkToken() async throws { _ = try await get("/api/widget") }

    // ---------- chat files, notifications, push ----------

    /// Uploads a file to send with the next message (api-contract.md A.3, ≤ 25 MB), a picture with its caption.
    public func upload(_ data: Data, name: String, mime: String, caption: String? = nil) async throws -> AttachmentView {
        let query = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "file"
        var request = try request("POST", "/api/upload?name=\(query)", body: data, contentType: mime.isEmpty ? "application/octet-stream" : mime)
        if let caption, !caption.isEmpty { request.setValue(caption.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "", forHTTPHeaderField: "X-Mimi-Caption") }
        guard let file = AttachmentView(json: try await send(request)) else { throw MimiHTTPError(status: 502, message: "เซิร์ฟเวอร์ตอบผิดรูปแบบ", twoFactor: false) }
        return file
    }

    public func bytes(_ path: String) async throws -> Data {
        let (data, response) = try await transport.send(try request("GET", path))
        guard (200..<300).contains(response.statusCode) else { throw MimiHTTPError(status: response.statusCode, message: "HTTP \(response.statusCode)", twoFactor: false) }
        return data
    }

    public static func filePath(_ id: String) -> String { "/api/files/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)" }

    public static func agentImagePath(_ agent: String, _ kind: String, stamp: String) -> String {
        "/api/agent-image/\(agent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agent)/\(kind)?v=\(stamp)"
    }

    public func notifications(after id: Int64) async throws -> [NotificationSyncItem] {
        try await get("/api/notifications?afterId=\(id)").array.compactMap(NotificationSyncItem.init(json:))
    }

    /// Which push services work from this server (api 2); an older core has none.
    public func pushInfo() async -> PushInfo {
        PushInfo(json: (try? await get("/api/push/info")) ?? .null)
    }
}
