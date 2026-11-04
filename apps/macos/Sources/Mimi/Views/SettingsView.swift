import AppKit
import MimiDesktop
import MimiKit
import SwiftUI

/// This computer's settings (the Windows app's "ตั้งค่าแอปบนเครื่องนี้"): the account, the PC agent and its
/// folders, auto-lock, the agent's browser.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var problem = ""

    var body: some View {
        Form {
            Section("บัญชี") {
                LabeledContent("เซิร์ฟเวอร์", value: model.config.server.isEmpty ? "-" : model.config.server)
                if model.signedIn {
                    LabeledContent("ผู้ใช้", value: model.session.username.isEmpty ? "(token ของ core)" : model.session.username)
                    HStack {
                        Button("ออกจากระบบ") { Task { await model.signOut() } }
                        Button("เปลี่ยนเซิร์ฟเวอร์…") { Task { await model.signOut(changeServer: true) } }
                        Button("เปิด Mimi ในเบราว์เซอร์") { model.openWeb() }
                    }
                }
                Picker("ออกจากระบบอัตโนมัติ", selection: Binding(get: { model.config.autoLockMinutes }, set: { model.setAutoLock($0) })) {
                    ForEach(AppConfig.lockChoices, id: \.self) { minutes in Text(minutes == 0 ? "ไม่ใช้" : "ไม่ได้ใช้ \(minutes) นาที หรือล็อกหน้าจอ").tag(minutes) }
                }
            }
            Section("ให้ Mimi ใช้เครื่องนี้ (PC agent)") {
                Text("agent บนเซิร์ฟเวอร์อ่าน/เขียนไฟล์ในโฟลเดอร์ที่อนุญาต และเปิดเบราว์เซอร์ (Edge/Chrome) บนเครื่องนี้ได้ คำสั่งที่เสี่ยงยังต้องกดอนุญาต")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("เปิด PC agent", isOn: Binding(get: { model.config.pcAgentEnabled }, set: { on in Task { await model.setPcAgent(on) } }))
                LabeledContent("สถานะ", value: model.config.pcAgentEnabled ? model.pcStatus : "ปิด")
                Toggle("อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)", isOn: Binding(get: { model.config.pcAgentShell }, set: { on in Task { await model.setShell(on) } }))
                VStack(alignment: .leading) {
                    Text("โฟลเดอร์ที่ Mimi ใช้ได้").font(.caption)
                    ForEach(model.config.pcAgentFolders, id: \.self) { folder in
                        HStack {
                            Image(systemName: "folder")
                            Text(folder).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button { Task { await model.removeFolder(folder) } } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.borderless)
                                .disabled(model.config.pcAgentFolders.count <= 1)
                        }
                    }
                    Button("เพิ่มโฟลเดอร์…") { chooseFolder() }
                    if !problem.isEmpty { Text(problem).font(.caption).foregroundStyle(.red) }
                }
                Button("เปิดเบราว์เซอร์ของ Mimi") { model.openAgentBrowser() }
                    .disabled(!model.signedIn)
                    .help("Edge/Chrome ด้วยโปรไฟล์ของ agent — ล็อกอินเว็บที่ให้ agent ใช้ไว้ที่นี่ (เก็บไว้หลังปิด)")
            }
            Section("แอป") {
                LabeledContent("เวอร์ชัน", value: AppModel.version)
                LabeledContent("เซิร์ฟเวอร์ในเครื่องนี้", value: model.config.localServer ? "เปิดพร้อมแอป" : "ไม่ใช้")
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 560)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory())
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { problem = await model.addFolder(url) ?? "" }
    }
}
