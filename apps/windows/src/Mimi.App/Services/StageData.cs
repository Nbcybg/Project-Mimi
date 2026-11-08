using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Net;

namespace Mimi.App.Services;

/// <summary>What the stage shows behind the chat: a solid colour, a gradient, or a picture (a file of the app or a path on the server).</summary>
internal sealed record BackdropTarget(string Key, string? Color = null, string? From = null, string? To = null, double Angle = 135, string? File = null, string? Path = null);

/// <summary>A picture for the figure, and the outfit it belongs to (a new outfit slides in).</summary>
internal sealed record FigureTarget(string Path, string Outfit);

/// <summary>
/// What the chat stage needs to know, read from the frames as they pass: the agents as the server sends
/// them (pictures, emoji sprites, VRM, status), the wardrobe and the scenes (feature-stage.js, feature-backgrounds.js).
/// </summary>
internal sealed class StageData
{
    private readonly MimiSession session;
    private readonly Dictionary<string, JsonElement> agents = [];
    private List<JsonElement> outfits = [];
    private List<JsonElement> scenes = [];
    private JsonElement sceneSettings;

    public StageData(MimiSession session)
    {
        this.session = session;
        session.Raw += OnRaw;
        session.StateChanged += state =>
        {
            if (state is not SocketState.Online) return;
            session.Send(Core.Protocol.ClientFrames.Simple("wardrobe-list"));
            session.Send(Core.Protocol.ClientFrames.Simple("backgrounds-list"));
        };
    }

    public event Action? Changed;

    /// <summary>The preset scenes of the web app (backgrounds/*.webp), shipped beside Mimi.exe.</summary>
    public static readonly IReadOnlyList<(string Id, string Label)> Presets =
    [
        ("floral", "ลายดอกไม้"), ("mint", "มินต์"), ("blush", "ชมพู"), ("sky", "ฟ้า"), ("grid", "ตาราง"), ("starlight", "แสงดาว"),
        ("dawn", "รุ่งอรุณ"), ("ember", "เมฆแดงเข้ม"), ("crimson", "เมฆชาด"), ("waves", "คลื่นทะเล"), ("confetti", "คอนเฟตติ"),
    ];

    public static string PresetFile(string id) => System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "backgrounds", $"{id}.webp");

    public IReadOnlyList<JsonElement> Scenes => scenes;

    private void OnRaw(string type, JsonElement json)
    {
        switch (type)
        {
            case "agents":
                agents.Clear();
                foreach (var agent in json.A("agents")) agents[agent.S("name")] = agent.Clone();
                break;
            case "status":
                // One agent's status changed (the core broadcasts it right after every status_set):
                // fold it into the cached agent so the chat and the open panel follow at once.
                {
                    var name = json.S("agent");
                    if (name.Length == 0 || !agents.TryGetValue(name, out var known)) return;
                    var merged = (JsonObject)JsonNode.Parse(known.GetRawText())!;
                    merged["status"] = JsonNode.Parse(json.At("status").GetRawText());
                    agents[name] = JsonSerializer.SerializeToElement(merged);
                    break;
                }
            case "wardrobe":
                outfits = json.A("outfits").Select(item => item.Clone()).ToList();
                break;
            case "backgrounds":
                scenes = json.A("items").Select(item => item.Clone()).ToList();
                sceneSettings = json.At("settings").Clone();
                break;
            default:
                return;
        }
        Changed?.Invoke();
    }

    public JsonElement? Agent(string name) => agents.TryGetValue(name, out var agent) ? agent : null;

    private JsonElement? Outfit(JsonElement agent)
    {
        var id = agent.S("status.outfit");
        return id.Length == 0 ? null : outfits.FirstOrDefault(item => item.S("id") == id) is { ValueKind: JsonValueKind.Object } found ? found : null;
    }

    private static string E(string value) => Uri.EscapeDataString(value);

    /// <summary>The VRM to show: the model of the outfit worn, else the agent's own; null without one or when the agent is 2D.</summary>
    public string? ModelPath(string name)
    {
        if (Agent(name) is not { } agent || agent.S("character") != "vrm") return null;
        if (Outfit(agent) is { } outfit && outfit.S("model").Length > 0) return $"/api/wardrobe-model/{E(outfit.S("id"))}?v={outfit.S("model")}";
        return agent.S("model").Length > 0 ? $"/api/agent-model/{E(name)}?v={agent.S("model")}" : null;
    }

    /// <summary>The agent's Mixamo motions (name, file path with its version) for the 3D character.</summary>
    public IReadOnlyList<(string Name, string Path)> Motions(string name) =>
        Agent(name) is { } agent
            ? agent.A("motions").Where(motion => motion.S("name").Length > 0).Select(motion => (motion.S("name"), $"/api/agent-motion/{E(name)}/{E(motion.S("name"))}?v={motion.S("version")}")).ToList()
            : [];

    /// <summary>The motion the agent plays while it stands (agent.md idleMotion), when it has that motion.</summary>
    public string? IdleMotion(string name) =>
        Agent(name) is { } agent && agent.S("idleMotion") is { Length: > 0 } idle && agent.A("motions").Any(motion => motion.S("name") == idle) ? idle : null;

    /// <summary>Every picture the agent could show for this emoji, best first (feature-stage.js candidates).</summary>
    public IReadOnlyList<FigureTarget> Candidates(string name, string? mood)
    {
        var list = new List<FigureTarget>();
        if (Agent(name) is not { } agent) return list;
        var outfit = Outfit(agent);
        var worn = outfit?.S("id") ?? "";
        var own = agent.At("sprites");
        string? Sprite(JsonElement owner, string key) => owner.ValueKind == JsonValueKind.Object && owner.TryGetProperty(key, out var stamp) ? stamp.ToString() : null;
        if (outfit is { } wearing && mood is not null && Sprite(wearing.At("sprites"), mood) is { } outfitStamp)
            list.Add(new($"/api/sprite/outfit/{E(worn)}/{mood}?v={outfitStamp}", worn));
        if (mood is not null && Sprite(own, mood) is { } ownStamp) list.Add(new($"/api/sprite/agent/{E(name)}/{mood}?v={ownStamp}", worn));
        if (outfit is { } dressed && dressed.S("image").Length > 0) list.Add(new($"/api/wardrobe-image/{E(worn)}?v={dressed.S("image")}", worn));
        if (agent.S("portrait").Length > 0) list.Add(new($"/api/agent-image/{E(name)}/portrait?v={agent.S("portrait")}", worn));
        if (outfit is { } any && any.At("sprites").ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in any.At("sprites").EnumerateObject()) list.Add(new($"/api/sprite/outfit/{E(worn)}/{entry.Name}?v={entry.Value}", worn));
        }
        if (own.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in own.EnumerateObject()) list.Add(new($"/api/sprite/agent/{E(name)}/{entry.Name}?v={entry.Value}", worn));
        }
        if (agent.S("avatar").Length > 0) list.Add(new($"/api/agent-image/{E(name)}/avatar?v={agent.S("avatar")}", worn));
        return list;
    }

    /// <summary>
    /// The backdrop: the chat's own choice, else the Hub scene of its agent ("auto" = by the agent's location),
    /// else none (feature-backgrounds.js apply).
    /// </summary>
    public BackdropTarget? Backdrop(ChatLook look, string? agentName)
    {
        // The chat's own choice, as its time rules have it now; "none" there means no backdrop at all.
        var now = DateTime.Now;
        if (BackgroundRules.For(look.Background, look.BackgroundRules, now.Hour * 60 + now.Minute,
            id => scenes.Any(item => item.S("id") == id && item.S("image").Length > 0)) is { } own)
        {
            return own.Str("type") switch
            {
                "solid" => new($"solid:{own.Str("color")}", Color: own.Str("color")),
                "gradient" => new($"gradient:{own.Str("from")}:{own.Str("to")}", From: own.Str("from"), To: own.Str("to"),
                    Angle: own["angle"] is System.Text.Json.Nodes.JsonValue angle && angle.TryGetValue<double>(out var degrees) ? degrees : 135),
                "preset" => File.Exists(PresetFile(own.Str("preset"))) ? new($"preset:{own.Str("preset")}", File: PresetFile(own.Str("preset"))) : null,
                "upload" => scenes.FirstOrDefault(item => item.S("id") == own.Str("upload") && item.S("image").Length > 0) is { ValueKind: JsonValueKind.Object } item
                    ? new($"upload:{item.S("id")}:{item.S("image")}", Path: $"/api/background-image/{E(item.S("id"))}?v={item.S("image")}")
                    : null,
                _ => null,
            };
        }
        if (agentName is null) return null;
        var choice = sceneSettings.ValueKind == JsonValueKind.Object ? sceneSettings.S($"agents.{agentName}") : "";
        if (choice.Length == 0 && sceneSettings.ValueKind == JsonValueKind.Object) choice = sceneSettings.S("default");
        if (choice == "auto")
        {
            var location = (Agent(agentName)?.S("status.location") ?? "").ToLowerInvariant();
            var hit = location.Length == 0 ? null : scenes.Cast<JsonElement?>().FirstOrDefault(item => item!.Value.Strings("keywords").Any(word => word.Length > 0 && location.Contains(word.ToLowerInvariant())));
            if (hit is { } found) return Scene(found);
            choice = sceneSettings.S("default") is { Length: > 0 } fallback && fallback != "auto" ? fallback : "";
        }
        if (choice.Length == 0 || choice == "none") return null;
        return scenes.FirstOrDefault(item => item.S("id") == choice && item.S("image").Length > 0) is { ValueKind: JsonValueKind.Object } scene ? Scene(scene) : null;
    }

    private static BackdropTarget Scene(JsonElement scene) =>
        new($"scene:{scene.S("id")}:{scene.S("image")}", Path: $"/api/background-image/{E(scene.S("id"))}?v={scene.S("image")}");

    // ---------- the mood: the last emoji of the newest reply ----------

    /// <summary>The key the core files an emoji picture under (code points in hex without the emoji selector), of the last emoji in the text.</summary>
    public static string? LastEmojiKey(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        string? last = null;
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            var grapheme = (string)elements.Current;
            if (IsPictograph(grapheme)) last = grapheme;
        }
        if (last is null) return null;
        var hex = new List<string>();
        foreach (var rune in last.EnumerateRunes())
        {
            if (rune.Value == 0xFE0F) continue;
            hex.Add(rune.Value.ToString("x", CultureInfo.InvariantCulture));
        }
        return string.Join("-", hex);
    }

    private static bool IsPictograph(string grapheme)
    {
        var first = grapheme.EnumerateRunes().FirstOrDefault();
        var value = first.Value;
        if (value is >= 0x1F000 and <= 0x1FAFF) return true; // emoji, flags (regional indicators), symbols
        if (value is >= 0x2600 and <= 0x27BF) return true; // misc symbols, dingbats (❤ ✨ ☀)
        if (value is >= 0x2B00 and <= 0x2BFF) return true; // ⭐ ⬆
        if (value is 0x203C or 0x2049 or 0x2122 or 0x2139 or >= 0x2194 and <= 0x21AA or 0x231A or 0x231B or 0x2328 or 0x23CF or >= 0x23E9 and <= 0x23FA) return true;
        // a keycap: 1️⃣
        return grapheme.Contains('⃣');
    }

    public static string EmojiOf(string key) =>
        string.Concat(key.Split('-').Select(hex => char.ConvertFromUtf32(int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture))));

    public static string Describe(BackdropTarget? target) => target is null ? "ไม่มี" : new StringBuilder(target.Key.Split(':')[0]).ToString();
}
