using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Mimi.Core.Hub;

/// <summary>
/// What the workflow editor works out from the draft without a screen (feature-workflows.js): the fields of a
/// connector node (service → operation → that operation's own fields, credentials in the connection), the sample
/// data an expression is previewed with, the paths the "{ } เลือกข้อมูล" picker and the suggestions offer.
/// </summary>
public static partial class WorkflowAssist
{
    // ---------- the fields of a node ----------

    private static JsonObject Field(string key, string label, string type, string? description = null, bool required = false, JsonArray? options = null)
    {
        var field = new JsonObject { ["key"] = key, ["label"] = label, ["type"] = type };
        if (required) field["required"] = true;
        if (description is { Length: > 0 }) field["description"] = description;
        if (options is not null) field["options"] = options;
        return field;
    }

    private static JsonArray Pairs(IEnumerable<(string Value, string Label)> pairs) =>
        new(pairs.Select(pair => (JsonNode)new JsonArray(pair.Value, pair.Label)).ToArray());

    private static string Str(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";

    private static JsonElement Element(JsonObject json) => JsonDocument.Parse(json.ToJsonString()).RootElement.Clone();

    private static IEnumerable<(string Value, string Label)> ConnectionChoices(IEnumerable<JsonElement> connections, string connector, string fallback) =>
        new[] { ("", fallback) }.Concat(connections
            .Where(entry => entry.S("connector") == connector)
            .Select(entry => (entry.S("id"), $"{entry.S("name")}{(entry.B("default") ? " ★" : "")}{(entry.B("connected") ? "" : " (ยังไม่เชื่อมต่อ)")}")));

    /// <summary>
    /// The fields a node's panel shows (fieldsOfNode): a connector node gets service / version / operation /
    /// connection and the operation's fields (marked <c>connectorInput</c>: they live in <c>config.input</c>);
    /// a connector trigger gets service / trigger / connection and its pool entry's fields; a custom trigger
    /// gets the pool name and that entry's fields; every other node gets its spec's fields.
    /// </summary>
    public static IReadOnlyList<JsonElement> FieldsOf(JsonObject node, IReadOnlyList<JsonElement> nodeTypes, IReadOnlyList<JsonElement> pool, IReadOnlyList<JsonElement> connectors, IReadOnlyList<JsonElement> connections)
    {
        var type = WorkflowDraft.TypeOf(node);
        var config = node["config"] as JsonObject ?? [];
        if (type == "connector") return ConnectorFields(config, connectors, connections).Select(Element).ToList();
        if (type == "trigger_connector") return ConnectorTriggerFields(node, config, pool, connectors, connections).Select(Element).ToList();
        var spec = nodeTypes.FirstOrDefault(entry => entry.S("type") == type);
        if (type != "trigger_custom") return spec.ValueKind == JsonValueKind.Object ? spec.A("fields").Select(field => field.Clone()).ToList() : [];
        var custom = pool.Where(entry => !entry.B("builtin")).ToList();
        var chosen = custom.FirstOrDefault(entry => entry.S("name") == Str(config["pool"]));
        var list = new List<JsonElement>
        {
            Element(Field("pool", "trigger จาก pool", "string", custom.Count == 0 ? "ยังไม่มี trigger ที่สร้างเอง — สร้างได้ที่ Hub → Trigger" : null, required: true,
                options: new JsonArray(custom.Select(entry => (JsonNode)JsonValue.Create(entry.S("name"))!).ToArray()))),
        };
        if (chosen.ValueKind == JsonValueKind.Object) list.AddRange(chosen.A("fields").Where(field => field.S("key") != "pool").Select(field => field.Clone()));
        return list;
    }

    private static List<JsonObject> ConnectorFields(JsonObject config, IReadOnlyList<JsonElement> connectors, IReadOnlyList<JsonElement> connections)
    {
        var connector = connectors.FirstOrDefault(entry => entry.S("key") == Str(config["connector"]));
        if (connector.ValueKind != JsonValueKind.Object) connector = connectors.FirstOrDefault();
        var fields = new List<JsonObject>
        {
            Field("connector", "Service", "string", connector.ValueKind == JsonValueKind.Object ? connector.S("description") : "ยังไม่มี connector ที่ติดตั้ง", required: true,
                options: Pairs(connectors.Select(entry => (entry.S("key"), entry.S("label") is { Length: > 0 } label ? $"{label} ({entry.S("key")})" : entry.S("key"))))),
        };
        if (connector.ValueKind != JsonValueKind.Object) return fields;
        var operations = connector.A("operations").ToList();
        var operationKey = Str(config["operation"]) is { Length: > 0 } chosen ? chosen : operations.FirstOrDefault().S("key");
        var latest = connector.S("version");
        var versions = connector.Strings("versions").ToList();
        if (versions.Count == 0 && latest.Length > 0) versions.Add(latest);
        fields.Add(Field("version", "Connector version", "string", "เว้นว่าง = ใช้ version ล่าสุด · workflow ที่ pin version เก่าไว้จะยังรัน version เดิม",
            options: Pairs(new[] { ("", $"latest{(latest.Length > 0 ? $" (v{latest})" : "")}") }.Concat(versions.Select(entry => (entry, entry == latest ? $"{entry} (latest)" : entry))))));
        var operation = operations.FirstOrDefault(entry => entry.S("key") == operationKey);
        fields.Add(Field("operation", "Operation", "string", operation.ValueKind == JsonValueKind.Object ? operation.S("description") : null, required: true,
            options: Pairs(operations.Select(entry => (entry.S("key"), entry.S("label") is { Length: > 0 } label ? $"{label} ({entry.S("key")})" : entry.S("key"))))));
        if (connector.S("key").StartsWith("google_", StringComparison.Ordinal))
        {
            var account = Field("account", "บัญชี Google", "account", "เว้นว่าง = บัญชี Google เริ่มต้น");
            account["service"] = "google";
            fields.Add(account);
        }
        else
        {
            var own = connections.Count(entry => entry.S("connector") == connector.S("key"));
            fields.Add(Field("account", "Connection", "string", own == 0 ? "ยังไม่มี connection — เพิ่มได้ที่ Hub → บัญชี" : null,
                options: Pairs(ConnectionChoices(connections, connector.S("key"), "— connection เริ่มต้น —"))));
        }
        if (operation.ValueKind != JsonValueKind.Object) return fields;
        foreach (var spec in operation.A("fields"))
        {
            var field = (JsonObject)JsonNode.Parse(spec.GetRawText())!;
            field["connectorInput"] = true;
            if (Str(field["type"]) == "select" && field["options"] is JsonArray options)
            {
                field["options"] = Pairs(options.OfType<JsonObject>().Select(option => (Str(option["value"]) is { Length: > 0 } value ? value : option["value"]?.ToJsonString() ?? "", Str(option["label"]) is { Length: > 0 } label ? label : Str(option["value"]))));
            }
            fields.Add(field);
        }
        if (operation.S("risk") != "read") fields.Add(Field("allow", "อนุญาตให้ทำงานนี้ (write/delete)", "boolean", "ต้องเปิดเพื่อให้ workflow เรียก operation นี้ได้"));
        return fields;
    }

    private static List<JsonObject> ConnectorTriggerFields(JsonObject node, JsonObject config, IReadOnlyList<JsonElement> pool, IReadOnlyList<JsonElement> connectors, IReadOnlyList<JsonElement> connections)
    {
        var withTriggers = connectors.Where(entry => entry.A("triggers").Any()).ToList();
        var connector = withTriggers.FirstOrDefault(entry => entry.S("key") == Str(config["connector"]));
        if (connector.ValueKind != JsonValueKind.Object) connector = withTriggers.FirstOrDefault();
        var triggers = connector.ValueKind == JsonValueKind.Object ? connector.A("triggers").ToList() : [];
        var trigger = triggers.FirstOrDefault(entry => entry.S("key") == Str(config["trigger"]));
        if (trigger.ValueKind != JsonValueKind.Object) trigger = triggers.FirstOrDefault();
        var fields = new List<JsonObject>
        {
            Field("connector", "Service", "string", connector.ValueKind == JsonValueKind.Object ? connector.S("description") : "ยังไม่มี connector ที่มี trigger", required: true,
                options: Pairs(withTriggers.Select(entry => (entry.S("key"), entry.S("label") is { Length: > 0 } label ? label : entry.S("key"))))),
            Field("trigger", "Trigger", "string", trigger.ValueKind == JsonValueKind.Object ? trigger.S("description") : null, required: true,
                options: Pairs(triggers.Select(entry => (entry.S("key"), entry.S("label") is { Length: > 0 } label ? label : entry.S("key"))))),
        };
        if (connector.ValueKind != JsonValueKind.Object || trigger.ValueKind != JsonValueKind.Object) return fields;
        if (connector.S("auth.kind") != "none")
        {
            var own = connections.Count(entry => entry.S("connector") == connector.S("key"));
            fields.Add(Field("account", "Connection", "string", own == 0 ? "ยังไม่มี connection — เพิ่มได้ที่ Hub → บัญชี" : null,
                options: Pairs(ConnectionChoices(connections, connector.S("key"), "connection เริ่มต้น"))));
        }
        var poolName = WorkflowDraft.PoolOf(node) ?? $"connector:{connector.S("key")}:{trigger.S("key")}";
        var entry = pool.FirstOrDefault(item => item.S("name") == poolName);
        foreach (var field in entry.ValueKind == JsonValueKind.Object ? entry.A("fields") : [])
        {
            if (field.S("key") != "input") fields.Add((JsonObject)JsonNode.Parse(field.GetRawText())!);
        }
        fields.Add(Field("input", "Input (JSON)", "json", "ค่าเพิ่มเติมที่ส่งไปกับทุก event ของ trigger นี้"));
        return fields;
    }

    /// <summary>Fields whose change redraws the panel: the service and operation pick the other fields.</summary>
    public static bool Reshapes(string type, string key) =>
        (type, key) is ("connector", "connector" or "operation" or "version") or ("trigger_connector", "connector" or "trigger") or ("trigger_custom", "pool");

    /// <summary>The options question of a connector field that reads them from the service (<c>optionsFrom</c>), or null while a field it depends on is empty.</summary>
    public static JsonObject? OptionsQuestion(JsonElement field, JsonObject config, long reqId, out IReadOnlyList<string> missing)
    {
        missing = [];
        var from = field.At("optionsFrom");
        if (from.ValueKind != JsonValueKind.Object) return null;
        var payload = (config["input"] as JsonObject)?.DeepClone() as JsonObject ?? [];
        missing = from.Strings("dependsOn").Where(key => payload[key] is null || payload[key] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length == 0).ToList();
        if (missing.Count > 0) return null;
        var question = new JsonObject
        {
            ["type"] = "connector-operation-options",
            ["reqId"] = reqId,
            ["connector"] = from.S("connector"),
            ["operation"] = from.S("operation"),
            ["labelField"] = from.S("labelField"),
            ["valueField"] = from.S("valueField"),
            ["input"] = payload,
        };
        if (Str(config["account"]) is { Length: > 0 } account) question["account"] = account;
        return question;
    }

    /// <summary>The connector fields that read their options from <paramref name="key"/> (they reset when it changes).</summary>
    public static IEnumerable<string> DependentsOf(IEnumerable<JsonElement> fields, string key) =>
        fields.Where(field => field.B("connectorInput") && field.At("optionsFrom").Strings("dependsOn").Contains(key)).Select(field => field.S("key"));

    // ---------- sample data for expressions ----------

    /// <summary>Every node that runs before this one (all predecessors, all the way back).</summary>
    public static IReadOnlyList<JsonObject> Ancestors(WorkflowDraft draft, string nodeId)
    {
        var seen = new HashSet<string>();
        void Walk(string id)
        {
            foreach (var other in draft.NodeList)
            {
                var otherId = WorkflowDraft.IdOf(other);
                if (seen.Contains(otherId) || !WorkflowDraft.Targets(other).Contains(id)) continue;
                seen.Add(otherId);
                Walk(otherId);
            }
        }
        Walk(nodeId);
        return draft.NodeList.Where(node => seen.Contains(WorkflowDraft.IdOf(node))).ToList();
    }

    private static JsonElement RunOf(JsonElement run, string id) => run.A("nodes").FirstOrDefault(entry => entry.S("id") == id);

    private static JsonObject? FirstJson(JsonElement items) =>
        items.ValueKind == JsonValueKind.Array && items.GetArrayLength() > 0 && items[0].At("json") is { ValueKind: JsonValueKind.Object } json ? (JsonObject)JsonNode.Parse(json.GetRawText())! : null;

    /// <summary>The trigger's own sample: a manual trigger's typed input, else its pool entry's sample.</summary>
    public static JsonObject TriggerSample(WorkflowDraft draft, IReadOnlyList<JsonElement> pool)
    {
        var trigger = draft.NodeList.FirstOrDefault(node => WorkflowDraft.IsTrigger(WorkflowDraft.TypeOf(node)));
        var poolName = trigger is null ? "manual" : WorkflowDraft.PoolOf(trigger) ?? "manual";
        if (poolName == "manual" && trigger?["config"]?["input"] is JsonObject typed && typed.Count > 0) return (JsonObject)typed.DeepClone();
        var sample = pool.FirstOrDefault(entry => entry.S("name") == poolName).At("sample");
        return sample.ValueKind == JsonValueKind.Object ? (JsonObject)JsonNode.Parse(sample.GetRawText())! : [];
    }

    /// <summary>
    /// What an expression of <paramref name="node"/> is previewed with (sampleFor): what it got in the last run,
    /// else the output of the nearest earlier node that ran, else the trigger's sample — plus every node's output
    /// of that run by title and id (<c>$node[…]</c>).
    /// </summary>
    public static (JsonObject Json, JsonObject Nodes, string Note) Sample(WorkflowDraft draft, JsonObject node, JsonElement lastRun, IReadOnlyList<JsonElement> pool)
    {
        var id = WorkflowDraft.IdOf(node);
        var note = "จากการรันล่าสุด";
        var json = FirstJson(RunOf(lastRun, id).At("input"));
        json ??= Ancestors(draft, id).Select(other => FirstJson(RunOf(lastRun, WorkflowDraft.IdOf(other)).At("output"))).FirstOrDefault(found => found is not null);
        if (json is null)
        {
            json = TriggerSample(draft, pool);
            note = "ตัวอย่างจาก trigger — รันก่อนเพื่อเห็นข้อมูลจริง";
        }
        var nodes = new JsonObject();
        foreach (var view in lastRun.A("nodes"))
        {
            var output = view.At("output");
            if (output.ValueKind != JsonValueKind.Array || output.GetArrayLength() == 0) continue;
            var record = new JsonObject
            {
                ["json"] = FirstJson(output) ?? [],
                ["items"] = new JsonArray(output.EnumerateArray().Select(item => item.At("json") is { ValueKind: JsonValueKind.Object } entry ? JsonNode.Parse(entry.GetRawText()) : new JsonObject()).ToArray()),
            };
            if (view.S("title") is { Length: > 0 } title) nodes[title] = record.DeepClone();
            nodes[view.S("id")] = record;
        }
        return (json, nodes, note);
    }

    /// <summary>The preview question for an expression (workflow-expr-preview); the answer comes with the same reqId.</summary>
    public static string PreviewFrame(long reqId, string text, JsonObject json, JsonObject nodes, JsonNode? vars) =>
        new JsonObject
        {
            ["type"] = "workflow-expr-preview",
            ["reqId"] = reqId,
            ["text"] = text,
            ["json"] = json.DeepClone(),
            ["nodes"] = nodes.DeepClone(),
            ["vars"] = vars?.DeepClone() ?? new JsonObject(),
        }.ToJsonString();

    // ---------- the picker and the suggestions ----------

    public sealed record PathItem(string Path, string Preview);

    public sealed record PathGroup(string Label, IReadOnlyList<PathItem> Items);

    private static readonly JsonSerializerOptions Plain = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    [GeneratedRegex(@"^[A-Za-z_$][\w$]*$")]
    private static partial Regex Identifier();

    /// <summary>A path segment in expression syntax: <c>.name</c> for a plain identifier, else <c>["name"]</c>.</summary>
    public static string Segment(string key) => Identifier().IsMatch(key) ? $".{key}" : $"[{JsonSerializer.Serialize(key, Plain)}]";

    public static string Preview(JsonNode? value)
    {
        var text = value switch
        {
            null => "null",
            JsonValue plain when plain.TryGetValue<string>(out var s) => s,
            _ => value.ToJsonString(),
        };
        return text.Length > 48 ? $"{text[..48]}…" : text;
    }

    /// <summary>Every path in a sample (three levels; a list shows its first entry).</summary>
    public static List<PathItem> PathsOf(JsonNode? value, string path, int depth = 0, List<PathItem>? into = null)
    {
        into ??= [];
        if (depth > 2) return into;
        switch (value)
        {
            case JsonObject json:
                foreach (var (key, child) in json)
                {
                    var next = path + Segment(key);
                    into.Add(new PathItem(next, Preview(child)));
                    PathsOf(child, next, depth + 1, into);
                }
                break;
            case JsonArray { Count: > 0 } list:
                into.Add(new PathItem($"{path}[0]", Preview(list[0])));
                PathsOf(list[0], $"{path}[0]", depth + 1, into);
                break;
        }
        return into;
    }

    /// <summary>What the picker offers for a node (pickerGroups): its input, earlier nodes' outputs, the variables and the built-ins.</summary>
    public static IReadOnlyList<PathGroup> Groups(WorkflowDraft draft, JsonObject node, JsonElement lastRun, IReadOnlyList<JsonElement> pool)
    {
        var (json, _, note) = Sample(draft, node, lastRun, pool);
        var groups = new List<PathGroup> { new($"ข้อมูลที่ไหลเข้ามา ($json) · {note}", PathsOf(json, "$json")) };
        foreach (var other in Ancestors(draft, WorkflowDraft.IdOf(node)))
        {
            if (FirstJson(RunOf(lastRun, WorkflowDraft.IdOf(other)).At("output")) is not { } output) continue;
            var name = Str(other["title"]).Trim() is { Length: > 0 } title ? title : WorkflowDraft.IdOf(other);
            groups.Add(new PathGroup($"ผลของ node \"{name}\"", PathsOf(output, $"$node[{JsonSerializer.Serialize(name, Plain)}].json")));
        }
        var vars = PathsOf(draft.Workflow["vars"], "$vars");
        if (vars.Count > 0) groups.Add(new PathGroup("ตัวแปรของ workflow", vars));
        groups.Add(new PathGroup("ค่าพื้นฐาน",
        [
            new("$today", "วันนี้ YYYY-MM-DD"),
            new("$now", "เวลาตอนนี้ (ISO)"),
            new("$index", "ลำดับของ item"),
            new("$execution.mode", "manual / schedule / webhook…"),
            new("$workflow.title", Str(draft.Workflow["title"]) is { Length: > 0 } shown ? shown : Str(draft.Workflow["name"])),
        ]));
        return groups;
    }

    [GeneratedRegex(@"\$[\w$.\[\]""]*$")]
    private static partial Regex TokenEnd();

    /// <summary>The <c>$path</c> being typed at the caret inside an open <c>{{ … }}</c>, or null.</summary>
    public static (int Start, string Text)? TokenAt(string text, int caret)
    {
        var before = text[..Math.Clamp(caret, 0, text.Length)];
        var open = before.LastIndexOf("{{", StringComparison.Ordinal);
        if (open < 0 || before.LastIndexOf("}}", StringComparison.Ordinal) > open) return null;
        var match = TokenEnd().Match(before);
        return match.Success ? (before.Length - match.Length, match.Value) : null;
    }

    /// <summary>Up to eight suggestions that continue the token at the caret.</summary>
    public static IReadOnlyList<PathItem> Suggest(IEnumerable<PathGroup> groups, string text, int caret)
    {
        if (TokenAt(text, caret) is not { } token) return [];
        return groups.SelectMany(group => group.Items).Where(item => item.Path.StartsWith(token.Text, StringComparison.Ordinal) && item.Path != token.Text).Take(8).ToList();
    }

    /// <summary>The text with the token at the caret replaced by <paramref name="path"/> (closing the braces when needed), and the new caret.</summary>
    public static (string Text, int Caret) Pick(string text, int caret, string path)
    {
        if (TokenAt(text, caret) is not { } token) return (text, caret);
        var end = Math.Clamp(caret, 0, text.Length);
        var after = text[end..];
        var closing = after.TrimStart().StartsWith("}}", StringComparison.Ordinal) ? "" : " }}";
        return (text[..token.Start] + path + closing + after, token.Start + path.Length + closing.Length);
    }

    /// <summary>Puts <c>{{ path }}</c> over the selection (the picker's insert).</summary>
    public static (string Text, int Caret) Insert(string text, int start, int length, string path)
    {
        start = Math.Clamp(start, 0, text.Length);
        length = Math.Clamp(length, 0, text.Length - start);
        var inserted = $"{{{{ {path} }}}}";
        return (text[..start] + inserted + text[(start + length)..], start + inserted.Length);
    }
}

/// <summary>Undo / redo of the editor: whole-draft snapshots taken after each change (feature-workflows.js checkpoint).</summary>
public sealed class DraftHistory
{
    private readonly List<string> past = [];
    private readonly List<string> future = [];
    private string? snapshot;

    public void Reset(JsonObject? workflow)
    {
        past.Clear();
        future.Clear();
        snapshot = workflow?.ToJsonString();
    }

    public bool CanUndo => past.Count > 0;
    public bool CanRedo => future.Count > 0;

    /// <summary>Records the draft as it is now (nothing when it did not change).</summary>
    public void Checkpoint(JsonObject workflow)
    {
        var now = workflow.ToJsonString();
        if (now == snapshot) return;
        if (snapshot is not null) past.Add(snapshot);
        if (past.Count > 80) past.RemoveAt(0);
        future.Clear();
        snapshot = now;
    }

    /// <summary>The draft one step back, or null when there is none.</summary>
    public JsonObject? Undo(JsonObject current)
    {
        Checkpoint(current);
        if (past.Count == 0) return null;
        future.Add(snapshot!);
        snapshot = past[^1];
        past.RemoveAt(past.Count - 1);
        return (JsonObject)JsonNode.Parse(snapshot)!;
    }

    public JsonObject? Redo()
    {
        if (future.Count == 0) return null;
        past.Add(snapshot!);
        snapshot = future[^1];
        future.RemoveAt(future.Count - 1);
        return (JsonObject)JsonNode.Parse(snapshot)!;
    }
}

/// <summary>
/// Node presets (feature-tools.js nodePresets): a node with its settings filled in, kept in the shared screen
/// settings under <c>mimi.nodePreset.&lt;id&gt;</c> so every device of the account has them.
/// </summary>
public static class NodePresets
{
    public const string Prefix = "mimi.nodePreset.";
    public const int Limit = 3900;

    public sealed record Preset(string Id, string Title, string Description, string Type, JsonObject Config);

    public static IReadOnlyList<Preset> Read(IEnumerable<KeyValuePair<string, string>> values)
    {
        var list = new List<Preset>();
        foreach (var (key, text) in values)
        {
            if (!key.StartsWith(Prefix, StringComparison.Ordinal)) continue;
            try
            {
                if (JsonNode.Parse(text) is not JsonObject value || value["type"] is not JsonValue type || !type.TryGetValue<string>(out var typeName)) continue;
                list.Add(new Preset(key[Prefix.Length..], value.Str("title"), value.Str("description"), typeName, value["config"] as JsonObject is { } config ? (JsonObject)config.DeepClone() : []));
            }
            catch (JsonException)
            {
                // a broken entry is skipped, as the web does
            }
        }
        return list.OrderBy(preset => preset.Title, StringComparer.CurrentCulture).ToList();
    }

    /// <summary>The (key, value) to store a preset of this node; throws when it is too big for the shared settings.</summary>
    public static (string Key, string Value) Make(string title, string description, JsonObject node, DateTimeOffset now, string? id = null)
    {
        id ??= $"p{now.ToUnixTimeMilliseconds():x}{Random.Shared.Next(0x10000):x4}";
        var value = new JsonObject
        {
            ["title"] = title,
            ["description"] = description,
            ["type"] = WorkflowDraft.TypeOf(node),
            ["config"] = node["config"]?.DeepClone() ?? new JsonObject(),
            ["updatedAt"] = now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        }.ToJsonString();
        if (value.Length > Limit) throw new InvalidOperationException($"preset ใหญ่เกินไป ({value.Length} ตัวอักษร, สูงสุด {Limit})");
        return (Prefix + id, value);
    }
}
