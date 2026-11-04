import AppKit
import MimiKit
import SwiftUI

/// The window: the chat list on the side (the web's side panel), the open chat beside it.
struct MainView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationSplitView {
            ChatListView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 380)
        } detail: {
            if model.selectedChat != nil {
                ChatScreen()
            } else {
                ContentUnavailableView("เลือกแชต", systemImage: "bubble.left.and.bubble.right", description: Text("หรือเริ่มแชตใหม่กับ agent จากปุ่ม +"))
            }
        }
        .safeAreaInset(edge: .top) {
            if let line = connectionLine {
                Text(line).font(.caption).foregroundStyle(.orange).frame(maxWidth: .infinity).padding(4).background(.bar)
            }
        }
    }

    private var connectionLine: String? {
        switch model.session.state {
        case .connecting: return "กำลังเชื่อมต่อ…"
        case .offline(let retry): return retry > 0 ? "หลุดการเชื่อมต่อ ลองใหม่ใน \(Int(retry.rounded(.up))) วินาที…" : "หลุดการเชื่อมต่อ กำลังต่อใหม่…"
        case .rateLimited: return "ใส่รหัสผิดหลายครั้งเกินไป รอ 15 นาทีแล้วจะลองใหม่เอง"
        case .appTooOld: return "เซิร์ฟเวอร์ต้องการแอปเวอร์ชันใหม่กว่านี้ กรุณาอัปเดต Mimi"
        default: return model.banner.isEmpty ? nil : model.banner
        }
    }
}

struct ChatListView: View {
    @Environment(AppModel.self) private var model
    @State private var groupSheet = false

    var body: some View {
        @Bindable var list = model.list
        VStack(spacing: 0) {
            Picker("", selection: $list.showingDirect) {
                Text("ตัวต่อตัว").tag(true)
                Text("กลุ่ม").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            List(selection: Binding(get: { model.selectedChat }, set: { if let id = $0 { model.open(id) } })) {
                ForEach(list.rows) { row in
                    ChatRowView(row: row).tag(row.id)
                }
            }
            .overlay {
                if list.rows.isEmpty {
                    Text(list.showingDirect ? "ยังไม่มีแชต — กด + เพื่อเริ่มคุยกับ agent" : "ยังไม่มีแชตกลุ่ม").font(.callout).foregroundStyle(.secondary).padding()
                }
            }
            HStack {
                Circle().fill(model.session.pcOnline ? .green : .secondary).frame(width: 7, height: 7)
                Text("PC agent: \(model.config.pcAgentEnabled ? model.pcStatus : "ปิด")").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(8)
        }
        .toolbar {
            ToolbarItem {
                Menu {
                    ForEach(list.agents) { agent in
                        Button(agent.shownName) { list.newChat(agent.name) }
                    }
                    Divider()
                    Button("แชตกลุ่มใหม่…") { groupSheet = true }
                } label: {
                    Label("แชตใหม่", systemImage: "square.and.pencil")
                }
                .disabled(list.agents.isEmpty)
            }
        }
        .sheet(isPresented: $groupSheet) { NewGroupSheet() }
    }
}

struct ChatRowView: View {
    let row: ChatRow

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(path: row.avatar, initial: row.initial, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(row.title).font(.body.weight(row.unread ? .bold : .regular)).lineLimit(1)
                    Spacer()
                    Text(row.when).font(.caption2).foregroundStyle(.secondary)
                }
                Text(row.busy ? "กำลังพิมพ์…" : row.preview).font(.caption).foregroundStyle(row.busy ? Palette.accent : .secondary).lineLimit(1)
            }
            if row.unread { Circle().fill(Palette.accent).frame(width: 8, height: 8) }
        }
        .padding(.vertical, 3)
    }
}

struct NewGroupSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var chosen: [String] = []
    @State private var problem = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("แชตกลุ่มใหม่").font(.headline)
            TextField("ชื่อกลุ่ม (ไม่บังคับ)", text: $title).textFieldStyle(.roundedBorder)
            Text("สมาชิก (คนแรกตอบเมื่อไม่ได้ @ ใคร)").font(.caption).foregroundStyle(.secondary)
            ForEach(model.list.agents) { agent in
                Toggle(agent.shownName, isOn: Binding(get: { chosen.contains(agent.name) }, set: { on in
                    if on { chosen.append(agent.name) } else { chosen.removeAll { $0 == agent.name } }
                }))
            }
            if !problem.isEmpty { Text(problem).foregroundStyle(.red).font(.callout) }
            HStack {
                Spacer()
                Button("ยกเลิก") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("สร้าง") {
                    if let refused = model.list.newGroup(title: title, agents: chosen) { problem = refused } else { dismiss() }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 340)
    }
}

/// A picture from the server, fetched with the token (the server's images need it) and kept for the session.
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private var images: [String: NSImage] = [:]
    private var loading: [String: Task<Data?, Never>] = [:]

    func image(_ path: String, api: MimiAPI) async -> NSImage? {
        if let known = images[path] { return known }
        let task = loading[path] ?? Task<Data?, Never> { try? await api.bytes(path) }
        loading[path] = task
        let data = await task.value
        loading[path] = nil
        if let known = images[path] { return known }
        guard let data, let image = NSImage(data: data) else { return nil }
        images[path] = image
        return image
    }

    func clear() { images = [:] }
}

struct AvatarView: View {
    @Environment(AppModel.self) private var model
    let path: String?
    let initial: String
    let size: CGFloat
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Palette.accentSoft
                Text(initial).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(Palette.accent)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: path) {
            guard let path else { return }
            image = await ImageCache.shared.image(path, api: model.session.api)
        }
    }
}
