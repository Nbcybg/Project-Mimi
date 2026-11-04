using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using Mimi.Core.Protocol;

namespace Mimi.Core.Hub;

/// <summary>How one field of an edit form looks.</summary>
public enum FieldKind
{
    Text,
    /// <summary>Several lines (prompts, bodies, notes).</summary>
    Multiline,
    Number,
    Bool,
    /// <summary>One of <see cref="FieldSpec.Options"/>.</summary>
    Choice,
    /// <summary>A list of strings, one per line.</summary>
    List,
    /// <summary>Any JSON (objects, lists of objects), edited as text.</summary>
    Json,
    /// <summary>Typed but never shown back (API keys, passwords).</summary>
    Secret,
    /// <summary>Shown, not edited.</summary>
    ReadOnly,
    /// <summary>An object edited with its own fields (<see cref="FieldSpec.Children"/>), shown as a sub-card.</summary>
    Group,
    /// <summary>An object of name → value edited as rows (workflow variables, settings without a spec).</summary>
    KeyValue,
    /// <summary>A list of objects, one sub-card per entry with <see cref="FieldSpec.Children"/>, plus "add" (profile fields).</summary>
    Rows,
    /// <summary>Who sees it: <c>"*"</c> (every agent) or a list of agent names.</summary>
    Audience,
    /// <summary>Fields worked out from the item and the lookups (<see cref="FieldSpec.Expand"/>): a connector's own credentials, a tool's settings.</summary>
    Dynamic,
}

/// <summary>
/// One field of a form: a dotted <paramref name="Path"/> into the item's JSON (<c>models.model</c>),
/// its label and hint as the web page words them. <paramref name="Options"/> are (value, label);
/// <paramref name="OptionsFrom"/> names a list the screen fills at run time (models, agents, tools…).
/// </summary>
public sealed record FieldSpec(
    string Path,
    string Label,
    FieldKind Kind = FieldKind.Text,
    string? Hint = null,
    IReadOnlyList<(string Value, string Label)>? Options = null,
    string? OptionsFrom = null,
    /// <summary>For <see cref="FieldKind.Group"/>: the fields inside, with paths relative to this one.</summary>
    IReadOnlyList<FieldSpec>? Children = null,
    /// <summary>Shown only while this says so (given the whole item): fields of one kind of account, of one protocol…</summary>
    Func<System.Text.Json.Nodes.JsonObject, bool>? ShowWhen = null,
    /// <summary>For <see cref="FieldKind.Dynamic"/>: the fields for the item as it is now (paths from the item's root).</summary>
    Func<System.Text.Json.Nodes.JsonObject, Lookups, IReadOnlyList<FieldSpec>>? Expand = null,
    /// <summary>For <see cref="FieldKind.Rows"/>: a new entry (given the entries there already).</summary>
    Func<System.Text.Json.Nodes.JsonArray, System.Text.Json.Nodes.JsonObject>? NewRow = null,
    /// <summary>An empty value is left out instead of stored as "" (a credential kept as it was until a new one is typed).</summary>
    bool OmitEmpty = false,
    string? Placeholder = null);

/// <summary>Form fields from what the server describes (a tool's settings, a connector's credentials: <c>ToolSettingField</c> / <c>ConnectorField</c>).</summary>
public static class ServerFields
{
    /// <summary>One server field as a form field under <paramref name="parent"/> (e.g. <c>settings</c> → <c>settings.channel</c>).</summary>
    public static FieldSpec From(JsonElement field, string parent, bool keepSecrets = false, bool omitEmpty = false)
    {
        var key = field.S("key");
        var label = (field.S("label") is { Length: > 0 } shown ? shown : key) + (field.B("required") ? " *" : "");
        var path = parent.Length > 0 ? $"{parent}.{key}" : key;
        var hint = field.S("description") is { Length: > 0 } description ? description : null;
        var placeholder = field.S("placeholder") is { Length: > 0 } text ? text : null;
        var options = field.A("options").Select(option => option.ValueKind == JsonValueKind.Object
            ? (option.S("value"), option.S("label") is { Length: > 0 } optionLabel ? optionLabel : option.S("value"))
            : (option.ToString(), option.ToString())).ToList();
        return field.S("type") switch
        {
            // A preset's secret is a {{secret.NAME}} reference, typed and shown like text.
            "secret" when keepSecrets => new FieldSpec(path, label, FieldKind.Text, hint ?? "ใส่ {{secret.ชื่อ}} แทนตัวคีย์ (คีย์จริงเก็บใน Hub → คีย์ลับ)", OmitEmpty: omitEmpty, Placeholder: placeholder ?? "{{secret.ชื่อ}}"),
            "secret" => new FieldSpec(path, label, FieldKind.Secret, hint, OmitEmpty: true, Placeholder: placeholder),
            "number" => new FieldSpec(path, label, FieldKind.Number, hint, Placeholder: placeholder),
            "boolean" => new FieldSpec(path, label, FieldKind.Bool, hint),
            "text" => new FieldSpec(path, label, FieldKind.Multiline, hint, OmitEmpty: omitEmpty, Placeholder: placeholder),
            "account" => new FieldSpec(path, label, FieldKind.Choice, hint, OptionsFrom: field.S("service") is { Length: > 0 } service ? $"accounts:{service}" : "accounts"),
            "connection" => new FieldSpec(path, label, FieldKind.Choice, hint, OptionsFrom: $"connections:{field.S("connector")}"),
            _ when options.Count > 0 => new FieldSpec(path, label, FieldKind.Choice, hint, Options: options),
            _ => new FieldSpec(path, label, FieldKind.Text, hint, OmitEmpty: omitEmpty, Placeholder: placeholder),
        };
    }

    /// <summary>The settings a tool preset fills in: the chosen tool's own settings, or name → value rows for a tool without a list.</summary>
    public static IReadOnlyList<FieldSpec> PresetSettings(JsonObject preset, Lookups lookups)
    {
        var tool = lookups.Items("tools").FirstOrDefault(entry => entry.S("name") == preset.Str("tool"));
        var settings = tool.ValueKind == JsonValueKind.Object ? tool.A("settings").ToList() : [];
        if (settings.Count == 0) return [new FieldSpec("settings", "ค่าที่ตั้ง (ชื่อ → ค่า)", FieldKind.KeyValue, "ค่าลับ (secret) ใส่ {{secret.ชื่อ}} แทนตัวคีย์")];
        return settings.Select(field => From(field, "settings", keepSecrets: true)).ToList();
    }

    /// <summary>A connection's credentials (the connector's auth fields; old values are never sent back) and, for OAuth2, its endpoints.</summary>
    public static IReadOnlyList<FieldSpec> ConnectionFields(JsonObject connection, Lookups lookups)
    {
        var connector = lookups.Items("connectors").FirstOrDefault(entry => entry.S("key") == connection.Str("connector"));
        if (connector.ValueKind != JsonValueKind.Object)
        {
            return [new FieldSpec("fields", "ค่าที่ต้องใช้ (ชื่อช่อง → ค่า)", FieldKind.KeyValue, "เลือก connector ก่อน · ค่าเก่าไม่แสดง ใส่ใหม่เมื่อจะเปลี่ยน")];
        }
        var list = connector.A("auth.fields").Select(field => From(field, "fields", omitEmpty: true)).ToList();
        if (connector.S("auth.kind") == "oauth2")
        {
            list.Add(new FieldSpec("oauth", "OAuth2", FieldKind.Group, "ค่าเริ่มต้นมาจาก connector · แก้ได้ เช่น เปลี่ยน /common/ เป็น tenant ขององค์กร", Children:
            [
                new("authorizeUrl", "Authorization URL", Placeholder: connector.S("auth.authorizeUrl") is { Length: > 0 } authorize ? authorize : "https://…/authorize", OmitEmpty: true),
                new("tokenUrl", "Access Token URL", Placeholder: connector.S("auth.tokenUrl") is { Length: > 0 } token ? token : "https://…/token", OmitEmpty: true),
                new("scopes", "Scopes", FieldKind.List, string.Join(" ", connector.Strings("auth.scopes")) is { Length: > 0 } scopes ? $"ค่าเริ่มต้น: {scopes}" : null),
            ]));
        }
        if (list.Count == 0) list.Add(new FieldSpec("", "บริการนี้ไม่ต้องใช้ค่าลับ", FieldKind.ReadOnly));
        return list;
    }

    /// <summary>A new profile field with a key no other field has (feature-profile.js keyFor).</summary>
    public static JsonObject NewProfileField(JsonArray fields)
    {
        var n = 1;
        while (fields.OfType<JsonObject>().Any(field => field.Str("key") == $"field_{n}")) n++;
        return new JsonObject { ["key"] = $"field_{n}", ["label"] = "", ["value"] = "", ["visibleTo"] = "*" };
    }
}

/// <summary>
/// Something to do with an item (or the whole page when <see cref="ForItem"/> is false): optional
/// questions first (<see cref="Ask"/>), then a frame built from the item and the answers. When
/// <see cref="Reply"/> is set the screen waits for that frame and shows it (a run result, a report);
/// a reply with a <c>url</c> opens in the browser (sign-in links).
/// </summary>
public sealed record EntityAction(
    string Label,
    Func<JsonElement, JsonObject, string?> Frame,
    IReadOnlyList<FieldSpec>? Ask = null,
    string? Reply = null,
    bool ForItem = true,
    string? Confirm = null,
    Func<JsonElement, bool>? When = null,
    /// <summary>Instead of a frame: a file goes up to this path (pictures, models); the screen picks the file.</summary>
    Func<JsonElement, JsonObject, string>? UploadPath = null,
    string? UploadFilter = null,
    /// <summary>Instead of a frame: this path is downloaded and saved where the person chooses.</summary>
    Func<JsonElement, (string Path, string Name)>? DownloadPath = null,
    /// <summary>Instead of a frame: an HTTP DELETE of this path.</summary>
    Func<JsonElement, string>? DeletePath = null,
    /// <summary>Instead of a frame: POST the answers (as JSON) to this path and show what comes back.</summary>
    string? PostPath = null,
    /// <summary>Instead of a frame: GET this path and show what comes back.</summary>
    string? GetPath = null,
    /// <summary>Instead of a frame: a native view of the item ("graph" = the workflow diagram).</summary>
    string? View = null);

/// <summary>
/// One list of things on a management page — the agents, the skills, the triggers… — and how to read
/// and change it over the socket. One definition per list; the screens are the same for all of them.
/// </summary>
public sealed record EntityDef(
    string Key,
    string Label,
    string Lead,
    /// <summary>The frame that asks for the list (null: the list comes with another one's reply).</summary>
    string? Load,
    /// <summary>The frame type the list arrives in.</summary>
    string Reply,
    Func<JsonElement, IEnumerable<JsonElement>> Items,
    Func<JsonElement, string> Id,
    Func<JsonElement, string> Title,
    Func<JsonElement, string>? Subtitle = null,
    /// <summary>A new item to fill in; null when this list has no "add".</summary>
    Func<JsonObject>? New = null,
    /// <summary>The frame that stores an item: (edited item, id it had before or null when new).</summary>
    Func<JsonObject, string?, string>? Save = null,
    Func<JsonElement, string>? Delete = null,
    IReadOnlyList<FieldSpec>? Fields = null,
    IReadOnlyList<EntityAction>? Actions = null,
    /// <summary>Frame types (besides <see cref="Reply"/>) whose error is about this list.</summary>
    IReadOnlyList<string>? Requests = null,
    /// <summary>A single object (settings, profile): no list, the one item opens as a form.</summary>
    bool Single = false,
    /// <summary>Other frame types that mean "ask for the list again".</summary>
    IReadOnlyList<string>? ReloadOn = null);

public sealed record EntityRow(string Id, string Title, string Subtitle, JsonElement Item);

/// <summary>A list of one <see cref="EntityDef"/>, kept current from the socket.</summary>
public sealed partial class EntityList : ObservableObject
{
    private readonly MimiSession session;

    public EntityList(MimiSession session, EntityDef def)
    {
        this.session = session;
        Def = def;
        session.Raw += OnRaw;
        // A list of fixed items (no question, no reply): shown at once.
        if (def.Load is null && def.Reply.Length == 0) Show(default);
    }

    public EntityDef Def { get; }
    public ObservableCollection<EntityRow> Rows { get; } = [];
    /// <summary>The whole last reply (pages read more than the list from it).</summary>
    public JsonElement Last { get; private set; }

    [ObservableProperty]
    private string error = "";

    [ObservableProperty]
    private string note = "";

    [ObservableProperty]
    private bool loaded;

    public bool Empty => Loaded && Rows.Count == 0;

    public void Refresh()
    {
        if (Def.Load is not null) session.Send(Def.Load);
    }

    private void OnRaw(string type, JsonElement json)
    {
        if (type == Def.Reply)
        {
            Show(json);
            if (json.TryGetProperty("saved", out var saved) && saved.ValueKind is JsonValueKind.True or JsonValueKind.String) Note = "บันทึกแล้ว";
        }
        else if (Def.ReloadOn?.Contains(type) == true)
        {
            Refresh();
        }
        else if (type == "error" && json.TryGetProperty("requestType", out var about) && about.GetString() is { } request && (Def.Requests?.Contains(request) == true))
        {
            Error = json.TryGetProperty("message", out var message) ? message.GetString() ?? "" : "ผิดพลาด";
        }
    }

    public void Show(JsonElement reply)
    {
        Last = reply;
        var rows = new List<EntityRow>();
        try
        {
            foreach (var item in Def.Items(reply)) rows.Add(new EntityRow(Def.Id(item), Def.Title(item), Def.Subtitle?.Invoke(item) ?? "", item));
        }
        catch (Exception problem) when (problem is InvalidOperationException or KeyNotFoundException or FormatException)
        {
            Error = $"อ่านข้อมูลไม่ได้: {problem.Message}";
        }
        Rows.Clear();
        foreach (var row in rows) Rows.Add(row);
        Loaded = true;
        Error = "";
        OnPropertyChanged(nameof(Empty));
        Version++;
    }

    /// <summary>Goes up once per list that arrived: the screen redraws the rows on this, not on every row.</summary>
    [ObservableProperty]
    private int version;

    /// <summary>Stores an item: new (<paramref name="before"/> null) or edited.</summary>
    public void Save(JsonObject item, string? before)
    {
        if (Def.Save is null) return;
        Error = "";
        Note = "";
        session.Send(Def.Save(item, before));
    }

    public void Delete(EntityRow row)
    {
        if (Def.Delete is null) return;
        Error = "";
        Note = "";
        session.Send(Def.Delete(row.Item));
    }

    public void Detach() => session.Raw -= OnRaw;
}

/// <summary>Reading JSON for the definitions without ceremony.</summary>
public static class J
{
    public static JsonElement At(this JsonElement json, string path)
    {
        var current = json;
        foreach (var part in path.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(part, out current)) return default;
        }
        return current;
    }

    public static string S(this JsonElement json, string path, string fallback = "")
    {
        var value = json.At(path);
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? fallback,
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => fallback,
        };
    }

    public static bool B(this JsonElement json, string path) => json.At(path).ValueKind == JsonValueKind.True;

    public static IEnumerable<JsonElement> A(this JsonElement json, string path) =>
        json.At(path) is { ValueKind: JsonValueKind.Array } array ? array.EnumerateArray() : [];

    public static IEnumerable<string> Strings(this JsonElement json, string path) =>
        json.A(path).Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!);

    public static JsonObject Obj(this JsonElement json) => json.ValueKind == JsonValueKind.Object ? (JsonObject)JsonNode.Parse(json.GetRawText())! : [];

    public static JsonObject O(params (string Key, JsonNode? Value)[] pairs)
    {
        var json = new JsonObject();
        foreach (var (key, value) in pairs) json[key] = value;
        return json;
    }

    public static string Str(this JsonObject json, string key) => json[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";

    /// <summary>A copy of the object without these keys (read-only fields the save frame must not carry).</summary>
    public static JsonObject Without(this JsonObject json, params string[] keys)
    {
        var copy = (JsonObject)json.DeepClone();
        foreach (var key in keys) copy.Remove(key);
        return copy;
    }

    public static string Join(IEnumerable<string> parts, string separator = ", ") => string.Join(separator, parts.Where(part => part.Length > 0));
}
