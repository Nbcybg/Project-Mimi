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

    public Lookups(MimiSession session)
    {
        this.session = session;
        session.Raw += OnRaw;
        session.StateChanged += state =>
        {
            if (state is not SocketState.Online) return;
            // agents-list and chats-list go by themselves (MimiSession); the rest is asked once per connection.
            foreach (var type in new[] { "settings-get", "skills-list", "tools-list" }) session.Send(Protocol.ClientFrames.Simple(type));
        };
    }

    public event Action? Changed;

    public IReadOnlyList<(string Value, string Label)> Get(string name) => lists.TryGetValue(name, out var list) ? list : [];

    /// <summary>The settings view as last sent (pages read the time zone, the ready flag…).</summary>
    public JsonElement Settings { get; private set; }

    private void Set(string name, IEnumerable<(string, string)> items) => lists[name] = items.ToList();

    private void OnRaw(string type, JsonElement json)
    {
        switch (type)
        {
            case "settings":
                Settings = json.At("settings");
                var models = json.A("settings.models").Select(model => (model.S("ref"), model.S("label") is { Length: > 0 } label ? $"{label} ({model.S("ref")})" : model.S("ref"))).ToList();
                var presets = json.A("settings.presets").Select(preset => (preset.S("name"), $"🎛 {preset.S("name")} → {preset.S("model")}")).ToList();
                Set("models-only", models);
                Set("models", presets.Concat(models));
                Set("catalog", json.A("settings.catalog").Select(entry => (entry.S("id"), $"{entry.S("name")} ({entry.S("id")})")));
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
                Set("connectors", json.A("connectors").Select(connector => (connector.S("key"), connector.S("label") is { Length: > 0 } label ? $"{label} ({connector.S("key")})" : connector.S("key"))));
                break;
            default:
                return;
        }
        Changed?.Invoke();
    }
}
