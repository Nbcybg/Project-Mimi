using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Mimi.App.Services;
using Mimi.Core.Hub;

namespace Mimi.App.Controls;

/// <summary>
/// What an action answered, shown the way the web shows it rather than as JSON: a pack's report (agents,
/// connectors, workflows, what still needs setting up, warnings), a workflow run node by node, a list of runs,
/// and anything else as labelled rows and cards. The JSON itself is one click away.
/// </summary>
internal static class ResultView
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>Field names the server uses, in the words of the web page.</summary>
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["ok"] = "สำเร็จ", ["error"] = "ข้อผิดพลาด", ["errors"] = "ข้อผิดพลาด", ["warnings"] = "คำเตือน", ["message"] = "ข้อความ",
        ["name"] = "ชื่อ", ["title"] = "ชื่อที่แสดง", ["id"] = "id", ["status"] = "สถานะ", ["result"] = "ผล", ["count"] = "จำนวน",
        ["agents"] = "agent", ["connectors"] = "connector", ["workflows"] = "workflow", ["credentials"] = "ที่ต้องตั้งค่าเพิ่ม",
        ["createdAt"] = "สร้างเมื่อ", ["startedAt"] = "เริ่ม", ["finishedAt"] = "จบ", ["durationMs"] = "ใช้เวลา (ms)",
        ["items"] = "รายการ", ["hits"] = "ผลที่พบ", ["score"] = "คะแนน", ["text"] = "ข้อความ", ["source"] = "ที่มา",
        ["accounts"] = "บัญชี", ["connected"] = "เชื่อมต่อแล้ว", ["lastCheckedAt"] = "ตรวจล่าสุด", ["saved"] = "บันทึกแล้ว",
        ["trigger"] = "trigger", ["agent"] = "agent", ["action"] = "การกระทำ", ["why"] = "เหตุผล", ["label"] = "ชื่อ",
    };

    private static string Label(string key) => Labels.TryGetValue(key, out var label) ? label : key;

    /// <summary>The view of a reply of <paramref name="type"/> (the frame type, or "" for an HTTP answer).</summary>
    public static FrameworkElement Build(string type, JsonElement reply)
    {
        var panel = new StackPanel { Spacing = 12, MinWidth = 300 };
        try
        {
            switch (type)
            {
                case "pack-report" or "pack-remove-report":
                    PackReport(panel, reply);
                    break;
                case "workflow-result":
                    RunResult(panel, reply.At("result"));
                    break;
                case "workflow-node-result":
                    NodeResult(panel, reply.At("result"));
                    break;
                case "workflow-runs":
                    Runs(panel, reply);
                    break;
                default:
                    panel.Children.Add(Value(Strip(reply), 0));
                    break;
            }
        }
        catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException)
        {
            panel.Children.Add(Ui.Hint($"แสดงผลไม่ได้: {error.Message}", "Bad"));
        }
        panel.Children.Add(Raw(reply));
        return panel;
    }

    private static JsonElement Strip(JsonElement reply)
    {
        if (reply.ValueKind != JsonValueKind.Object) return reply;
        var copy = reply.Obj();
        copy.Remove("type");
        copy.Remove("reqId");
        return JsonDocument.Parse(copy.ToJsonString()).RootElement;
    }

    /// <summary>The JSON, folded away (copyable).</summary>
    private static FrameworkElement Raw(JsonElement reply)
    {
        var text = Ui.Mono(JsonSerializer.Serialize(Strip(reply), Pretty), 11);
        text.MaxLines = 400;
        return new Expander
        {
            Header = "ดู JSON",
            Content = text,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
    }

    // ---------- packs ----------

    private static void PackReport(StackPanel panel, JsonElement reply)
    {
        var report = reply.At("report");
        var action = reply.S("action") switch
        {
            "preview" => "ดูก่อนติดตั้ง (ยังไม่เปลี่ยนอะไร)",
            "install" => "ติดตั้งแล้ว",
            "remove-preview" => "ดูก่อนถอน (ยังไม่ลบอะไร)",
            "remove" => "ถอนการติดตั้งแล้ว",
            var other => other,
        };
        var ok = reply.B("ok");
        panel.Children.Add(Ui.Title(report.S("name") is { Length: > 0 } name ? name : report.S("id"), 16));
        panel.Children.Add(Ui.Row(8, Ui.Pill(ok ? "สำเร็จ" : "ไม่สำเร็จ", ok ? "Ok" : "Bad"), Ui.Hint(action), Ui.Hint(report.S("id"), "Faint")));
        foreach (var error in reply.A("errors").Concat(report.A("errors"))) panel.Children.Add(Line("✗", error.ValueKind == JsonValueKind.String ? error.GetString()! : error.S("message"), "Bad"));

        Section(panel, "Agent", report.A("agents"), agent => Card(
            $"{(agent.S("displayName") is { Length: > 0 } shown ? shown : agent.S("name"))}",
            Act(agent.S("action")),
            J.Join([agent.A("tools").Any() ? $"เครื่องมือ {agent.A("tools").Count()} อย่าง" : "", agent.A("risky").Any() ? $"เสี่ยง: {string.Join(", ", agent.Strings("risky"))}" : ""], " · ")));
        Section(panel, "Connector", report.A("connectors"), connector => Card(
            connector.S("label") is { Length: > 0 } label ? label : connector.S("key"), Act(connector.S("action")),
            connector.S("operations") is { Length: > 0 } ops ? $"{ops} operation" : ""));
        Section(panel, "Workflow", report.A("workflows"), flow => Card(
            flow.S("title") is { Length: > 0 } title ? title : flow.S("name"), Act(flow.S("action")),
            J.Join([$"{flow.S("agent")}/{flow.S("name")}", flow.S("trigger").Length > 0 ? $"trigger: {flow.S("trigger")}" : ""], " · ")));
        // Removal reports: what goes and what stays.
        foreach (var (key, title) in new[] { ("removed", "จะลบ / ลบแล้ว"), ("kept", "เก็บไว้"), ("missing", "ไม่พบแล้ว") })
        {
            if (report.At(key).ValueKind == JsonValueKind.Object)
            {
                var lines = report.At(key).EnumerateObject().SelectMany(kind => kind.Value.ValueKind == JsonValueKind.Array
                    ? kind.Value.EnumerateArray().Select(item => $"{kind.Name}: {(item.ValueKind == JsonValueKind.String ? item.GetString() : item.S("name") is { Length: > 0 } n ? n : item.GetRawText())}{(item.S("reason") is { Length: > 0 } reason ? $" — {reason}" : "")}")
                    : []).ToList();
                if (lines.Count == 0) continue;
                panel.Children.Add(Ui.Section(title));
                foreach (var line in lines) panel.Children.Add(Line("•", line));
            }
        }
        var credentials = report.A("credentials").ToList();
        if (credentials.Count > 0)
        {
            panel.Children.Add(Ui.Section("ที่ต้องตั้งค่าเพิ่ม"));
            foreach (var credential in credentials)
            {
                var ready = credential.B("ok");
                var line = Line(ready ? "✓" : "!", $"{credential.S("label")}{(credential.S("why") is { Length: > 0 } why ? $" — {why}" : "")}", ready ? "Ok" : "Warn");
                panel.Children.Add(line);
            }
        }
        var warnings = report.A("warnings").Concat(reply.A("warnings")).ToList();
        if (warnings.Count > 0)
        {
            panel.Children.Add(Ui.Section("คำเตือน"));
            foreach (var warning in warnings) panel.Children.Add(Line("⚠", warning.ValueKind == JsonValueKind.String ? warning.GetString()! : warning.GetRawText(), "Warn"));
        }
    }

    private static string Act(string action) => action switch
    {
        "reuse" => "ใช้ของเดิม",
        "create" or "import" or "install" => "สร้างใหม่",
        "update" => "อัปเดต",
        "skip" => "ข้าม",
        "remove" => "ลบ",
        "keep" => "เก็บไว้",
        _ => action,
    };

    private static void Section(StackPanel panel, string title, IEnumerable<JsonElement> items, Func<JsonElement, FrameworkElement> card)
    {
        var list = items.ToList();
        if (list.Count == 0) return;
        panel.Children.Add(Ui.Section($"{title} ({list.Count})"));
        foreach (var item in list) panel.Children.Add(item.ValueKind == JsonValueKind.String ? Line("•", item.GetString()!) : card(item));
    }

    private static Border Card(string title, string tag, string detail)
    {
        var stack = new StackPanel { Spacing = 3 };
        var head = new Grid { ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var name = new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, Foreground = Theme.Brush("Ink"), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        head.Children.Add(name);
        if (tag.Length > 0)
        {
            var pill = Ui.Pill(tag, "Info");
            Grid.SetColumn(pill, 1);
            head.Children.Add(pill);
        }
        stack.Children.Add(head);
        if (detail.Length > 0) stack.Children.Add(Ui.Hint(detail));
        return new Border { Child = stack, Background = Theme.Brush("Raised"), BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 7, 10, 7) };
    }

    private static Grid Line(string mark, string text, string brush = "Ink2")
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(new TextBlock { Text = mark, Foreground = Theme.Brush(brush), FontWeight = FontWeights.SemiBold });
        var body = new TextBlock { Text = text, Foreground = Theme.Brush(brush == "Ink2" ? "Ink2" : brush), TextWrapping = TextWrapping.Wrap, FontSize = 13, IsTextSelectionEnabled = true };
        Grid.SetColumn(body, 1);
        grid.Children.Add(body);
        return grid;
    }

    // ---------- workflows ----------

    private static void RunResult(StackPanel panel, JsonElement result)
    {
        var ok = result.B("ok");
        panel.Children.Add(Ui.Row(8, Ui.Pill(ok ? "สำเร็จ" : result.At("suspended").ValueKind == JsonValueKind.Object ? "รออยู่" : "ผิดพลาด", ok ? "Ok" : "Bad"),
            Ui.Hint(result.S("runId").Length > 0 ? $"การรัน #{result.S("runId")}" : "")));
        if (result.S("result").Length > 0) panel.Children.Add(Ui.Title(result.S("result"), 14));
        if (result.At("suspended") is { ValueKind: JsonValueKind.Object } suspended)
        {
            panel.Children.Add(Ui.Hint($"หยุดรอที่ node {suspended.S("nodeId")} ({(suspended.S("kind") == "approval" ? "รออนุมัติในแชต" : $"รอเวลา {suspended.S("resumeAt")}")})", "Warn"));
        }
        var nodes = result.A("nodes").ToList();
        if (nodes.Count == 0) return;
        panel.Children.Add(Ui.Section($"node ({nodes.Count})"));
        foreach (var node in nodes)
        {
            var nodeOk = node.At("error").ValueKind is JsonValueKind.Undefined or JsonValueKind.Null && node.S("status") is not "error";
            var input = node.A("input").Count();
            var output = node.A("output").Count();
            var expander = new Expander
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Header = Ui.Row(8, Ui.Pill(nodeOk ? "ok" : "error", nodeOk ? "Ok" : "Bad"),
                    new TextBlock { Text = node.S("title") is { Length: > 0 } title ? title : node.S("id"), FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center },
                    Ui.Hint($"{node.S("type")} · {input} → {output}")),
            };
            var body = new StackPanel { Spacing = 6 };
            if (node.S("error").Length > 0) body.Children.Add(Ui.Hint(node.S("error"), "Bad"));
            if (node.S("note").Length > 0) body.Children.Add(Ui.Hint(node.S("note") == "pinned" ? "📌 ใช้ข้อมูลที่ pin ไว้" : "ปิดอยู่ (ส่งผ่าน)"));
            body.Children.Add(Items("ข้อมูลเข้า", node.A("input")));
            body.Children.Add(Items("ข้อมูลออก", node.A("output")));
            expander.Content = body;
            panel.Children.Add(expander);
        }
    }

    private static void NodeResult(StackPanel panel, JsonElement result)
    {
        var ok = result.B("ok");
        panel.Children.Add(Ui.Row(8, Ui.Pill(ok ? "ok" : "error", ok ? "Ok" : "Bad"), Ui.Hint($"ข้อมูลเข้า {result.A("input").Count()} รายการ")));
        if (result.S("error").Length > 0) panel.Children.Add(Ui.Hint(result.S("error"), "Bad"));
        if (result.At("outputs").ValueKind == JsonValueKind.Object)
        {
            foreach (var output in result.At("outputs").EnumerateObject())
            {
                panel.Children.Add(Items($"ทางออก \"{output.Name}\"", output.Value.ValueKind == JsonValueKind.Array ? output.Value.EnumerateArray() : []));
            }
        }
    }

    /// <summary>Flow items ({json: …}) as a numbered list of their fields.</summary>
    public static FrameworkElement Items(string title, IEnumerable<JsonElement> items)
    {
        var list = items.ToList();
        var stack = new StackPanel { Spacing = 4 };
        stack.Children.Add(Ui.Section($"{title} ({list.Count})"));
        if (list.Count == 0) stack.Children.Add(Ui.Hint("— ไม่มี —", "Faint"));
        foreach (var (item, index) in list.Take(20).Select((item, index) => (item, index)))
        {
            var json = item.At("json").ValueKind == JsonValueKind.Undefined ? item : item.At("json");
            stack.Children.Add(Ui.Row(6, Ui.Hint($"#{index + 1}", "Faint")));
            stack.Children.Add(Value(json, 1));
        }
        if (list.Count > 20) stack.Children.Add(Ui.Hint($"… อีก {list.Count - 20} รายการ", "Faint"));
        return stack;
    }

    private static void Runs(StackPanel panel, JsonElement reply)
    {
        var runs = reply.A("runs").ToList();
        panel.Children.Add(Ui.Hint($"{reply.S("workflow")} · {runs.Count} ครั้งล่าสุด"));
        foreach (var run in runs)
        {
            var status = run.S("status");
            panel.Children.Add(Card($"#{run.S("id")} · {Time(run.S("startedAt"))}", status switch { "ok" => "สำเร็จ", "error" => "ผิดพลาด", "waiting" => "รอ", _ => status },
                J.Join([run.S("trigger"), run.S("result"), run.S("error"), run.S("durationMs").Length > 0 ? $"{run.S("durationMs")} ms" : ""], " · ")));
        }
        if (runs.Count == 0) panel.Children.Add(Ui.Hint("ยังไม่เคยรัน", "Faint"));
    }

    private static string Time(string iso) =>
        DateTimeOffset.TryParse(iso, out var when) ? when.ToLocalTime().ToString("d MMM HH:mm:ss", new System.Globalization.CultureInfo("th-TH")) : iso;

    // ---------- anything else ----------

    /// <summary>A value as rows: objects as "label: value", lists of objects as cards, plain lists as lines.</summary>
    public static FrameworkElement Value(JsonElement value, int depth)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var grid = new Grid { ColumnSpacing = 10, RowSpacing = 5 };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                var row = 0;
                foreach (var property in value.EnumerateObject())
                {
                    grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                    var key = Ui.Hint(Label(property.Name));
                    key.MaxWidth = 160;
                    Grid.SetRow(key, row);
                    grid.Children.Add(key);
                    var shown = depth > 4 ? Ui.Mono(property.Value.GetRawText(), 11) : Value(property.Value, depth + 1);
                    Grid.SetRow(shown, row);
                    Grid.SetColumn(shown, 1);
                    grid.Children.Add(shown);
                    row++;
                }
                if (row == 0) return Ui.Hint("—", "Faint");
                return depth == 0 ? grid : new Border { Child = grid, BorderBrush = Theme.Brush("LineSoft"), BorderThickness = new Thickness(2, 0, 0, 0), Padding = new Thickness(8, 0, 0, 0) };
            }
            case JsonValueKind.Array:
            {
                var stack = new StackPanel { Spacing = 5 };
                var items = value.EnumerateArray().ToList();
                if (items.Count == 0) return Ui.Hint("— ไม่มี —", "Faint");
                foreach (var item in items.Take(50))
                {
                    stack.Children.Add(item.ValueKind == JsonValueKind.Object
                        ? new Border { Child = Value(item, depth + 1), Background = Theme.Brush("Raised"), CornerRadius = new CornerRadius(8), Padding = new Thickness(8, 6, 8, 6) }
                        : Line("•", Scalar(item)));
                }
                if (items.Count > 50) stack.Children.Add(Ui.Hint($"… อีก {items.Count - 50} รายการ", "Faint"));
                return stack;
            }
            case JsonValueKind.True:
                return Ui.Pill("ใช่", "Ok");
            case JsonValueKind.False:
                return Ui.Pill("ไม่", "Muted");
            default:
                return new TextBlock { Text = Scalar(value), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Foreground = Theme.Brush("Ink"), FontSize = 13 };
        }
    }

    private static string Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() is { } text && text.Length > 10 && DateTimeOffset.TryParse(text, out _) && text.Contains('T') ? Time(text) : value.GetString() ?? "",
        JsonValueKind.Null or JsonValueKind.Undefined => "—",
        _ => value.GetRawText(),
    };
}
