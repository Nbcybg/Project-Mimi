using System.Text.Json;
using Mimi.Core.Net;

namespace Mimi.Core.Hub;

/// <summary>
/// The choice lists the forms offer (<see cref="FieldSpec.OptionsFrom"/>): models and presets, agents,
/// tools, skills, connectors, the provider catalog — read from the frames as they pass.
/// </summary>
public sealed class Lookups
{
    private readonly MimiSession session;
    private readonly Dictionary<string, IReadOnlyList<(string Value, string Label)>> lists = [];
    private readonly Dictionary<string, IReadOnlyList<JsonElement>> items = [];

    public Lookups(MimiSession session)
    {
        this.session = session;
        session.Raw += OnRaw;
        session.StateChanged += state =>
        {
            if (state is not SocketState.Online) return;
            // agents-list and chats-list go by themselves (MimiSession); the rest is asked once per connection.
            Refresh();
        };
    }

    /// <summary>Asks the lists again (a form opened after a settings change should not offer stale names).</summary>
    public void Refresh()
    {
        foreach (var type in new[] { "settings-get", "skills-list", "tools-list", "connector-connections", "workflows-list", "profile-get" })
            session.Send(Protocol.ClientFrames.Simple(type));
    }

    /// <summary>The user's profile (profile-get): the fields the agents may see.</summary>
    public JsonElement Profile { get; private set; }

    public event Action? Changed;

    public IReadOnlyList<(string Value, string Label)> Get(string name)
    {
        if (name == "accounts" || name.StartsWith("accounts:", StringComparison.Ordinal)) return Accounts(name.Length > 9 ? name[9..] : null);
        if (name.StartsWith("connections:", StringComparison.Ordinal))
        {
            var connector = name[12..];
            return [("", "— connection เริ่มต้น —"), .. Items("connections").Where(entry => connector.Length == 0 || entry.S("connector") == connector)
                .Select(entry => (entry.S("id"), $"{entry.S("name")}{(entry.B("default") ? " ★" : "")}{(entry.B("connected") ? "" : " (ยังไม่เชื่อมต่อ)")}"))];
        }
        return lists.TryGetValue(name, out var list) ? list : [];
    }

    /// <summary>The whole entries of a list (tools with their settings, connectors with their auth fields, connections).</summary>
    public IReadOnlyList<JsonElement> Items(string name) => items.TryGetValue(name, out var list) ? list : [];

    private void Keep(string name, JsonElement json, string path)
    {
        if (json.At(path).ValueKind == JsonValueKind.Array) items[name] = json.A(path).Select(item => item.Clone()).ToList();
    }

    /// <summary>The settings view as last sent (pages read the time zone, the ready flag…).</summary>
    public JsonElement Settings { get; private set; }

    /// <summary>The accounts an <c>account</c> field offers (feature-tools.js accountOptions): OAuth accounts and mailboxes, of one service or all.</summary>
    public IReadOnlyList<(string Value, string Label)> Accounts(string? service)
    {
        if (Settings.ValueKind != JsonValueKind.Object) return [];
        var mail = Settings.A("mailAccounts").Select(account => (Account: account, Service: "mail"));
        return Settings.A("accounts").Select(account => (Account: account, Service: account.S("service")))
            .Concat(mail)
            .Where(entry => service is null || entry.Service == service)
            .Select(entry => (entry.Account.S("id"), $"{(entry.Account.S("name") is { Length: > 0 } name ? name : entry.Account.S("id"))}{(entry.Account.B("default") ? " ★" : "")}{(entry.Account.At("connected").ValueKind == JsonValueKind.False ? " (ยังไม่เชื่อมต่อ)" : "")}"))
            .ToList();
    }

    private void Set(string name, IEnumerable<(string, string)> entries) => lists[name] = entries.ToList();

    private void Connectors(JsonElement json)
    {
        Set("connectors", json.A("connectors").Select(connector => (connector.S("key"), connector.S("label") is { Length: > 0 } label ? $"{label} ({connector.S("key")})" : connector.S("key"))));
        Keep("connectors", json, "connectors");
    }

    private void OnRaw(string type, JsonElement json)
    {
        switch (type)
        {
            case "settings":
                Settings = json.At("settings");
                var models = json.A("settings.models").Select(model => (model.S("ref"), model.S("label") is { Length: > 0 } label ? $"{label} ({model.S("ref")})" : model.S("ref"))).ToList();
                var presets = json.A("settings.presets").Select(preset => (preset.S("name"), $"🎛 {preset.S("name")} → {preset.S("model")}")).ToList();
                Set("presets", presets);
                Set("models-only", models);
                Set("models", presets.Concat(models));
                Set("catalog", json.A("settings.catalog").Select(entry => (entry.S("id"), $"{entry.S("name")} ({entry.S("id")})")));
                break;
            case "profile":
                Profile = json.At("profile").Clone();
                break;
            case "workflows":
                Keep("workflows", json, "workflows");
                break;
            case "agents":
                Set("agents", json.A("agents").Select(agent => (agent.S("name"), agent.S("displayName") is { Length: > 0 } shown ? $"{shown} ({agent.S("name")})" : agent.S("name"))));
                if (json.A("tools").Any()) Set("tools", json.A("tools").Select(tool => (tool.S("name"), $"{tool.S("name")} — {tool.S("risk")}")));
                break;
            case "skills":
                Set("skills", json.A("skills").Select(skill => (skill.S("name"), skill.S("name"))));
                break;
            case "tools":
                Set("tools", json.A("tools").Select(tool => (tool.S("name"), $"{tool.S("name")} — {tool.S("risk")}")));
                Keep("tools", json, "tools");
                if (json.At("connectors").ValueKind == JsonValueKind.Array) Connectors(json);
                Keep("connections", json, "connections");
                break;
            case "connector-connections":
                if (json.At("connectors").ValueKind == JsonValueKind.Array) Connectors(json);
                Keep("connections", json, "connections");
                break;
            default:
                return;
        }
        Changed?.Invoke();
    }
}
