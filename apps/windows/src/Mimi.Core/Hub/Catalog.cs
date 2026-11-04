using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Protocol;

namespace Mimi.Core.Hub;

/// <summary>A tab of a management page: one or more lists, one under the other.</summary>
public sealed record PageTab(string Key, string Label, string Lead, IReadOnlyList<EntityDef> Lists);

/// <summary>
/// Every management list of the web client (Agent, Hub's ten tabs, Workflow, Overseer, Settings), as
/// definitions the generic screens run. Labels and hints follow the web page (app.js and feature-*.js);
/// the frames are protocol.ts ClientMessage, the replies its ServerMessage.
/// </summary>
public static class Catalog
{
    private static string F(string type, params (string Key, JsonNode? Value)[] fields) => ClientFrames.Json(type, J.O(fields));

    private static JsonNode? N(string text) => JsonValue.Create(text);

    private static JsonNode? Node(JsonElement json) => json.ValueKind == JsonValueKind.Undefined ? null : JsonNode.Parse(json.GetRawText());

    private static JsonArray Arr(IEnumerable<string> items) => new(items.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray());

    private static string When(string iso) => DateTimeOffset.TryParse(iso, out var at) ? at.ToLocalTime().ToString("d MMM yy HH:mm", new System.Globalization.CultureInfo("th-TH")) : "";

    private static readonly IReadOnlyList<(string, string)> Reasoning =
        [("", "ค่าเริ่มต้นของผู้ให้บริการ"), ("none", "none — ไม่คิด (เร็วสุด)"), ("minimal", "minimal"), ("low", "low"), ("medium", "medium"), ("high", "high"), ("xhigh", "xhigh"), ("max", "max — คิดเต็มที่ (ช้าสุด)")];

    private static readonly IReadOnlyList<(string, string)> Risks = [("read", "read"), ("write", "write"), ("shell", "shell"), ("delete", "delete"), ("network", "network")];

    // ---------- Agent ----------

    public static readonly IReadOnlyList<FieldSpec> AgentFields =
    [
        new("name", "ชื่อ (id ภาษาอังกฤษตัวเล็ก)", Hint: "ใช้ใน @ชื่อ และชื่อโฟลเดอร์"),
        new("displayName", "ชื่อที่แสดง"),
        new("description", "คำอธิบายสั้น ๆ"),
        new("intro", "การ์ดแนะนำตัว (agent อื่นเห็น)", FieldKind.Multiline),
        new("systemPrompt", "บุคลิกและคำสั่ง (system prompt)", FieldKind.Multiline,
            "ตัวแปรที่ใช้ได้: {{user}} = ข้อมูลผู้ใช้จากโปรไฟล์, {{char}} = agent นี้, {{id <ชื่อ agent>}} = agent อื่น, {{tim}} = เวลา — ข้อมูลผู้ใช้ถูกเติมตอนรัน ไม่ต้องพิมพ์เอง"),
        new("models.model", "โมเดลหลัก (core) — ตอบทุกอย่าง", FieldKind.Choice, "ว่าง = ใช้โมเดลเริ่มต้นในตั้งค่า", OptionsFrom: "models"),
        new("models.small_model", "โมเดลเล็ก (สรุป ความจำ งานเบื้องหลัง)", FieldKind.Choice, OptionsFrom: "models"),
        new("models.vision_model", "ตัวช่วยอ่านรูป / PDF / วิดีโอ → ข้อความ", FieldKind.Choice, OptionsFrom: "models"),
        new("models.transcript_model", "ตัวช่วยถอดเสียง → ข้อความ", FieldKind.Choice, OptionsFrom: "models"),
        new("models.image_model", "สร้างรูปภาพ (generate_image)", FieldKind.Choice, OptionsFrom: "models"),
        new("models.speech_model", "สร้างเสียงพูด (text_to_speech)", FieldKind.Choice, OptionsFrom: "models"),
        new("models.video_model", "สร้างวิดีโอ (generate_video)", FieldKind.Choice, OptionsFrom: "models"),
        new("skills", "Skill ที่ใช้ได้", FieldKind.List, OptionsFrom: "skills"),
        new("canMessage", "ส่งข้อความหา agent เหล่านี้ได้", FieldKind.List, OptionsFrom: "agents"),
        new("budgets.maxRounds", "รอบสูงสุดต่อคำถาม", FieldKind.Number),
        new("budgets.maxTokens", "token สูงสุดต่อคำถาม", FieldKind.Number),
        new("character", "แสดงตัวเป็น", FieldKind.Choice, Options: [("sprite", "รูปนิ่ง (sprite)"), ("vrm", "โมเดล 3D (VRM)")]),
        new("idleMotion", "ท่าตอนยืนเฉย (ชื่อคลิป Mixamo)"),
    ];

    private static readonly string[] AgentReadOnly = ["status", "avatar", "portrait", "sprites", "model", "motions"];

    public static readonly EntityDef Agents = new(
        "agents", "Agent", "แต่ละตัวมีบุคลิก โมเดล skill และเครื่องมือของตัวเอง คุยตัวต่อตัวหรือจับเข้ากลุ่มก็ได้",
        F("agents-list"), "agents",
        reply => reply.A("agents"),
        agent => agent.S("name"),
        agent => agent.S("displayName") is { Length: > 0 } shown ? $"{shown} ({agent.S("name")})" : agent.S("name"),
        agent => agent.S("description"),
        New: () => J.O(("name", N("")), ("displayName", N("")), ("description", N("")), ("systemPrompt", N("")), ("models", new JsonObject()),
            ("tools", new JsonArray()), ("canMessage", new JsonArray()), ("skills", new JsonArray()),
            ("budgets", J.O(("maxRounds", 12), ("maxTokens", 200000)))),
        Save: (agent, before) => F("agent-save", ("agent", agent.Without(AgentReadOnly)), ("renameFrom", before is not null ? N(before) : null)),
        Delete: agent => F("agent-delete", ("name", N(agent.S("name")))),
        Fields: AgentFields,
        Requests: ["agent-save", "agent-delete"],
        Actions:
        [
            new("ทักแชต agent นี้", (_, _) => null, View: "chat"),
            new("ตัวละคร 3D: ดู / เล่นท่า / ท่ายืนเฉย", (_, _) => null, View: "vrm", When: agent => agent.S("model").Length > 0),
            new("อัปโหลดโมเดล 3D (.vrm)", (_, _) => null, UploadPath: (agent, _) => $"/api/agent-model/{Uri.EscapeDataString(agent.S("name"))}", UploadFilter: ".vrm"),
            new("ลบโมเดล 3D", (_, _) => null, DeletePath: agent => $"/api/agent-model/{Uri.EscapeDataString(agent.S("name"))}", Confirm: "ลบโมเดล 3D?", When: agent => agent.S("model").Length > 0),
            new("เพิ่มท่า (Mixamo .fbx)", (_, _) => null, Ask: [new("name", "ชื่อท่า")],
                UploadPath: (agent, input) => $"/api/agent-motion/{Uri.EscapeDataString(agent.S("name"))}/{Uri.EscapeDataString(input.Str("name"))}", UploadFilter: ".fbx"),
            new("แกลเลอรีภาพสถานการณ์ (ค้นหา / เพิ่มหลายรูป / แก้ / แสดงในแชต)", (_, _) => null, View: "gallery"),
        ]);

    /// <summary>The setup wizard's starter agents (feature-setup.js): pick one and it becomes an ordinary agent.</summary>
    public static readonly EntityDef AgentPresets = new(
        "agent-presets", "แบบ agent สำเร็จรูป", "เลขาส่วนตัว / นักค้นคว้า / ผู้ช่วยจัดการเครื่อง / ผู้ช่วยเขียนโค้ด — สร้างแล้วแก้ต่อได้ที่รายการ Agent",
        F("agent-presets"), "agent-presets",
        reply => reply.A("presets"),
        preset => preset.S("id"),
        preset => $"{preset.S("label")} — {preset.S("displayName")}",
        preset => preset.S("summary"),
        Fields: [new("description", "คำอธิบาย", FieldKind.ReadOnly), new("summary", "ทำอะไรได้ / ไม่ได้", FieldKind.ReadOnly), new("tools", "เครื่องมือ", FieldKind.ReadOnly), new("systemPrompt", "บุคลิกและคำสั่ง", FieldKind.ReadOnly)],
        Requests: ["agent-save"],
        Actions:
        [
            new("สร้าง agent จากแบบนี้", (preset, input) => F("agent-save", ("agent", J.O(
                    ("name", N(input.Str("name") is { Length: > 0 } name ? name : preset.S("name"))),
                    ("displayName", N(preset.S("displayName"))),
                    ("description", N(preset.S("description"))),
                    ("systemPrompt", N(preset.S("systemPrompt"))),
                    ("models", input.Str("model") is { Length: > 0 } model ? J.O(("model", N(model))) : new JsonObject()),
                    ("tools", Arr(preset.Strings("tools"))),
                    ("canMessage", new JsonArray()),
                    ("budgets", J.O(("maxRounds", 12), ("maxTokens", 200000)))))),
                Ask: [new("name", "ชื่อ (id) — ว่าง = ใช้ชื่อที่แนะนำ"), new("model", "โมเดลหลัก (ว่าง = โมเดลเริ่มต้น)", FieldKind.Choice, OptionsFrom: "models")]),
        ]);

    // ---------- Hub ----------

    public static readonly EntityDef Presets = new(
        "presets", "กองโมเดล", "ชุด \"โมเดล + ค่าการสุ่ม\" ที่ตั้งชื่อไว้ แล้วเลือกใช้ได้ทุกที่ที่เลือกโมเดล (agent, skill, workflow)",
        F("settings-get"), "settings",
        reply => reply.A("settings.presets"),
        preset => preset.S("name"),
        preset => preset.S("name"),
        preset => J.Join([preset.S("model"), preset.S("temperature") is { Length: > 0 } temperature ? $"temp {temperature}" : "", preset.S("topP") is { Length: > 0 } topP ? $"top_p {topP}" : "", preset.S("topK") is { Length: > 0 } topK ? $"top_k {topK}" : ""], " · "),
        New: () => J.O(("name", N("")), ("model", N(""))),
        Save: (preset, before) => F("preset-save", ("preset", preset), ("renameFrom", before is not null ? N(before) : null)),
        Delete: preset => F("preset-delete", ("name", N(preset.S("name")))),
        Fields:
        [
            new("name", "ชื่อ preset"),
            new("model", "โมเดล", FieldKind.Choice, OptionsFrom: "models-only"),
            new("maxOutputTokens", "token ตอบสูงสุด", FieldKind.Number),
            new("minTokens", "token ตอบอย่างน้อย", FieldKind.Number),
            new("presencePenalty", "presence penalty", FieldKind.Number),
            new("frequencyPenalty", "frequency penalty", FieldKind.Number),
            new("repetitionPenalty", "repetition penalty", FieldKind.Number),
            new("reasoning", "ความคิดก่อนตอบ (reasoning)", FieldKind.Choice, Options: Reasoning),
        ],
        Requests: ["preset-save", "preset-delete"]);

    public static readonly EntityDef Skills = new(
        "skills", "Skill", "คู่มือการทำงานเฉพาะเรื่อง (เช่น เขียนเพลง ตรวจสัญญา) ที่ agent หยิบไปใช้เมื่องานตรงเรื่อง · เขียนเองหรือนำเข้าไฟล์ .md",
        F("skills-list"), "skills",
        reply => reply.A("skills"),
        skill => skill.S("name"),
        skill => skill.B("builtin") ? $"{skill.S("name")} (มากับแอป)" : skill.S("name"),
        skill => J.Join([skill.S("model") is { Length: > 0 } model ? $"โมเดล {model}" : "", skill.S("description"), skill.A("tools").Count() > 0 ? $"{skill.A("tools").Count()} tools" : ""], " · "),
        New: () => J.O(("name", N("")), ("description", N("")), ("model", N("")), ("tools", new JsonArray()), ("body", N(""))),
        Save: (skill, before) => F("skill-save", ("skill", skill.Without("builtin")), ("renameFrom", before is not null ? N(before) : null)),
        Delete: skill => F("skill-delete", ("name", N(skill.S("name")))),
        Fields:
        [
            new("name", "ชื่อ skill"),
            new("description", "ใช้เมื่อไร (agent อ่านบรรทัดนี้เพื่อเลือก)", FieldKind.Multiline),
            new("model", "รันด้วยโมเดลของตัวเอง", FieldKind.Choice, "ว่าง = agent ทำตามคู่มือเอง", OptionsFrom: "models"),
            new("tools", "เครื่องมือที่ skill ใช้ได้", FieldKind.List, "ใช้เฉพาะเมื่อ skill รันแยกด้วยโมเดลของตัวเอง", OptionsFrom: "tools"),
            new("body", "คู่มือ (Markdown)", FieldKind.Multiline),
        ],
        Requests: ["skill-save", "skill-delete"]);

    public static readonly EntityDef Tools = new(
        "tools", "เครื่องมือทั้งหมด", "ทุกอย่างที่ agent เรียกใช้ได้ และวางใน workflow ได้ (มากับแอป, MCP, connector, ที่เพิ่มเอง)",
        F("tools-list"), "tools",
        reply => reply.A("tools"),
        tool => tool.S("name"),
        tool => tool.S("name"),
        tool => J.Join([tool.S("risk"), tool.S("target") == "pc" ? "บนเครื่อง (PC)" : "", tool.S("familyLabel"), tool.S("mcp") is { Length: > 0 } mcp ? $"MCP {mcp}" : "", tool.S("description")], " · "),
        Fields: [new("name", "ชื่อ", FieldKind.ReadOnly), new("description", "คำอธิบาย", FieldKind.ReadOnly), new("risk", "ความเสี่ยง", FieldKind.ReadOnly), new("target", "ทำงานที่", FieldKind.ReadOnly), new("settings", "ค่าที่ตั้งได้ (preset)", FieldKind.ReadOnly), new("presets", "preset", FieldKind.ReadOnly)]);

    public static readonly EntityDef ToolPresets = new(
        "tool-presets", "Preset ของเครื่องมือ", "เครื่องมือที่ตั้งค่าไว้แล้ว (เช่น บัญชี, ช่อง Slack) เพื่อใช้ซ้ำ",
        null, "tools",
        reply => reply.A("presets"),
        preset => preset.S("name"),
        preset => preset.S("label") is { Length: > 0 } label ? $"{label} ({preset.S("name")})" : preset.S("name"),
        preset => $"{preset.S("tool")} · {preset.S("description")}",
        New: () => J.O(("name", N("")), ("tool", N("")), ("label", N("")), ("description", N("")), ("settings", new JsonObject())),
        Save: (preset, before) => F("tool-preset-save", ("preset", preset), ("renameFrom", before is not null ? N(before) : null)),
        Delete: preset => F("tool-preset-delete", ("name", N(preset.S("name")))),
        Fields:
        [
            new("name", "ชื่อ preset"),
            new("tool", "เครื่องมือ", FieldKind.Choice, OptionsFrom: "tools"),
            new("label", "ชื่อที่แสดง"),
            new("description", "คำอธิบาย", FieldKind.Multiline),
            new("settings", "ค่าที่ตั้งของเครื่องมือนี้", FieldKind.Dynamic, Expand: ServerFields.PresetSettings),
        ],
        Requests: ["tool-preset-save", "tool-preset-delete"]);

    public static readonly EntityDef CustomTools = new(
        "custom-tools", "เครื่องมือที่เพิ่มเอง", "HTTP request, โค้ด หรือคำสั่ง shell ที่ห่อเป็นเครื่องมือ",
        null, "tools",
        reply => reply.A("custom"),
        tool => tool.S("name"),
        tool => tool.S("name"),
        tool => $"{tool.S("kind")} · {tool.S("description")}",
        New: () => J.O(("name", N("")), ("description", N("")), ("kind", N("http")), ("params", new JsonArray()), ("settings", new JsonArray()),
            ("config", J.O(("method", N("GET")), ("url", N(""))))),
        Save: (tool, before) => F("tool-save", ("tool", tool), ("renameFrom", before is not null ? N(before) : null)),
        Delete: tool => F("tool-delete", ("name", N(tool.S("name")))),
        Fields:
        [
            new("name", "ชื่อเครื่องมือ (a-z, _)"),
            new("description", "agent ใช้เมื่อไร", FieldKind.Multiline),
            new("kind", "ชนิด", FieldKind.Choice, Options: [("http", "HTTP request"), ("code", "โค้ด JavaScript"), ("shell", "คำสั่ง shell")]),
            new("params", "พารามิเตอร์ที่ agent ส่ง", FieldKind.Json, "[{\"key\":\"q\",\"type\":\"string\",\"description\":\"…\",\"required\":true}]"),
            new("settings", "ค่าที่ตั้งได้ (preset)", FieldKind.Json),
            new("config", "การทำงาน (url, method, headers, body / code / command)", FieldKind.Json),
        ],
        Requests: ["tool-save", "tool-delete"]);

    public static readonly EntityDef McpServers = new(
        "mcp", "MCP server", "เครื่องมือจาก MCP server (stdio, Streamable HTTP, HTTP+SSE) · ใส่ {{secret.ชื่อ}} ใน env/headers ได้",
        null, "tools",
        reply => reply.A("mcp"),
        server => server.S("name"),
        server => server.S("title") is { Length: > 0 } title ? $"{title} ({server.S("name")})" : server.S("name"),
        server => J.Join([server.B("enabled") ? "เปิด" : "ปิด", server.S("transport"), $"{server.A("tools").Count()} เครื่องมือ", server.S("error") is { Length: > 0 } error ? $"ผิดพลาด: {error}" : ""], " · "),
        New: () => J.O(("name", N("")), ("enabled", true), ("transport", N("stdio")), ("command", N("")), ("args", new JsonArray())),
        Save: (server, before) => F("mcp-save", ("server", server.Without("tools", "checkedAt", "latencyMs", "error")), ("renameFrom", before is not null ? N(before) : null)),
        Delete: server => F("mcp-delete", ("name", N(server.S("name")))),
        Fields:
        [
            new("name", "ชื่อ (a-z)"),
            new("title", "ชื่อที่แสดง"),
            new("enabled", "เปิดใช้", FieldKind.Bool),
            new("transport", "ต่อแบบ", FieldKind.Choice, Options: [("stdio", "stdio (รันโปรแกรม)"), ("http", "Streamable HTTP"), ("sse", "HTTP + SSE")]),
            new("command", "คำสั่ง (stdio)"),
            new("args", "อาร์กิวเมนต์ (บรรทัดละตัว)", FieldKind.List),
            new("cwd", "โฟลเดอร์ที่รัน"),
            new("env", "ตัวแปรแวดล้อม (JSON)", FieldKind.Json),
            new("url", "URL (http / sse)"),
            new("headers", "header (JSON)", FieldKind.Json),
            new("risk", "ความเสี่ยงของเครื่องมือ", FieldKind.Choice, Options: Risks),
            new("untrusted", "ผลลัพธ์ไม่น่าเชื่อถือ (กัน prompt injection)", FieldKind.Bool),
            new("runsOn", "รันที่", FieldKind.Choice, Options: [("core", "เซิร์ฟเวอร์ (core)"), ("pc", "เครื่องนี้ (PC agent)")]),
        ],
        Requests: ["mcp-save", "mcp-delete", "mcp-refresh"],
        Actions: [new("ตรวจ / โหลดเครื่องมือใหม่", (server, _) => F("mcp-refresh", ("name", N(server.S("name")))))]);

    public static readonly EntityDef ImportedConnectors = new(
        "connectors", "Connector", "บริการที่ต่อไว้ (มากับแอป หรือนำเข้าจาก OpenAPI) · นำเข้า OpenAPI ได้จากปุ่มด้านบน",
        null, "tools",
        reply => reply.A("connectors"),
        connector => connector.S("key"),
        connector => connector.S("label") is { Length: > 0 } label ? label : connector.S("key"),
        connector => J.Join([connector.S("category"), connector.S("imported") == "true" ? "นำเข้า" : "", $"{connector.A("operations").Count()} operation"], " · "),
        Delete: connector => F("connector-import-delete", ("key", N(connector.S("key")))),
        Fields: [new("key", "key", FieldKind.ReadOnly), new("label", "ชื่อ", FieldKind.ReadOnly), new("description", "คำอธิบาย", FieldKind.ReadOnly), new("operations", "operation", FieldKind.ReadOnly)],
        Requests: ["connector-import-delete", "connector-import-preview", "connector-import-save"],
        Actions:
        [
            new("ตรวจไฟล์ OpenAPI (ยังไม่บันทึก)", (_, input) => F("connector-import-preview", ("source", input["source"]?.DeepClone()), ("key", input["key"]?.DeepClone()), ("label", input["label"]?.DeepClone())),
                Ask: [new("source", "เนื้อหา OpenAPI 3.x (JSON)", FieldKind.Multiline), new("key", "key (ไม่บังคับ)"), new("label", "ชื่อ (ไม่บังคับ)")], Reply: "connector-import-report", ForItem: false),
            new("นำเข้า OpenAPI", (_, input) => F("connector-import-save", ("source", input["source"]?.DeepClone()), ("key", input["key"]?.DeepClone()), ("label", input["label"]?.DeepClone()), ("replace", input["replace"]?.DeepClone())),
                Ask: [new("source", "เนื้อหา OpenAPI 3.x (JSON)", FieldKind.Multiline), new("key", "key (ไม่บังคับ)"), new("label", "ชื่อ (ไม่บังคับ)"), new("replace", "เขียนทับของเดิมที่ key เดียวกัน", FieldKind.Bool)],
                Reply: "connector-import-report", ForItem: false),
        ]);

    public static readonly IReadOnlyList<FieldSpec> TriggerFields =
    [
        new("kind", "ชนิด", FieldKind.Choice, Options: [("reminder", "เตือน (แจ้งข้อความ)"), ("agent_task", "งานของ agent (agent ทำตามคำสั่ง)")]),
        new("title", "ชื่อ"),
        new("text", "ข้อความเตือน / คำสั่งให้ agent", FieldKind.Multiline),
        new("agent", "agent", FieldKind.Choice, OptionsFrom: "agents"),
        new("fireAt", "เวลา (ครั้งเดียว)", Hint: "เช่น 2026-11-04T09:00:00"),
        new("cron", "ทำซ้ำ (cron)", Hint: "เช่น 0 9 * * 1-5 = 9 โมงวันจันทร์–ศุกร์"),
        new("repeat", "ทำซ้ำ", FieldKind.Bool),
        new("webhook", "เริ่มเมื่อมีคนยิง webhook (แทนเวลา)", FieldKind.Bool),
    ];

    public static readonly EntityDef Triggers = new(
        "triggers", "Trigger", "สิ่งที่ทำให้งานเริ่มเอง: ถึงเวลา, มีคนยิง webhook, มีเมลใหม่, ปฏิทินเปลี่ยน…",
        F("triggers-list"), "triggers",
        reply => reply.A("triggers").Where(trigger => trigger.S("status") != "cancelled"),
        trigger => trigger.S("id"),
        trigger => $"{(trigger.S("kind") == "agent_task" ? "🤖" : "⏰")} {trigger.S("title")}",
        trigger => J.Join([
            trigger.S("status") == "active" ? "ทำงานอยู่" : trigger.S("status") == "fired" ? "ทำแล้ว" : trigger.S("status"),
            trigger.S("cron") is { Length: > 0 } cron ? $"cron {cron}" : "",
            trigger.S("webhook") is { Length: > 0 } hook ? $"webhook {hook}" : "",
            trigger.S("nextFireAt") is { Length: > 0 } next ? $"ครั้งต่อไป {When(next)}" : "",
            trigger.S("agent"),
            trigger.S("workflow") is { Length: > 0 } flow ? $"ของ workflow {flow}" : "",
        ], " · "),
        New: () => J.O(("kind", N("reminder")), ("title", N("")), ("text", N("")), ("repeat", false)),
        Save: (trigger, before) => before is null
            ? F("trigger-create", ("trigger", Pick(trigger, "kind", "title", "text", "agent", "repeat", "fireAt", "cron", "webhook")))
            : F("trigger-update", ("id", long.Parse(before)), ("patch", Pick(trigger, "title", "text", "agent", "repeat", "fireAt", "cron"))),
        Delete: trigger => F("trigger-delete", ("id", trigger.At("id").GetInt64())),
        Fields: [.. TriggerFields, new("nextFireAt", "ครั้งต่อไป", FieldKind.ReadOnly), new("lastFiredAt", "ทำล่าสุด", FieldKind.ReadOnly), new("lastResult", "ผลครั้งล่าสุด", FieldKind.ReadOnly)],
        Requests: ["trigger-create", "trigger-update", "trigger-delete", "trigger-run", "trigger-cancel"],
        Actions:
        [
            new("ทำเลยตอนนี้", (trigger, _) => F("trigger-run", ("id", trigger.At("id").GetInt64()))),
            new("ยกเลิก", (trigger, _) => F("trigger-cancel", ("id", trigger.At("id").GetInt64())), Confirm: "ยกเลิก trigger นี้?", When: trigger => trigger.S("status") == "active"),
        ]);

    /// <summary>Only these fields of an edited item, empty strings and nulls left out.</summary>
    private static JsonObject Pick(JsonObject item, params string[] keys)
    {
        var picked = new JsonObject();
        foreach (var key in keys)
        {
            if (item[key] is not { } value) continue;
            if (value is JsonValue text && text.TryGetValue<string>(out var s) && s.Length == 0) continue;
            picked[key] = value.DeepClone();
        }
        return picked;
    }

    public static readonly EntityDef TriggerPool = new(
        "trigger-pool", "ชนิดของ trigger (สำหรับ workflow)", "ชนิดที่มากับแอป และชนิด poll ที่เพิ่มเอง (ถาม URL เป็นระยะ)",
        F("workflows-list"), "workflows",
        reply => reply.A("pool"),
        entry => entry.S("name"),
        entry => entry.S("label") is { Length: > 0 } label ? label : entry.S("name"),
        entry => J.Join([entry.S("kind"), entry.B("builtin") ? "มากับแอป" : "", entry.S("description")], " · "),
        New: () => J.O(("name", N("")), ("label", N("")), ("description", N("")), ("kind", N("poll")), ("builtin", false), ("fields", new JsonArray()), ("sample", new JsonObject())),
        Save: (entry, _) => F("trigger-pool-save", ("entry", entry)),
        Delete: entry => F("trigger-pool-delete", ("name", N(entry.S("name")))),
        Fields:
        [
            new("name", "ชื่อ (a-z)"),
            new("label", "ชื่อที่แสดง"),
            new("description", "คำอธิบาย", FieldKind.Multiline),
            new("kind", "ชนิด", FieldKind.Choice, Options: [("poll", "poll (ถาม URL เป็นระยะ)"), ("manual", "manual"), ("schedule", "schedule"), ("webhook", "webhook"), ("mail", "mail"), ("calendar", "calendar"), ("chat", "chat"), ("telegram", "telegram"), ("tool", "tool")]),
            new("fields", "ช่องที่ตั้งค่าได้ (JSON)", FieldKind.Json),
            new("sample", "ข้อมูลตัวอย่าง (JSON)", FieldKind.Json),
        ],
        Requests: ["trigger-pool-save", "trigger-pool-delete"]);

    public static readonly EntityDef OAuthAccounts = new(
        "oauth", "บัญชี Google / Microsoft", "แต่ละบัญชีมี OAuth client ของตัวเอง · กด \"เชื่อมต่อ\" แล้วล็อกอินในเบราว์เซอร์",
        F("oauth-accounts"), "oauth-accounts",
        reply => reply.A("accounts"),
        account => account.S("id"),
        account => $"{(account.S("service") == "google" ? "Google" : "Microsoft")}: {account.S("name")}",
        account => J.Join([account.B("connected") ? "เชื่อมต่อแล้ว ✓" : "ยังไม่เชื่อมต่อ", account.B("default") ? "ค่าเริ่มต้น" : "", account.S("clientId")], " · "),
        New: () => J.O(("service", N("google")), ("name", N("")), ("clientId", N("")), ("clientSecret", N(""))),
        Save: (account, before) => F("oauth-account-save", ("id", before is null ? null : N(before)),
            ("account", Pick(account, "service", "name", "clientId", "clientSecret", "tenant"))),
        Delete: account => F("oauth-account-remove", ("id", N(account.S("id")))),
        Fields:
        [
            new("service", "บริการ", FieldKind.Choice, Options: [("google", "Google"), ("microsoft", "Microsoft")]),
            new("name", "ชื่อบัญชี"),
            new("clientId", "Client ID"),
            new("clientSecret", "Client secret", FieldKind.Secret, "ว่าง = ใช้ของเดิม"),
            new("tenant", "Tenant (Microsoft)", Hint: "ว่าง = common"),
        ],
        Requests: ["oauth-account-save", "oauth-account-remove", "oauth-account-default", "oauth-account-connect"],
        Actions:
        [
            new("เชื่อมต่อ (ล็อกอินในเบราว์เซอร์)", (account, _) => F("oauth-account-connect", ("id", N(account.S("id")))), Reply: "oauth-auth-url"),
            new("ตั้งเป็นค่าเริ่มต้น", (account, _) => F("oauth-account-default", ("id", N(account.S("id")))), When: account => !account.B("default")),
        ]);

    private static bool Mailbox(JsonObject account) => account.Str("kind") is "imap" or "pop3" or "";

    private static readonly IReadOnlyList<(string, string)> MailSecurity = [("tls", "TLS/SSL (แนะนำ)"), ("starttls", "STARTTLS"), ("none", "ไม่เข้ารหัส (เฉพาะ LAN)")];

    /// <summary>The receiving server (MailIncomingSettings), as feature-mail.js lays it out.</summary>
    public static readonly IReadOnlyList<FieldSpec> MailIncoming =
    [
        new("protocol", "โปรโตคอล", FieldKind.Choice, Options: [("imap", "IMAP"), ("pop3", "POP3")]),
        new("host", "เซิร์ฟเวอร์ (host)", Hint: "เช่น imap.gmail.com, outlook.office365.com"),
        new("port", "พอร์ต", FieldKind.Number, "0 = เลือกให้ตามการเข้ารหัส (IMAP 993/143, POP3 995/110)"),
        new("security", "การเข้ารหัส", FieldKind.Choice, Options: MailSecurity),
        new("user", "ชื่อผู้ใช้", Hint: "ปกติคืออีเมลเต็ม"),
        new("folder", "โฟลเดอร์ (IMAP)", Hint: "ว่าง = INBOX"),
        new("query", "คำค้น", Hint: "IMAP criteria หรือคำในเมล · ว่าง = เมลใหม่สุด"),
        new("unseenOnly", "เฉพาะที่ยังไม่อ่าน", FieldKind.Bool),
        new("sinceDays", "ย้อนหลังกี่วัน", FieldKind.Number, "0 = ไม่จำกัด"),
        new("maxMessages", "จำนวนสูงสุดต่อครั้ง", FieldKind.Number, "1–100"),
        new("markRead", "ทำเครื่องหมายว่าอ่านแล้วเมื่อ agent อ่าน", FieldKind.Bool),
        new("deleteAfterFetch", "ลบออกจากเซิร์ฟเวอร์หลังดึง (POP3)", FieldKind.Bool),
        new("pollMinutes", "เช็คเมลใหม่ทุก (นาที)", FieldKind.Number, "0 = ใช้ค่ากลาง"),
        new("rejectUnauthorized", "ตรวจใบรับรองของเซิร์ฟเวอร์", FieldKind.Bool),
    ];

    /// <summary>The sending server (MailOutgoingSettings).</summary>
    public static readonly IReadOnlyList<FieldSpec> MailOutgoing =
    [
        new("host", "เซิร์ฟเวอร์ SMTP", Hint: "เช่น smtp.gmail.com"),
        new("port", "พอร์ต", FieldKind.Number, "0 = เลือกให้ (465/587/25)"),
        new("security", "การเข้ารหัส", FieldKind.Choice, Options: MailSecurity),
        new("user", "ชื่อผู้ใช้ SMTP", Hint: "ว่าง = ใช้ชื่อเดียวกับขาเข้า"),
        new("useIncomingPassword", "ใช้รหัสผ่านเดียวกับขาเข้า", FieldKind.Bool),
        new("fromEmail", "ส่งในนาม (อีเมล)"),
        new("fromName", "ชื่อผู้ส่ง"),
        new("replyTo", "ตอบกลับไปที่"),
        new("rejectUnauthorized", "ตรวจใบรับรองของเซิร์ฟเวอร์", FieldKind.Bool),
    ];

    public static readonly EntityDef MailAccounts = new(
        "mail", "กล่องเมล", "Gmail, Outlook หรือ IMAP / POP3 + SMTP · รหัสผ่านเก็บในเครื่องนี้เท่านั้น",
        F("mail-watch"), "mail-watch",
        reply => reply.A("accounts"),
        account => account.S("id"),
        account => account.S("name") is { Length: > 0 } name ? name : account.S("id"),
        account => J.Join([account.S("kind"), account.S("email"), account.B("connected") ? "เชื่อมต่อแล้ว ✓" : "ยังไม่ครบ", account.B("default") ? "ค่าเริ่มต้น" : ""], " · "),
        New: () => J.O(("id", N("")), ("kind", N("imap")), ("name", N("")), ("email", N("")),
            ("incoming", J.O(("protocol", N("imap")), ("host", N("")), ("port", 0), ("security", N("tls")), ("rejectUnauthorized", true), ("user", N("")), ("folder", N("INBOX")))),
            ("outgoing", J.O(("host", N("")), ("port", 0), ("security", N("tls")), ("rejectUnauthorized", true), ("useIncomingPassword", true), ("fromEmail", N(""))))),
        Save: (account, _) =>
        {
            var password = account.Str("password");
            var smtp = account.Str("smtpPassword");
            return F("mail-watch-save", ("account", account.Without("password", "smtpPassword", "hasPassword", "hasOutgoingPassword", "connected", "createdAt", "lastCheckedAt")),
                ("password", password.Length > 0 ? N(password) : null), ("smtpPassword", smtp.Length > 0 ? N(smtp) : null));
        },
        Delete: account => F("mail-watch-delete", ("id", N(account.S("id")))),
        Fields:
        [
            new("id", "id (a-z)"),
            new("kind", "ชนิด", FieldKind.Choice, Options: [("imap", "IMAP"), ("pop3", "POP3"), ("google", "Gmail (บัญชี Google)"), ("microsoft", "Outlook (บัญชี Microsoft)")]),
            new("name", "ชื่อ"),
            new("email", "อีเมล"),
            new("query", "คำค้นของเมลที่เฝ้า (Gmail / Outlook)", Hint: "เช่น is:unread หรือ from:boss@example.com", ShowWhen: item => !Mailbox(item)),
            new("incoming", "ขาเข้า (รับเมล)", FieldKind.Group, "เซิร์ฟเวอร์ที่ใช้อ่านเมล — ดูได้จากหน้าตั้งค่าของผู้ให้บริการเมล", Children: MailIncoming, ShowWhen: Mailbox),
            new("password", "รหัสผ่านขาเข้า", FieldKind.Secret, "ว่าง = ใช้ของเดิม · Gmail/Outlook แบบ IMAP ใช้ app password", ShowWhen: Mailbox),
            new("outgoing", "ขาออก (ส่งเมล SMTP)", FieldKind.Group, "ไม่ใส่ host = บัญชีนี้ส่งเมลไม่ได้", Children: MailOutgoing, ShowWhen: Mailbox),
            new("smtpPassword", "รหัสผ่าน SMTP (ถ้าต่างจากขาเข้า)", FieldKind.Secret, ShowWhen: Mailbox),
            new("default", "บัญชีส่งเมลเริ่มต้น", FieldKind.Bool, ShowWhen: Mailbox),
        ],
        Requests: ["mail-watch-save", "mail-watch-delete", "mail-account-test", "mail-watch-check"],
        Actions:
        [
            new("ทดสอบการเชื่อมต่อ", (account, _) => F("mail-account-test", ("id", N(account.S("id")))), Reply: "mail-watch"),
            new("ตรวจเมลใหม่ตอนนี้", (_, _) => F("mail-watch-check"), Reply: "mail-watch", ForItem: false),
        ]);

    public static readonly EntityDef Connections = new(
        "connections", "Connection ของบริการอื่น", "API key, bot token, PAT หรือ OAuth2 ของ connector (Slack, GitHub, Notion…)",
        F("connector-connections"), "connector-connections",
        reply => reply.A("connections"),
        connection => connection.S("id"),
        connection => $"{connection.S("connector")}: {connection.S("name")}",
        connection => J.Join([connection.S("authKind"), connection.B("connected") ? "เชื่อมต่อแล้ว ✓" : "ยังไม่เชื่อมต่อ", connection.B("default") ? "ค่าเริ่มต้น" : ""], " · "),
        New: () => J.O(("connector", N("")), ("name", N("")), ("fields", new JsonObject()), ("default", true)),
        Save: (connection, before) => F("connector-connection-save", ("id", before is null ? null : N(before)),
            ("connection", Pick(connection, "connector", "name", "fields", "default", "oauth"))),
        Delete: connection => F("connector-connection-remove", ("id", N(connection.S("id")))),
        Fields:
        [
            new("connector", "connector", FieldKind.Choice, OptionsFrom: "connectors"),
            new("name", "ชื่อ connection"),
            new("fields", "ค่าที่ต้องใช้", FieldKind.Dynamic, "ค่าเก่าไม่แสดง — เว้นว่าง = คงเดิม, ใส่ใหม่เมื่อจะเปลี่ยน", Expand: ServerFields.ConnectionFields),
            new("default", "ใช้เป็นค่าเริ่มต้นของ connector นี้", FieldKind.Bool),
        ],
        Requests: ["connector-connection-save", "connector-connection-remove", "connector-connection-default", "connector-connection-connect"],
        Actions:
        [
            new("เชื่อมต่อ OAuth2", (connection, _) => F("connector-connection-connect", ("id", N(connection.S("id")))), Reply: "connector-auth-url", When: connection => connection.S("authKind") == "oauth2"),
            new("ตั้งเป็นค่าเริ่มต้น", (connection, _) => F("connector-connection-default", ("id", N(connection.S("id")))), When: connection => !connection.B("default")),
        ]);

    public static readonly EntityDef Calendar = new(
        "calendar", "ปฏิทิน (sync แบบทันที)", "Google / Outlook แจ้งเมื่อปฏิทินเปลี่ยน แล้ว trigger ชนิด calendar เริ่มงาน · poll ทุก 15 นาทีเป็นตัวสำรอง",
        F("calendar-sync"), "calendar-sync",
        reply => reply.At("calendar") is { ValueKind: JsonValueKind.Object } calendar ? [calendar] : [],
        _ => "calendar",
        _ => "สถานะการ sync",
        calendar => calendar.GetRawText().Length > 160 ? calendar.GetRawText()[..160] + "…" : calendar.GetRawText(),
        Fields: [new("", "สถานะ", FieldKind.ReadOnly)],
        Actions:
        [
            new("sync ตอนนี้", (_, _) => F("calendar-sync-now"), Reply: "calendar-sync", ForItem: false),
            new("ปฏิทินของบัญชี Google", (_, input) => F("calendar-calendars", ("account", input["account"]?.DeepClone())), Ask: [new("account", "id บัญชี")], Reply: "calendar-calendars", ForItem: false),
            new("เลือกปฏิทินที่เฝ้า", (_, input) => F("calendar-set", ("account", input["account"]?.DeepClone()), ("calendarId", input["calendarId"]?.DeepClone())),
                Ask: [new("account", "id บัญชี"), new("calendarId", "id ปฏิทิน (Microsoft: * = ทุกปฏิทิน)")], Reply: "calendar-sync", ForItem: false),
        ],
        Single: true);

    public static readonly EntityDef ToolKeys = new(
        "tool-keys", "คีย์ของเครื่องมือค้นหา", "Serper (ค้นเว็บ) และ OpenWeather (อากาศ) · ใส่ค่าว่างเพื่อลบ",
        F("settings-get"), "settings",
        reply => reply.At("settings.toolKeys") is { ValueKind: JsonValueKind.Object } keys ? [keys] : [],
        _ => "keys",
        _ => "คีย์ของเครื่องมือ",
        keys => $"Serper {(keys.B("serper") ? "✓" : "—")} · OpenWeather {(keys.B("openweather") ? "✓" : "—")}",
        Save: (keys, _) =>
        {
            var values = new JsonObject();
            if (keys.Str("SERPER_API_KEY") is { Length: > 0 } serper) values["SERPER_API_KEY"] = serper == "-" ? "" : serper;
            if (keys.Str("OPENWEATHER_API_KEY") is { Length: > 0 } weather) values["OPENWEATHER_API_KEY"] = weather == "-" ? "" : weather;
            return F("settings-save", ("keys", values));
        },
        Fields: [new("SERPER_API_KEY", "Serper API key", FieldKind.Secret, "ว่าง = ไม่เปลี่ยน · ใส่ - เพื่อลบ"), new("OPENWEATHER_API_KEY", "OpenWeather API key", FieldKind.Secret, "ว่าง = ไม่เปลี่ยน · ใส่ - เพื่อลบ")],
        Requests: ["settings-save"],
        Single: true);

    public static readonly EntityDef Secrets = new(
        "secrets", "คีย์ลับ", "API key / token ที่เครื่องมืออ้างถึงด้วย {{secret.ชื่อ}} · เก็บในเครื่องนี้เท่านั้น (ไม่แสดงค่า)",
        F("secrets-list"), "secrets",
        reply => reply.A("names"),
        name => name.GetString() ?? "",
        name => name.GetString() ?? "",
        _ => "มีค่าแล้ว",
        New: () => J.O(("name", N("")), ("value", N(""))),
        Save: (secret, before) => F("secrets-save", ("values", J.O((before ?? secret.Str("name"), N(secret.Str("value")))))),
        Delete: name => F("secrets-save", ("values", J.O((name.GetString() ?? "", N(""))))),
        Fields: [new("name", "ชื่อ (เช่น SLACK_TOKEN)"), new("value", "ค่า", FieldKind.Secret, "ค่าเดิมไม่แสดง ใส่ใหม่เพื่อเปลี่ยน")],
        Requests: ["secrets-save"]);

    public static readonly EntityDef Knowledge = new(
        "knowledge", "คลังความรู้", "เอกสารที่ agent ค้นหาคำตอบได้ · ใส่ข้อความ, URL หรือไฟล์ แล้วเลือกโมเดล embedding เพื่อค้นด้วยความหมาย",
        F("knowledge-list"), "knowledge",
        reply => reply.A("collections"),
        collection => collection.S("name"),
        collection => collection.S("title") is { Length: > 0 } title ? title : collection.S("name"),
        collection => $"{collection.S("documents")} เอกสาร · {collection.S("chunks")} ชิ้น · embed แล้ว {collection.S("embedded")}{(collection.S("embeddingModel") is { Length: > 0 } model ? $" ({model})" : "")}",
        New: () => J.O(("name", N("")), ("title", N("")), ("description", N("")), ("embeddingModel", null), ("agents", new JsonArray())),
        Save: (collection, _) => F("knowledge-save", ("collection", Pick(collection, "name", "title", "description", "embeddingModel", "agents"))),
        Delete: collection => F("knowledge-delete", ("name", N(collection.S("name")))),
        Fields:
        [
            new("name", "id (a-z)"),
            new("title", "ชื่อ"),
            new("description", "คำอธิบาย", FieldKind.Multiline),
            new("embeddingModel", "โมเดล embedding", Hint: "ว่าง = ค้นด้วยคำอย่างเดียว"),
            new("agents", "agent ที่ใช้ได้", FieldKind.List, "ว่าง = ทุกตัว", OptionsFrom: "agents"),
        ],
        Requests: ["knowledge-save", "knowledge-delete", "knowledge-add", "knowledge-remove-document", "knowledge-search", "knowledge-embed"],
        Actions:
        [
            new("เอกสารในคลัง", (collection, _) => F("knowledge-documents", ("collection", N(collection.S("name")))), Reply: "knowledge-documents"),
            new("เพิ่มข้อความ", (collection, input) => F("knowledge-add", ("collection", N(collection.S("name"))), ("title", input["title"]?.DeepClone()), ("text", input["text"]?.DeepClone())),
                Ask: [new("title", "ชื่อเอกสาร"), new("text", "เนื้อหา", FieldKind.Multiline)], Reply: "knowledge-added"),
            new("เพิ่มจาก URL", (collection, input) => F("knowledge-add", ("collection", N(collection.S("name"))), ("url", input["url"]?.DeepClone()), ("title", input["title"]?.DeepClone())),
                Ask: [new("url", "URL"), new("title", "ชื่อเอกสาร (ไม่บังคับ)")], Reply: "knowledge-added"),
            new("เพิ่มไฟล์ในโฟลเดอร์ที่อนุญาต", (collection, input) => F("knowledge-add", ("collection", N(collection.S("name"))), ("path", input["path"]?.DeepClone())),
                Ask: [new("path", "ที่อยู่ไฟล์บนเครื่องที่รัน core")], Reply: "knowledge-added"),
            new("อัปโหลดไฟล์เข้าคลัง (PDF, ข้อความ, เอกสาร)", (collection, input) => input.Str("attachmentId") is { Length: > 0 } id
                    ? F("knowledge-add", ("collection", N(collection.S("name"))), ("attachmentId", N(id)), ("title", input["title"]?.DeepClone()))
                    : null,
                Ask: [new("title", "ชื่อเอกสาร (ไม่บังคับ)")], Reply: "knowledge-added", UploadPath: (_, _) => "/api/upload?name=", UploadFilter: "*"),
            new("ลบเอกสาร", (collection, input) => F("knowledge-remove-document", ("collection", N(collection.S("name"))), ("id", input["id"]?.DeepClone())),
                Ask: [new("id", "เลขเอกสาร", FieldKind.Number)], Reply: "knowledge-documents"),
            new("ค้นหาในคลัง", (collection, input) => F("knowledge-search", ("query", input["query"]?.DeepClone()), ("collection", N(collection.S("name")))),
                Ask: [new("query", "คำค้น")], Reply: "knowledge-results"),
            new("สร้าง vector ที่ขาด (embed)", (collection, _) => F("knowledge-embed", ("collection", N(collection.S("name")))), Reply: "knowledge-embedded"),
        ]);

    public static readonly EntityDef Wardrobe = new(
        "wardrobe", "ตู้เสื้อผ้า", "ชุดของตัวละครที่ agent เปลี่ยนใส่ได้ (รูป, sprite ตามอารมณ์, โมเดล 3D ของชุด)",
        F("wardrobe-list"), "wardrobe",
        reply => reply.A("outfits"),
        outfit => outfit.S("id"),
        outfit => outfit.S("name") is { Length: > 0 } name ? name : outfit.S("id"),
        outfit => J.Join([outfit.S("description"), outfit.S("image").Length > 0 ? "มีรูป" : "", outfit.S("model").Length > 0 ? "มีโมเดล 3D" : ""], " · "),
        New: () => J.O(("id", N("")), ("name", N("")), ("description", N(""))),
        Save: (outfit, before) => F("wardrobe-save", ("outfit", Pick(outfit, "id", "name", "description")), ("renameFrom", before is not null ? N(before) : null)),
        Delete: outfit => F("wardrobe-delete", ("id", N(outfit.S("id")))),
        Fields: [new("id", "id (a-z)"), new("name", "ชื่อชุด"), new("description", "คำอธิบาย (agent ใช้ตัดสินใจ)", FieldKind.Multiline)],
        Requests: ["wardrobe-save", "wardrobe-delete"],
        ReloadOn: [],
        Actions:
        [
            new("อัปโหลดรูปชุด", (_, _) => null, UploadPath: (outfit, _) => $"/api/wardrobe-image/{Uri.EscapeDataString(outfit.S("id"))}", UploadFilter: "image"),
            new("ลบรูปชุด", (_, _) => null, DeletePath: outfit => $"/api/wardrobe-image/{Uri.EscapeDataString(outfit.S("id"))}", Confirm: "ลบรูปของชุดนี้?", When: outfit => outfit.S("image").Length > 0),
            new("อัปโหลดโมเดล 3D ของชุด (.vrm)", (_, _) => null, UploadPath: (outfit, _) => $"/api/wardrobe-model/{Uri.EscapeDataString(outfit.S("id"))}", UploadFilter: ".vrm"),
            new("ลบโมเดล 3D ของชุด", (_, _) => null, DeletePath: outfit => $"/api/wardrobe-model/{Uri.EscapeDataString(outfit.S("id"))}", Confirm: "ลบโมเดลของชุดนี้?", When: outfit => outfit.S("model").Length > 0),
        ]);

    public static readonly EntityDef Backgrounds = new(
        "backgrounds", "ฉากหลัง", "ภาพฉากหลังของแชต · keyword ใช้เลือกฉากอัตโนมัติตามสถานการณ์",
        F("backgrounds-list"), "backgrounds",
        reply => reply.A("items"),
        background => background.S("id"),
        background => background.S("name") is { Length: > 0 } name ? name : background.S("id"),
        background => J.Join([string.Join(", ", background.Strings("keywords")), background.S("image").Length > 0 ? "มีรูป" : "ยังไม่มีรูป"], " · "),
        New: () => J.O(("id", N("")), ("name", N("")), ("keywords", new JsonArray())),
        Save: (background, before) => F("background-save", ("background", Pick(background, "id", "name", "keywords")), ("renameFrom", before is not null ? N(before) : null)),
        Delete: background => F("background-delete", ("id", N(background.S("id")))),
        Fields: [new("id", "id (a-z)"), new("name", "ชื่อฉาก"), new("keywords", "keyword (บรรทัดละคำ)", FieldKind.List)],
        Requests: ["background-save", "background-delete", "background-select"],
        Actions:
        [
            new("อัปโหลดรูปฉาก", (_, _) => null, UploadPath: (background, _) => $"/api/background-image/{Uri.EscapeDataString(background.S("id"))}", UploadFilter: "image"),
            new("ลบรูปฉาก", (_, _) => null, DeletePath: background => $"/api/background-image/{Uri.EscapeDataString(background.S("id"))}", Confirm: "ลบรูปของฉากนี้?", When: background => background.S("image").Length > 0),
            new("ใช้เป็นฉากของทั้งแอป", (background, _) => F("background-select", ("choice", N(background.S("id"))))),
            new("ใช้เป็นฉากของ agent", (background, input) => F("background-select", ("agent", input["agent"]?.DeepClone()), ("choice", N(background.S("id")))),
                Ask: [new("agent", "agent", FieldKind.Choice, OptionsFrom: "agents")]),
            new("ให้เลือกฉากอัตโนมัติ (ทั้งแอป)", (_, _) => F("background-select", ("choice", N("auto"))), ForItem: false),
        ]);

    public static readonly EntityDef Packs = new(
        "packs", "แพ็ก", "ชุดสำเร็จรูป: agent + connector + workflow ติดตั้งทีเดียว · ดูก่อนติดตั้งได้ ไม่เปลี่ยนอะไร",
        F("packs-list"), "packs",
        // The catalog, with the installed record (when, what is missing) in place of its entry; installed packs not in it after.
        reply => reply.A("catalog").Select(pack => reply.A("installed").FirstOrDefault(installed => installed.S("id") == pack.S("id")) is { ValueKind: JsonValueKind.Object } installed ? installed : pack)
            .Concat(reply.A("installed").Where(installed => !reply.A("catalog").Any(entry => entry.S("id") == installed.S("id")))),
        pack => pack.S("id"),
        pack => pack.S("name"),
        pack => J.Join([pack.S("installedAt").Length > 0 ? "ติดตั้งแล้ว" : "", pack.S("version"), pack.S("description")], " · "),
        Fields: [new("id", "id", FieldKind.ReadOnly), new("description", "คำอธิบาย", FieldKind.ReadOnly), new("agents", "agent", FieldKind.ReadOnly), new("connectors", "connector", FieldKind.ReadOnly), new("workflows", "workflow", FieldKind.ReadOnly), new("credentials", "ที่ต้องตั้งค่าเพิ่ม", FieldKind.ReadOnly)],
        Requests: ["pack-preview", "pack-install", "pack-remove-preview", "pack-remove"],
        ReloadOn: ["pack-report", "pack-remove-report"],
        Actions:
        [
            new("ดูก่อนติดตั้ง", (pack, _) => F("pack-preview", ("id", N(pack.S("id")))), Reply: "pack-report"),
            new("ติดตั้ง", (pack, _) => F("pack-install", ("id", N(pack.S("id")))), Reply: "pack-report", Confirm: "ติดตั้งแพ็กนี้? (workflow ถูกบันทึกแบบปิดไว้ทุกตัว)"),
            new("ดูก่อนถอน", (pack, _) => F("pack-remove-preview", ("id", N(pack.S("id")))), Reply: "pack-remove-report", When: pack => pack.S("installedAt").Length > 0),
            new("ถอนการติดตั้ง", (pack, _) => F("pack-remove", ("id", N(pack.S("id")))), Reply: "pack-remove-report", Confirm: "ถอนแพ็กนี้? (ลบเฉพาะของที่แพ็กสร้างและไม่มีใครใช้)", When: pack => pack.S("installedAt").Length > 0),
            new("ติดตั้งจากไฟล์แพ็ก (JSON)", (_, input) => F("pack-install", ("source", input["source"]?.DeepClone())), Ask: [new("source", "เนื้อหาไฟล์แพ็ก (JSON)", FieldKind.Multiline)], Reply: "pack-report", ForItem: false),
            new("ตรวจไฟล์แพ็ก (JSON)", (_, input) => F("pack-preview", ("source", input["source"]?.DeepClone())), Ask: [new("source", "เนื้อหาไฟล์แพ็ก (JSON)", FieldKind.Multiline)], Reply: "pack-report", ForItem: false),
        ]);

    // ---------- Workflow ----------

    public static readonly EntityDef Workflows = new(
        "workflows", "Workflow", "งานอัตโนมัติหลายขั้นของ agent: trigger → node ต่อกัน · คลิกเพื่อเปิดผังลากวาง แก้ node ด้วยฟอร์ม และทดสอบทีละ node",
        F("workflows-list"), "workflows",
        reply => reply.A("workflows"),
        flow => $"{flow.S("agent")}/{flow.S("name")}",
        flow => $"{(flow.B("enabled") ? "●" : "○")} {(flow.S("title") is { Length: > 0 } title ? title : flow.S("name"))}",
        flow => J.Join([flow.S("agent"), $"{flow.A("nodes").Count()} node", flow.B("enabled") ? "เปิดอยู่" : "ปิดอยู่", flow.S("webhook") is { Length: > 0 } hook ? $"webhook {hook}" : "", flow.S("description")], " · "),
        New: () => J.O(("name", N("")), ("agent", N("")), ("title", N("")), ("description", N("")), ("enabled", false),
            ("trigger", J.O(("type", N("manual")))), ("nodes", new JsonArray())),
        Save: (flow, before) => F("workflow-save", ("workflow", flow.Without("webhook")),
            ("renameFrom", before is not null ? N(before.Split('/')[^1]) : null)),
        Delete: flow => F("workflow-delete", ("agent", N(flow.S("agent"))), ("name", N(flow.S("name")))),
        Fields:
        [
            new("name", "ชื่อไฟล์ (a-z, -)"),
            new("agent", "เป็นของ agent", FieldKind.Choice, OptionsFrom: "agents"),
            new("title", "ชื่อที่แสดง"),
            new("description", "คำอธิบาย", FieldKind.Multiline),
            new("enabled", "เปิดใช้", FieldKind.Bool),
            new("trigger", "trigger (JSON)", FieldKind.Json, "เช่น {\"type\":\"schedule\",\"cron\":\"0 9 * * *\"}"),
            new("nodes", "node ทั้งหมด (JSON)", FieldKind.Json, "[{id, type, title, config, links}]"),
            new("vars", "ตัวแปร (JSON)", FieldKind.Json),
            new("errorWorkflow", "workflow ที่รันเมื่อผิดพลาด"),
            new("notes", "โน้ตบนผัง (JSON)", FieldKind.Json),
        ],
        Requests: ["workflow-save", "workflow-delete", "workflow-run", "workflow-runs", "workflow-run-get", "workflow-import-n8n", "workflow-import-make", "workflow-import-zapier"],
        Actions:
        [
            new("ดูผัง (zoom ได้)", (_, _) => null, View: "graph"),
            new("รันเลย", (flow, input) => F("workflow-run", ("agent", N(flow.S("agent"))), ("name", N(flow.S("name"))), ("input", input["input"] is JsonObject data ? data.DeepClone() : null)),
                Ask: [new("input", "ข้อมูลเข้า (JSON, ไม่บังคับ)", FieldKind.Json)], Reply: "workflow-result"),
            new("เปิด / ปิด", (flow, _) => { var copy = flow.Obj().Without("webhook"); copy["enabled"] = !flow.B("enabled"); return F("workflow-save", ("workflow", copy), ("renameFrom", N(flow.S("name")))); }),
            new("ประวัติการรัน", (flow, _) => F("workflow-runs", ("agent", N(flow.S("agent"))), ("name", N(flow.S("name")))), Reply: "workflow-runs"),
            new("ดูการรันหนึ่งครั้ง", (_, input) => F("workflow-run-get", ("id", input["id"]?.DeepClone())), Ask: [new("id", "เลขการรัน", FieldKind.Number)], Reply: "workflow-run-record"),
            new("รันใหม่จาก node หนึ่ง", (flow, input) => F("workflow-run-from", ("agent", N(flow.S("agent"))), ("name", N(flow.S("name"))), ("nodeId", input["nodeId"]?.DeepClone()), ("runId", input["runId"]?.DeepClone())),
                Ask: [new("nodeId", "id ของ node"), new("runId", "เลขการรันเดิม", FieldKind.Number)], Reply: "workflow-result"),
            new("นำเข้าจาก n8n / Make / Zapier", (_, input) => F($"workflow-import-{input.Str("source")}", ("agent", input["agent"]?.DeepClone()), ("json", input["json"]?.DeepClone()), ("save", input["save"]?.DeepClone() ?? false)),
                Ask:
                [
                    new("source", "จาก", FieldKind.Choice, Options: [("n8n", "n8n"), ("make", "Make"), ("zapier", "Zapier")]),
                    new("agent", "ให้ agent", FieldKind.Choice, OptionsFrom: "agents"),
                    new("json", "ไฟล์ export (JSON)", FieldKind.Multiline),
                    new("save", "บันทึกเลย (แบบปิดไว้) — ไม่ติ๊ก = ดูรายงานก่อน", FieldKind.Bool),
                ], Reply: "workflow-import", ForItem: false),
        ]);

    // ---------- Overseer ----------

    public static readonly EntityDef Overseer = new(
        "overseer", "AI Overseer", "ผู้ช่วยตั้งค่าในตัว: สร้าง agent, เครื่องมือ, skill และ workflow ให้จากการคุย · เลือกโมเดลก่อนใช้",
        F("overseer-get"), "overseer",
        reply => reply.At("overseer") is { ValueKind: JsonValueKind.Object } overseer ? [overseer] : [],
        overseer => overseer.S("name"),
        overseer => overseer.S("displayName") is { Length: > 0 } shown ? shown : "AI Overseer",
        overseer => overseer.B("configured") ? $"พร้อมใช้ · {overseer.S("model")}" : "ยังไม่ได้เลือกโมเดล (หรือผู้ให้บริการยังไม่เชื่อมต่อ)",
        Save: (overseer, _) => F("overseer-save", ("model", N(overseer.Str("model")))),
        Fields: [new("model", "โมเดลของ Overseer", FieldKind.Choice, OptionsFrom: "models-only"), new("configured", "พร้อมใช้", FieldKind.ReadOnly), new("providerConnected", "ผู้ให้บริการเชื่อมต่อแล้ว", FieldKind.ReadOnly)],
        Requests: ["overseer-save", "overseer-get"],
        Single: true);

    // ---------- Settings ----------

    public static readonly EntityDef Providers = new(
        "providers", "ผู้ให้บริการโมเดล", "เลือกจากรายการหรือใส่ของตัวเอง (ชื่อ + URL + API key) แล้ว Mimi ดึงรายชื่อโมเดลให้",
        F("settings-get"), "settings",
        reply => reply.A("settings.providers"),
        provider => provider.S("id"),
        provider => provider.S("name") is { Length: > 0 } name ? name : provider.S("id"),
        provider => J.Join([provider.B("connected") ? "เชื่อมต่อแล้ว ✓" : "ยังไม่มีคีย์", $"{provider.S("models")} โมเดล", provider.S("baseURL"), provider.B("custom") ? "เพิ่มเอง" : ""], " · "),
        New: () => J.O(("id", N("")), ("name", N("")), ("baseURL", N("")), ("apiKey", N("")), ("modelIds", new JsonArray())),
        Save: (provider, before) => provider.Str("apiKey").Length > 0 || before is null
            ? F("provider-connect", ("id", N(provider.Str("id").ToLowerInvariant())), ("name", provider.Str("name") is { Length: > 0 } name ? N(name) : null),
                ("baseURL", provider.Str("baseURL") is { Length: > 0 } url ? N(url) : null), ("apiKey", provider.Str("apiKey") is { Length: > 0 } key ? N(key) : null),
                ("models", provider["modelIds"] is JsonArray ids && ids.Count > 0 ? ids.DeepClone() : null))
            : F("provider-update", ("id", N(provider.Str("id"))), ("name", N(provider.Str("name"))), ("baseURL", provider.Str("baseURL") is { Length: > 0 } url2 ? N(url2) : null),
                ("models", provider["modelIds"] is JsonArray ids2 ? ids2.DeepClone() : null)),
        Delete: provider => F("provider-remove", ("id", N(provider.S("id")))),
        Fields:
        [
            new("id", "ผู้ให้บริการ (id)", Hint: "id จากรายการ เช่น openai, anthropic, deepseek, opencode · หรือชื่อใหม่ของตัวเอง", OptionsFrom: "catalog"),
            new("name", "ชื่อที่แสดง"),
            new("baseURL", "API base URL", Hint: "จำเป็นเมื่อเพิ่มเอง"),
            new("apiKey", "API key", FieldKind.Secret, "ว่าง = ใช้คีย์เดิม"),
            new("modelIds", "รายชื่อโมเดล (บรรทัดละตัว)", FieldKind.List, "สำหรับ endpoint ที่บอกรายชื่อเองไม่ได้"),
        ],
        Requests: ["provider-connect", "provider-update", "provider-remove", "chatgpt-plan-connect"],
        Actions:
        [
            new("เชื่อมต่อ ChatGPT แบบรายเดือน", (_, _) => F("chatgpt-plan-connect"), Reply: "provider-auth-url", ForItem: false),
            new("ใช้ Claude แบบรายเดือน (Claude Code)", (_, _) => F("provider-connect", ("id", N("claude-subscription"))), ForItem: false,
                Confirm: "ต้องติดตั้ง Claude Code และรัน \"claude auth login\" บนเครื่องที่รัน Mimi ก่อน (เซิร์ฟเวอร์: ตั้ง CLAUDE_CODE_OAUTH_TOKEN) · ใช้โควตาแผนรายเดือนของคุณ"),
            new("ดึงรายชื่อโมเดลใหม่", (provider, _) => F("provider-connect", ("id", N(provider.S("id"))))),
        ]);

    /// <summary>The "แอปและระบบ" form: what settings-save accepts, read from the settings view.</summary>
    public static readonly EntityDef General = new(
        "general", "โมเดลเริ่มต้น พื้นที่ และ session", "ใช้กับ agent ที่ไม่ได้เลือกเอง · เขตเวลา · ขึ้น session ใหม่อัตโนมัติ · โควตา · โฟลเดอร์ที่อนุญาต",
        F("settings-get"), "settings",
        reply => reply.At("settings") is { ValueKind: JsonValueKind.Object } settings
            ? [JsonDocument.Parse(J.O(
                ("defaults", Node(settings.At("defaults")) ?? new JsonObject()),
                ("timezone", N(settings.S("timezone"))),
                ("session", J.O(("idleMinutes", settings.At("sessionIdleMinutes").ValueKind == JsonValueKind.Number ? settings.At("sessionIdleMinutes").GetInt32() : 0), ("maxTokens", settings.At("sessionMaxTokens").ValueKind == JsonValueKind.Number ? settings.At("sessionMaxTokens").GetInt64() : 0))),
                ("storage", J.O(("mediaQuotaMb", settings.At("storage.media.quotaBytes").ValueKind == JsonValueKind.Number ? settings.At("storage.media.quotaBytes").GetInt64() / 1048576 : 0),
                    ("userMediaQuotaMb", settings.At("storage.userMedia.quotaBytes").ValueKind == JsonValueKind.Number ? settings.At("storage.userMedia.quotaBytes").GetInt64() / 1048576 : 0),
                    ("chatQuotaMb", settings.At("storage.chat.quotaBytes").ValueKind == JsonValueKind.Number ? settings.At("storage.chat.quotaBytes").GetInt64() / 1048576 : 0))),
                ("allowedDirs", Arr(settings.Strings("allowedDirs"))),
                ("projectRoots", Arr(settings.Strings("projectRoots"))),
                ("used", N($"สื่อในแชต {Mb(settings.At("storage.media.usedBytes"))} · รูป/โมเดลของคุณ {Mb(settings.At("storage.userMedia.usedBytes"))} · ข้อความ {Mb(settings.At("storage.chat.usedBytes"))} · ใช้วันนี้ ${settings.S("spentTodayUsd")}"))
              ).ToJsonString()).RootElement.Clone()]
            : [],
        _ => "general",
        _ => "โมเดลเริ่มต้นและระบบ",
        item => item.S("used"),
        Save: (form, _) => F("settings-save", ("defaults", form["defaults"]?.DeepClone()), ("timezone", form["timezone"]?.DeepClone()), ("session", form["session"]?.DeepClone()),
            ("storage", form["storage"]?.DeepClone()), ("allowedDirs", form["allowedDirs"]?.DeepClone()), ("projectRoots", form["projectRoots"]?.DeepClone())),
        Fields:
        [
            new("used", "ใช้ไปแล้ว", FieldKind.ReadOnly),
            new("defaults.model", "โมเดลหลักเริ่มต้น", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.small_model", "โมเดลเล็กเริ่มต้น", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.vision_model", "ตัวอ่านรูปเริ่มต้น", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.transcript_model", "ตัวถอดเสียงเริ่มต้น", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.image_model", "สร้างรูปภาพ", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.speech_model", "สร้างเสียงพูด", FieldKind.Choice, OptionsFrom: "models"),
            new("defaults.video_model", "สร้างวิดีโอ", FieldKind.Choice, OptionsFrom: "models"),
            new("timezone", "เขตเวลา (IANA เช่น Asia/Bangkok)"),
            new("session.idleMinutes", "เงียบกี่นาทีแล้วขึ้น session ใหม่", FieldKind.Number),
            new("session.maxTokens", "session ยาวเกินกี่ token แล้วขึ้นใหม่ (0 = ไม่จำกัด)", FieldKind.Number),
            new("storage.mediaQuotaMb", "โควตาสื่อในแชต (MB, 0 = ค่าเริ่มต้น)", FieldKind.Number),
            new("storage.userMediaQuotaMb", "โควตารูป/โมเดลของคุณ (MB)", FieldKind.Number),
            new("storage.chatQuotaMb", "โควตาข้อความ (MB)", FieldKind.Number),
            new("allowedDirs", "โฟลเดอร์ที่ agent เข้าถึงได้ (บนเครื่องที่รัน core)", FieldKind.List),
            new("projectRoots", "โฟลเดอร์โปรเจกต์ที่รันคำสั่งได้ (ว่าง = ทุกโฟลเดอร์ที่อนุญาต)", FieldKind.List),
        ],
        Requests: ["settings-save"],
        Single: true);

    private static string Mb(JsonElement bytes) => bytes.ValueKind == JsonValueKind.Number ? $"{bytes.GetInt64() / 1048576.0:0.#} MB" : "?";

    public static readonly EntityDef Preferences = new(
        "preferences", "งบประมาณ & การแจ้งเตือน", "หยุดเรียกโมเดลเมื่อใช้เกินงบวันนี้ · ช่วงเงียบ: เก็บแจ้งเตือนไว้ใน 🔔 แต่ไม่เด้ง",
        F("settings-get"), "settings",
        reply => reply.At("settings.preferences") is { ValueKind: JsonValueKind.Object } preferences ? [preferences] : [],
        _ => "preferences",
        _ => "งบประมาณ & การแจ้งเตือน",
        preferences => J.Join([preferences.S("dailyBudgetUsd") is { Length: > 0 } budget ? $"งบ ${budget}/วัน" : "ไม่จำกัดงบ", preferences.S("quietFrom") is { Length: > 0 } from ? $"เงียบ {from}–{preferences.S("quietTo")}" : ""], " · "),
        Save: (preferences, _) => F("preferences-save", ("preferences", preferences)),
        Fields:
        [
            new("dailyBudgetUsd", "งบต่อวัน (USD, ว่าง = ไม่จำกัด)", FieldKind.Number),
            new("quietFrom", "ช่วงเงียบ เริ่ม (เช่น 22:00)"),
            new("quietTo", "ช่วงเงียบ ถึง (เช่น 07:00)"),
            new("pushKinds", "ชนิดที่ส่งเข้าเครื่อง (reminder, task-result, approval, message, info)", FieldKind.List),
            new("urgentApprovals", "คำขออนุมัติยังเด้งในช่วงเงียบ", FieldKind.Bool),
            new("mutedAgents", "ปิดเสียง agent เหล่านี้", FieldKind.List, OptionsFrom: "agents"),
        ],
        Requests: ["preferences-save"],
        Single: true);

    public static readonly EntityDef Profile = new(
        "profile", "โปรไฟล์ของฉัน", "ข้อมูลของคุณที่ agent รู้ (key / ค่า) และใครเห็นได้ (* = ทุกตัว หรือรายชื่อ agent)",
        F("profile-get"), "profile",
        reply => reply.At("profile") is { ValueKind: JsonValueKind.Object } profile ? [profile] : [],
        _ => "profile",
        _ => "โปรไฟล์ของฉัน",
        profile => $"{profile.A("fields").Count()} ข้อมูล",
        Save: (profile, _) => F("profile-save", ("profile", profile)),
        Fields:
        [
            new("fields", "ข้อมูลของฉัน", FieldKind.Rows, "agent รู้ข้อมูลเหล่านี้ตามที่ตั้งว่าใครเห็น", NewRow: ServerFields.NewProfileField, Children:
            [
                new("label", "ชื่อที่เรียก (เช่น ที่อยู่บ้าน)"),
                new("value", "ค่า", FieldKind.Multiline),
                new("visibleTo", "ใครเห็น", FieldKind.Audience),
                new("localOnly", "เก็บในเครื่องนี้เท่านั้น (ไม่เขียนลง profile.json ที่อาจ sync / สำรองไปที่อื่น — เหมาะกับเลขบัญชี เลขบัตร)", FieldKind.Bool),
                new("key", "key (a-z, 0-9, _ ขึ้นต้นด้วยตัวอักษร)", Hint: "ชื่อที่ agent ใช้อ้าง เช่น home_address"),
            ]),
        ],
        Requests: ["profile-save"],
        Single: true);

    public static readonly EntityDef Memory = new(
        "memory", "ความจำ", "สิ่งที่ Mimi จำเกี่ยวกับคุณ — ใช้ร่วมกันทุก agent",
        F("memory-list"), "memory",
        reply => reply.A("entries"),
        entry => entry.S("path"),
        entry => entry.S("path"),
        entry => J.Join([$"ชั้น {entry.S("layer")}", entry.S("description"), When(entry.S("updatedAt"))], " · "),
        New: () => J.O(("path", N("")), ("description", N("")), ("content", N(""))),
        Save: (entry, _) => F("memory-save", ("path", N(entry.Str("path"))), ("description", N(entry.Str("description"))), ("content", N(entry.Str("content")))),
        Delete: entry => F("memory-delete", ("path", N(entry.S("path")))),
        Fields: [new("path", "ชื่อไฟล์ความจำ (เช่น people/แม่.md)"), new("description", "คำอธิบายสั้น ๆ"), new("content", "เนื้อหา", FieldKind.Multiline), new("layer", "ชั้น", FieldKind.ReadOnly), new("updatedAt", "แก้ล่าสุด", FieldKind.ReadOnly)],
        Requests: ["memory-save", "memory-delete"],
        ReloadOn: []);

    public static readonly EntityDef Grants = new(
        "grants", "สิทธิ์ \"อนุญาตตลอด\"", "เครื่องมือที่กด \"อนุญาตเสมอ\" ไว้ แยกตาม agent (* = ทุกตัว) · ถอนได้",
        F("settings-get"), "settings",
        reply => reply.At("settings.permissionAgentGrants") is { ValueKind: JsonValueKind.Object } grants
            ? grants.EnumerateObject().SelectMany(agent => agent.Value.ValueKind == JsonValueKind.Array
                ? agent.Value.EnumerateArray().Select(tool => JsonDocument.Parse(J.O(("agent", N(agent.Name)), ("tool", N(tool.GetString() ?? ""))).ToJsonString()).RootElement.Clone())
                : [])
            : [],
        grant => $"{grant.S("agent")}:{grant.S("tool")}",
        grant => grant.S("tool"),
        grant => grant.S("agent") == "*" ? "ทุก agent" : grant.S("agent"),
        Delete: grant => F("permission-revoke", ("tool", N(grant.S("tool"))), ("agent", grant.S("agent") == "*" ? null : N(grant.S("agent")))),
        Fields: [new("agent", "agent", FieldKind.ReadOnly), new("tool", "เครื่องมือ", FieldKind.ReadOnly)],
        Requests: ["permission-revoke"],
        ReloadOn: []);

    public static readonly EntityDef Backups = new(
        "backups", "สำรอง / กู้คืนข้อมูล", "สำรองโฟลเดอร์ข้อมูลของคุณ แล้วดาวน์โหลดเก็บไว้ · กู้คืน: แตกไฟล์ทับโฟลเดอร์ user ของ core",
        F("backups-list"), "backups",
        reply => reply.A("backups"),
        backup => backup.S("name"),
        backup => backup.S("name"),
        backup => $"{Mb(backup.At("bytes"))} · {When(backup.S("createdAt"))}",
        Fields: [new("name", "ไฟล์", FieldKind.ReadOnly), new("bytes", "ขนาด (ไบต์)", FieldKind.ReadOnly), new("createdAt", "สร้างเมื่อ", FieldKind.ReadOnly)],
        Requests: ["backup-create"],
        Actions:
        [
            new("ดาวน์โหลด", (_, _) => null, DownloadPath: backup => ($"/api/backups/{Uri.EscapeDataString(backup.S("name"))}", backup.S("name"))),
            new("สำรองตอนนี้", (_, input) => F("backup-create", ("includeSecrets", input["includeSecrets"]?.DeepClone() ?? false)),
                Ask: [new("includeSecrets", "รวมคีย์ลับด้วย (เก็บไฟล์ให้ดี)", FieldKind.Bool)], ForItem: false),
            new("ดาวน์โหลดแชตทั้งหมด (CSV)", (_, _) => null, DownloadPath: _ => ("/api/export/chats.csv", "mimi-chats.csv"), ForItem: false),
        ]);

    public static readonly EntityDef PushDevices = new(
        "push", "เครื่องที่รับแจ้งเตือน", "เบราว์เซอร์และแอปมือถือที่รับ push ตอนปิดแอป · แอป Windows นี้รับแจ้งเตือนขณะเปิดอยู่ในถาด (WNS ยังไม่มี)",
        F("push-devices"), "push-devices",
        reply => reply.A("devices"),
        device => device.S("endpoint"),
        device => device.S("label") is { Length: > 0 } label ? label : "อุปกรณ์",
        device => J.Join([device.S("service"), device.S("lastOkAt") is { Length: > 0 } ok ? $"ส่งถึงล่าสุด {When(ok)}" : ""], " · "),
        Delete: device => F("push-unsubscribe", ("endpoint", N(device.S("endpoint")))),
        Fields: [new("label", "ชื่อ", FieldKind.ReadOnly), new("service", "บริการ", FieldKind.ReadOnly), new("endpoint", "endpoint", FieldKind.ReadOnly)],
        Requests: ["push-unsubscribe", "push-test"],
        Actions: [new("ส่งทดสอบ", (_, _) => F("push-test"), ForItem: false)]);

    public static readonly EntityDef Tunnel = new(
        "tunnel", "เข้าจากอินเทอร์เน็ต (Cloudflare Tunnel)", "เปิด core บนคอมพิวเตอร์ให้เข้าได้จากข้างนอกผ่าน cloudflared · quick tunnel เปลี่ยนที่อยู่ทุกครั้งที่เริ่ม",
        F("settings-get"), "settings",
        reply => reply.At("settings.tunnel") is { ValueKind: JsonValueKind.Object } tunnel ? [tunnel] : [],
        _ => "tunnel",
        tunnel => tunnel.S("state") switch { "on" => "เปิดอยู่", "starting" => "กำลังเปิด…", "error" => "เปิดไม่สำเร็จ", "missing" => "ยังไม่ได้ติดตั้ง cloudflared", _ => "ปิดอยู่" },
        tunnel => J.Join([tunnel.S("url"), tunnel.S("error"), tunnel.S("hint"), tunnel.S("unavailable")], " · "),
        Fields: [new("state", "สถานะ", FieldKind.ReadOnly), new("url", "ที่อยู่", FieldKind.ReadOnly), new("mode", "แบบ", FieldKind.ReadOnly), new("error", "ผิดพลาด", FieldKind.ReadOnly), new("hint", "วิธีติดตั้ง", FieldKind.ReadOnly)],
        Requests: ["tunnel-start", "tunnel-stop"],
        Actions:
        [
            new("เปิด tunnel", (_, _) => F("tunnel-start"), ForItem: false),
            new("ปิด tunnel", (_, _) => F("tunnel-stop"), ForItem: false),
        ],
        Single: true);

    /// <summary>The accounts gateway's own account: 2FA and the password (HTTP routes; a single core has none).</summary>
    public static readonly EntityDef GatewayAccount = new(
        "account", "บัญชี (เข้าสู่ระบบผ่าน accounts gateway)", "ยืนยันตัวตนสองขั้น (2FA) และเปลี่ยนรหัสผ่าน · ใช้ได้เฉพาะเมื่อเข้าสู่ระบบด้วยชื่อผู้ใช้ + รหัสผ่าน",
        null, "",
        _ => [JsonDocument.Parse("""{"name":"account"}""").RootElement.Clone()],
        _ => "account",
        _ => "2FA และรหัสผ่าน",
        _ => "เลือก \"ทำ…\" ด้านบน",
        Fields: [],
        Actions:
        [
            new("ดูสถานะ 2FA", (_, _) => null, GetPath: "/auth/session", ForItem: false),
            new("เริ่มตั้งค่า 2FA", (_, _) => null, Ask: [new("password", "รหัสผ่าน (เพื่อยืนยันว่าเป็นคุณ)", FieldKind.Secret)], PostPath: "/auth/2fa/setup", ForItem: false),
            new("ยืนยันและเปิด 2FA", (_, _) => null, Ask: [new("code", "รหัส 6 หลักจากแอปยืนยันตัวตน", Hint: "หลังยืนยันจะแสดงรหัสสำรอง 10 รหัส เก็บไว้ให้ดี")], PostPath: "/auth/2fa/enable", ForItem: false),
            new("สร้างรหัสสำรองชุดใหม่", (_, _) => null, Ask: [new("password", "รหัสผ่าน", FieldKind.Secret)], PostPath: "/auth/2fa/recovery", ForItem: false),
            new("ปิด 2FA", (_, _) => null, Ask: [new("password", "รหัสผ่าน", FieldKind.Secret), new("code", "รหัส 6 หลักตอนนี้")], PostPath: "/auth/2fa/disable", ForItem: false, Confirm: "ปิดการยืนยันตัวตนสองขั้น?"),
            new("เปลี่ยนรหัสผ่าน", (_, _) => null, Ask: [new("current", "รหัสผ่านปัจจุบัน", FieldKind.Secret), new("next", "รหัสผ่านใหม่ (อย่างน้อย 10 ตัวอักษร)", FieldKind.Secret)], PostPath: "/auth/password", ForItem: false),
        ]);

    // ---------- the pages ----------

    public static readonly IReadOnlyList<PageTab> HubTabs =
    [
        new("models", "กองโมเดล", Presets.Lead, [Presets]),
        new("skills", "Skill", Skills.Lead, [Skills]),
        new("nodes", "Node & เครื่องมือ", "ทุกอย่างที่วางใน workflow ได้ และที่ agent เรียกใช้ได้ · บันทึก node ที่ตั้งค่าแล้วเป็น preset เพื่อใช้ซ้ำ", [ToolPresets, CustomTools, McpServers, ImportedConnectors, Tools]),
        new("triggers", "Trigger", Triggers.Lead, [Triggers, TriggerPool]),
        new("accounts", "บัญชี", "บัญชีที่ Mimi เข้าใช้แทนคุณ: Google, Microsoft, กล่องเมล IMAP/POP3 และ connection ของบริการอื่น", [OAuthAccounts, MailAccounts, Connections, Calendar, ToolKeys]),
        new("secrets", "คีย์ลับ", Secrets.Lead, [Secrets]),
        new("knowledge", "คลังความรู้", Knowledge.Lead, [Knowledge]),
        new("wardrobe", "ตู้เสื้อผ้า", Wardrobe.Lead, [Wardrobe]),
        new("backgrounds", "ฉากหลัง", Backgrounds.Lead, [Backgrounds]),
        new("packs", "แพ็ก", Packs.Lead, [Packs]),
    ];

    public static readonly IReadOnlyList<PageTab> SettingsTabs =
    [
        new("profile", "โปรไฟล์ของฉัน", "ข้อมูลของคุณ งบประมาณ การแจ้งเตือน และการสำรองข้อมูล", [Profile, Preferences, PushDevices, Backups, GatewayAccount]),
        new("look", "หน้าตา", "ธีม ขนาดข้อความ ตัวละคร และเสียงของแอป", []),
        new("memory", "ความจำ", Memory.Lead, [Memory]),
        new("app", "แอปและระบบ", "ผู้ให้บริการโมเดล โมเดลเริ่มต้น พื้นที่เก็บข้อมูล session อัตโนมัติ และโฟลเดอร์", [Providers, General, Grants, Tunnel]),
    ];

    public static readonly PageTab AgentPage = new("agents", "Agent", Agents.Lead, [Agents, AgentPresets]);
    public static readonly PageTab WorkflowPage = new("workflows", "Workflow", Workflows.Lead, [Workflows]);
    public static readonly PageTab OverseerPage = new("overseer", "AI Overseer", Overseer.Lead, [Overseer]);
}
