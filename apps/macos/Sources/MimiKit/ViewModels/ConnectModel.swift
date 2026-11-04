import Foundation
import Observation

/// What a successful sign-in hands to the app.
public struct SignedIn: Equatable, Sendable {
    public var server: String
    public var token: String
    public var username: String
    public var gateway: Bool
    /// False: "เครื่องนี้ไม่ใช่ของฉัน" — the session lives in memory only.
    public var remember: Bool
    public var health: Health
}

/// Connecting and signing in (docs/native/auth-and-session.md): `/health` tells a single core (type its
/// token) from the gateway (username, password, and the 2FA code when asked). The password is only held
/// until the sign-in ends; it is never stored. The same steps as ConnectViewModel.cs of the Windows app.
@MainActor
@Observable
public final class ConnectModel {
    public enum Step: Equatable, Sendable { case server, token, credentials }

    public var step: Step = .server
    public var serverText = ""
    public var token = ""
    public var username = ""
    public var password = ""
    public var code = ""
    /// The gateway asked for the authenticator code.
    public var needsCode = false
    public var notMyDevice = false
    public var error = ""
    public var busy = false
    /// The app can run the core on this computer itself.
    public var canUseLocal = false
    /// The server that was checked (an origin).
    public private(set) var server = ""
    public private(set) var health = Health()

    @ObservationIgnored private let transport: HTTPTransport
    @ObservationIgnored public var done: ((SignedIn) -> Void)?

    public init(transport: HTTPTransport = URLSessionTransport()) {
        self.transport = transport
    }

    /// A start with a server already chosen goes straight to its sign-in.
    public func resume(_ server: String) async {
        serverText = server
        await check()
    }

    public func check() async {
        error = ""
        let address: String
        do {
            address = try ServerAddress.normalize(serverText)
        } catch {
            self.error = (error as? ServerAddress.Problem)?.message ?? "ที่อยู่ไม่ถูกต้อง"
            return
        }
        busy = true
        defer { busy = false }
        do {
            let health = try await MimiAPI(transport: transport).health(address)
            guard health.ok else { throw MimiHTTPError(status: 502, message: "not Mimi", twoFactor: false) }
            if health.minClientApi > ClientApi.version {
                error = "เซิร์ฟเวอร์นี้ (Mimi \(health.version)) ต้องใช้แอปที่ใหม่กว่านี้ กรุณาอัปเดตแอป"
                return
            }
            server = address
            self.health = health
            serverText = address
            step = health.accounts ? .credentials : .token
        } catch {
            self.error = "ติดต่อเซิร์ฟเวอร์นี้ไม่ได้ หรือไม่ใช่เซิร์ฟเวอร์ Mimi"
        }
    }

    public func back() {
        step = .server
        needsCode = false
        password = ""
        code = ""
        error = ""
    }

    public func signIn() async {
        error = ""
        busy = true
        defer { busy = false }
        if step == .token { await signInWithToken() } else { await signInWithPassword() }
    }

    private func signInWithToken() async {
        let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            error = "ใส่รหัสผ่านของ Mimi (MIMI_TOKEN ของเครื่องที่รัน core)"
            return
        }
        do {
            try await MimiAPI(transport: transport, server: server, token: value).checkToken()
        } catch let refused as MimiHTTPError where refused.status == 401 {
            error = "รหัสผ่านไม่ถูกต้อง (หรือผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่)"
            return
        } catch {
            self.error = "ติดต่อเซิร์ฟเวอร์ไม่ได้: \(error.localizedDescription)"
            return
        }
        token = ""
        done?(SignedIn(server: server, token: value, username: "", gateway: false, remember: !notMyDevice, health: health))
    }

    private func signInWithPassword() async {
        let name = username.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !password.isEmpty else {
            error = "ใส่ชื่อผู้ใช้และรหัสผ่าน"
            return
        }
        let typed = code.trimmingCharacters(in: .whitespaces)
        do {
            let reply = try await MimiAPI(transport: transport, server: server).login(username: name, password: password, code: needsCode && !typed.isEmpty ? typed : nil)
            password = ""
            code = ""
            needsCode = false
            done?(SignedIn(server: server, token: reply.token, username: reply.username, gateway: true, remember: !notMyDevice, health: health))
        } catch let refused as MimiHTTPError where refused.twoFactor {
            let asked = needsCode && !code.isEmpty
            needsCode = true
            error = asked ? refused.message : "ใส่รหัส 6 หลักจากแอป authenticator (หรือรหัสกู้คืน)"
        } catch let refused as MimiHTTPError {
            switch refused.status {
            case 401: error = "ชื่อผู้ใช้ รหัสผ่าน หรือรหัสไม่ถูกต้อง"
            case 429: error = "ลองผิดหลายครั้งเกินไป รอสักพักแล้วลองใหม่"
            case 503: error = "เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง"
            default: error = refused.message
            }
        } catch {
            self.error = "ติดต่อเซิร์ฟเวอร์ไม่ได้: \(error.localizedDescription)"
        }
    }

    /// "ใช้เซิร์ฟเวอร์ในเครื่องนี้": starts the core here (`start` gives its address and token) and signs in to it.
    public func useLocal(_ start: () async throws -> (address: String, token: String)) async {
        error = ""
        busy = true
        let ready: (address: String, token: String)
        do {
            ready = try await start()
        } catch {
            busy = false
            self.error = "เปิดเซิร์ฟเวอร์ในเครื่องนี้ไม่ได้: \(error.localizedDescription)"
            return
        }
        busy = false
        serverText = ready.address
        await check()
        guard step == .token else {
            if error.isEmpty { error = "เซิร์ฟเวอร์ในเครื่องนี้เป็นแบบหลายบัญชี — เข้าสู่ระบบด้วยชื่อผู้ใช้" }
            return
        }
        token = ready.token
        notMyDevice = false
        await signIn()
    }
}
