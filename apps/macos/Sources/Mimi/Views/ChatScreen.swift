import AppKit
import MimiKit
import SwiftUI
import UniformTypeIdentifiers

/// One open chat: the conversation as the web shows it, the answer streaming in, permission and approval
/// cards, and the composer (Enter sends, Shift+Enter a new line, Esc stops, files by button, drop or paste).
struct ChatScreen: View {
    @Environment(AppModel.self) private var model
    @State private var importing = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        let chat = model.chat
        VStack(spacing: 0) {
            if !chat.pins.isEmpty { pinBar(chat) }
            if chat.olderSession {
                Button("กำลังดู session เก่า — กลับไปล่าสุด") { chat.backToLatest() }.buttonStyle(.link).padding(6)
            }
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if chat.hasMore { Button("โหลดข้อความเก่า") { chat.loadOlder() }.frame(maxWidth: .infinity) }
                        ForEach(chat.items) { item in
                            ChatItemView(item: item).id(item.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(14)
                }
                .onChange(of: chat.grew) { _, _ in withAnimation(.easeOut(duration: 0.15)) { scroll.scrollTo("bottom", anchor: .bottom) } }
                .onAppear { scroll.scrollTo("bottom", anchor: .bottom) }
            }
            if !chat.status.isEmpty { Text(chat.status).font(.caption).foregroundStyle(.secondary).padding(.bottom, 2) }
            composer(chat)
        }
        .navigationTitle(chat.title.isEmpty ? "แชต" : chat.title)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in await attach(url) } }
                }
            }
            return true
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { for url in urls { await attach(url) } } }
        }
        .onAppear { composerFocused = true }
    }

    private func pinBar(_ chat: ChatModel) -> some View {
        HStack {
            Image(systemName: "pin.fill").foregroundStyle(Palette.accent)
            Text(chat.pins.count > 1 ? "ปักหมุด \(chat.pins.count)" : "ปักหมุด").font(.caption.bold())
            Text(MessageFormat.preview(chat.pins[0].text, max: 120)).font(.caption).lineLimit(1)
            Spacer()
            Button { chat.pin(chat.pins[0].id, false) } label: { Image(systemName: "pin.slash") }.buttonStyle(.borderless).help("เลิกปักหมุด")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Palette.accentSoft)
    }

    private func composer(_ chat: ChatModel) -> some View {
        @Bindable var chat = chat
        return VStack(alignment: .leading, spacing: 4) {
            let options = chat.mentionOptions
            if !options.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(options, id: \.name) { option in
                        Button { chat.pickMention(option.name) } label: {
                            HStack { Text(option.shown); Text("@\(option.name)").foregroundStyle(.secondary).font(.caption) }
                        }
                        .buttonStyle(.borderless)
                        .padding(4)
                    }
                }
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 8).fill(Palette.panel))
            }
            if let reply = chat.replying {
                HStack {
                    Text("ตอบกลับ \(reply.who): \(MessageFormat.preview(reply.text, max: 100))").font(.caption).lineLimit(1)
                    Spacer()
                    Button { chat.replying = nil } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.borderless)
                }
            }
            if !chat.staged.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(chat.staged) { file in
                            HStack(spacing: 4) {
                                Image(systemName: file.isImage ? "photo" : "doc")
                                Text(file.name).lineLimit(1).frame(maxWidth: 160)
                                Button { chat.unstage(file.id) } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
                            }
                            .font(.caption)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Capsule().fill(Palette.accentSoft))
                        }
                    }
                }
            }
            if !chat.error.isEmpty { Text(chat.error).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom, spacing: 6) {
                Button { importing = true } label: { Image(systemName: "paperclip") }.buttonStyle(.borderless).help("แนบไฟล์")
                TextField("พิมพ์ข้อความ…", text: $chat.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($composerFocused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        if let first = chat.mentionOptions.first {
                            chat.pickMention(first.name)
                            return .handled
                        }
                        chat.send()
                        return .handled
                    }
                    .onKeyPress(.tab) {
                        guard let first = chat.mentionOptions.first else { return .ignored }
                        chat.pickMention(first.name)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        guard chat.draft.isEmpty, chat.busy else { return .ignored }
                        chat.stop()
                        return .handled
                    }
                    .onPasteCommand(of: [.fileURL, .png, .tiff]) { providers in paste(providers) }
                if chat.busy {
                    Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2) }.buttonStyle(.borderless).help("หยุด (Esc)")
                } else {
                    Button { chat.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless)
                        .disabled(!chat.canSend)
                        .help("ส่ง (Enter)")
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 14).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(.separator))
            Text("Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่").font(.caption2).foregroundStyle(.tertiary).padding(.leading, 8)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
    }

    private func attach(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            model.chat.error = "อ่านไฟล์ \(url.lastPathComponent) ไม่ได้"
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        await model.chat.attach(data, name: url.lastPathComponent, mime: mime)
    }

    /// Ctrl/⌘+V of files or a picture (a screenshot, a copied image) attaches them instead of pasting text.
    private func paste(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in if let url { Task { @MainActor in await attach(url) } } }
            } else if provider.canLoadObject(ofClass: NSImage.self) {
                _ = provider.loadObject(ofClass: NSImage.self) { image, _ in
                    guard let image = image as? NSImage, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                    let name = "pasted-\(Int(Date().timeIntervalSince1970)).png"
                    Task { @MainActor in await model.chat.attach(png, name: name, mime: "image/png") }
                }
            }
        }
    }
}

struct ChatItemView: View {
    @Environment(AppModel.self) private var model
    let item: ChatItem

    var body: some View {
        switch item {
        case .message(_, let id, let isUser, let who, let text, let mood, let files, let tools, let time, let approval, let quote, let forwarded, let reactions, let pinned):
            HStack {
                if isUser { Spacer(minLength: 40) }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(who).font(.caption.bold())
                        if let mood { Text(mood).font(.caption2).foregroundStyle(.secondary) }
                        if pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Palette.accent) }
                        Text(time).font(.caption2).foregroundStyle(.tertiary)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        if let forwarded { Text(forwarded).font(.caption).italic().foregroundStyle(.secondary) }
                        if let quote { Text(quote).font(.caption).foregroundStyle(.secondary).padding(6).background(RoundedRectangle(cornerRadius: 6).fill(.quaternary)) }
                        if !text.isEmpty { MessageText(text: text) }
                        ForEach(Array(files.enumerated()), id: \.offset) { _, file in FileView(file: file) }
                        if !tools.isEmpty { Text(tools).font(.caption).foregroundStyle(.secondary) }
                        if let approval { ApprovalCard(approval: approval) }
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 12).fill(isUser ? Palette.userBubble : Palette.panel))
                    if !reactions.isEmpty { Text(reactions.joined(separator: " ")).font(.caption) }
                }
                .contextMenu {
                    ForEach(ChatModel.quickReactions, id: \.self) { emoji in Button(emoji) { model.chat.react(id, emoji) } }
                    Divider()
                    Button("ตอบกลับ") { model.chat.reply(to: id) }
                    Button(pinned ? "เลิกปักหมุด" : "ปักหมุด") { model.chat.pin(id, !pinned) }
                    Button("คัดลอก") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                    }
                }
                if !isUser { Spacer(minLength: 40) }
            }
        case .pending(_, let text, let files, let failed):
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(text.isEmpty ? files : text).padding(10).background(RoundedRectangle(cornerRadius: 12).fill(Palette.userBubble.opacity(0.6)))
                    Text(failed.map { "ส่งไม่ได้: \($0)" } ?? "กำลังส่ง…").font(.caption2).foregroundStyle(failed == nil ? Color.secondary : Color.red)
                }
            }
        case .live(_, let who, let parts, let helper, let finished):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(who).font(.caption.bold())
                    if let helper { Text("· \(helper) ช่วยอยู่").font(.caption2).foregroundStyle(.secondary) }
                    if !finished { ProgressView().controlSize(.mini) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    if parts.isEmpty && !finished { Text("กำลังคิด…").foregroundStyle(.secondary) }
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text): MessageText(text: text)
                        case .tool(let tool): ToolLine(tool: tool)
                        case .file(let file): FileView(file: file)
                        }
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 12).fill(Palette.panel))
            }
        case .note(_, let text, let bad):
            Text(text).font(.caption).foregroundStyle(bad ? .red : .secondary).frame(maxWidth: .infinity)
        case .permission(_, let request, let who, let detail):
            PermissionCard(request: request, who: who, detail: detail)
        case .task(_, _, let goal, let status, let steps, let summary):
            VStack(alignment: .leading, spacing: 4) {
                HStack { Image(systemName: "checklist"); Text(goal).bold(); Spacer(); Text(status).font(.caption) }
                if !steps.isEmpty { Text(steps).font(.caption) }
                if !summary.isEmpty { Text(summary).font(.caption).foregroundStyle(.secondary) }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).stroke(.separator))
        }
    }
}

/// Message text by the web's rules (MessageFormat): code blocks, `code`, **bold**, *actions*, links, @mentions.
struct MessageText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MessageFormat.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code):
                    Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(.quaternary))
                case .paragraph(let spans):
                    Text(Self.attributed(spans)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    static func attributed(_ spans: [Span]) -> AttributedString {
        var out = AttributedString()
        for span in spans {
            var piece: AttributedString
            switch span {
            case .plain(let value): piece = AttributedString(value)
            case .code(let value):
                piece = AttributedString(value)
                piece.font = .system(.body, design: .monospaced)
                piece.backgroundColor = .secondary.opacity(0.15)
            case .bold(let value):
                piece = AttributedString(value)
                piece.font = .body.bold()
            case .action(let value):
                piece = AttributedString(value)
                piece.font = .body.italic()
                piece.foregroundColor = .secondary
            case .link(let value):
                piece = AttributedString(value)
                piece.link = URL(string: value)
            case .mention(let value):
                piece = AttributedString(value)
                piece.foregroundColor = Palette.accent
            }
            out += piece
        }
        return out
    }
}

struct ToolLine: View {
    let tool: ToolRow
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Text(tool.mark).foregroundStyle(tool.ok == false ? .red : tool.ok == true ? .green : .secondary)
                    Text(tool.name).font(.caption.monospaced().bold())
                    Text(tool.arg).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            if open, !tool.output.isEmpty {
                Text(tool.output).font(.caption2.monospaced()).textSelection(.enabled).lineLimit(20)
            }
        }
    }
}

struct FileView: View {
    @Environment(AppModel.self) private var model
    let file: FileItem
    @State private var image: NSImage?

    var body: some View {
        if file.gone {
            Text("(ไฟล์ \(file.name) ถูกลบแล้ว)").font(.caption).foregroundStyle(.secondary)
        } else if file.isImage {
            Group {
                if let image {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 320, maxHeight: 320).clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    ProgressView().frame(width: 120, height: 80)
                }
            }
            .task(id: file.path) { image = await ImageCache.shared.image(file.path, api: model.session.api) }
            .onTapGesture { Task { await open() } }
        } else {
            Button { Task { await open() } } label: { Label(file.name, systemImage: "doc") }.buttonStyle(.link)
        }
    }

    /// Downloads into the cache and opens it with its Mac app.
    private func open() async {
        guard let data = try? await model.session.api.bytes(file.path) else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mimi-files", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(file.name.replacingOccurrences(of: "/", with: "_"))
        guard (try? data.write(to: target)) != nil else { return }
        NSWorkspace.shared.open(target)
    }
}

struct PermissionCard: View {
    @Environment(AppModel.self) private var model
    let request: PermissionRequest
    let who: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("\(who) ขออนุญาต", systemImage: "lock.shield").font(.callout.bold())
            Text(request.summary.isEmpty ? "ขอใช้ \(request.tool)" : request.summary)
            Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
            HStack {
                Button("ไม่อนุญาต") { model.chat.answer(request.id, allow: false) }
                Button("ครั้งนี้") { model.chat.answer(request.id, allow: true, scope: "once") }.buttonStyle(.borderedProminent)
                if !request.noGrant {
                    Menu("อนุญาตนานกว่านั้น") {
                        Button("ตลอดงานนี้") { model.chat.answer(request.id, allow: true, scope: "task") }
                        Button("ตลอด session นี้") { model.chat.answer(request.id, allow: true, scope: "session") }
                        Button("ตลอดไป") { model.chat.answer(request.id, allow: true, scope: "always") }
                    }
                    .fixedSize()
                }
            }
        }
        .padding(12)
        .frame(maxWidth: 460, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).stroke(Palette.accent))
    }
}

struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    let approval: ApprovalView

    var body: some View {
        if approval.status == "pending" {
            HStack {
                Text("workflow \(approval.workflow) รออนุมัติ").font(.caption)
                Button("อนุมัติ") { model.chat.approve(approval.id, true) }.buttonStyle(.borderedProminent)
                Button("ไม่อนุมัติ") { model.chat.approve(approval.id, false) }
            }
        } else {
            Text(approval.status == "approved" ? "✓ อนุมัติแล้ว" : approval.status == "rejected" ? "✗ ไม่อนุมัติ" : approval.status).font(.caption).foregroundStyle(.secondary)
        }
    }
}
