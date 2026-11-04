import MimiKit
import SwiftUI

/// Connecting and signing in (auth-and-session.md): the server, then its token (one core) or username,
/// password and the authenticator code (the gateway) — the same three steps as the other apps.
struct ConnectView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var connect = model.connect
        VStack(spacing: 18) {
            Spacer(minLength: 20)
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [Color(red: 0.898, green: 0.522, blue: 0.639), Color(red: 0.651, green: 0.227, blue: 0.361)],
                                                                       startPoint: .topLeading, endPoint: .bottomTrailing))
                Text("M").font(.system(size: 30, weight: .bold)).foregroundStyle(.white)
            }
            .frame(width: 56, height: 56)
            Text("เชื่อมต่อ Mimi").font(.title2.bold())
            VStack(alignment: .leading, spacing: 10) {
                switch connect.step {
                case .server:
                    TextField("ที่อยู่เซิร์ฟเวอร์ เช่น https://mimi.example.com", text: $connect.serverText)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await connect.check() } }
                    Button { Task { await connect.check() } } label: { Text("ถัดไป").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .disabled(connect.busy)
                    if connect.canUseLocal {
                        Button { Task { await model.useLocalServer() } } label: {
                            Text(model.localStarting ? "กำลังเปิดเซิร์ฟเวอร์ในเครื่องนี้…" : "ใช้เซิร์ฟเวอร์ในเครื่องนี้").frame(maxWidth: .infinity)
                        }
                        .disabled(connect.busy || model.localStarting)
                        Text("แอปเปิด Mimi core บนเครื่องนี้ให้เอง ข้อมูลอยู่ในโฟลเดอร์ เอกสาร/Mimi").font(.caption).foregroundStyle(.secondary)
                    }
                case .token:
                    Text(connect.server).font(.caption.monospaced()).foregroundStyle(.secondary)
                    SecureField("รหัสผ่านของ Mimi (MIMI_TOKEN)", text: $connect.token)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await connect.signIn() } }
                    signInButtons
                case .credentials:
                    Text(connect.server).font(.caption.monospaced()).foregroundStyle(.secondary)
                    TextField("ชื่อผู้ใช้", text: $connect.username).textFieldStyle(.roundedBorder)
                    SecureField("รหัสผ่าน", text: $connect.password)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await connect.signIn() } }
                    if connect.needsCode {
                        TextField("รหัส 6 หลักจากแอป authenticator", text: $connect.code)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { Task { await connect.signIn() } }
                    }
                    signInButtons
                }
                if !connect.error.isEmpty {
                    Text(connect.error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
                if connect.busy { ProgressView().controlSize(.small) }
            }
            .frame(maxWidth: 360)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var signInButtons: some View {
        @Bindable var connect = model.connect
        Toggle("เครื่องนี้ไม่ใช่ของฉัน (ไม่จำการเข้าสู่ระบบ)", isOn: $connect.notMyDevice).font(.callout)
        HStack {
            Button("กลับ") { connect.back() }
            Spacer()
            Button("เข้าสู่ระบบ") { Task { await connect.signIn() } }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(connect.busy)
        }
    }
}
