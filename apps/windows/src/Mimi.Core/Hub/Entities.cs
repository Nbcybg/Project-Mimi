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
    Func<System.Text.Json.Nodes.JsonObject, bool>? ShowWhen = null);

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
