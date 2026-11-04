using System.Text.Json.Nodes;

namespace Mimi.Core.Desktop;

/// <summary>
/// A chat's background by the time of day (feature-backgrounds.js chatBackground): each rule is
/// {id, from "HH:mm", to "HH:mm", type default|solid|gradient|preset|upload, preset?, upload?}; the first
/// rule whose span holds the time wins. A span that runs past midnight (18:00–06:00) works, and from = to is
/// the whole day.
/// </summary>
public static class BackgroundRules
{
    public static readonly string[] Types = ["default", "solid", "gradient", "preset", "upload"];

    /// <summary>"H:mm" or "HH:mm" as "HH:mm", or "" when it is not a time of day.</summary>
    public static string Clock(string? value)
    {
        var parts = (value ?? "").Trim().Split(':');
        if (parts.Length != 2 || parts[0].Length is < 1 or > 2 || parts[1].Length != 2) return "";
        if (!int.TryParse(parts[0], out var hour) || !int.TryParse(parts[1], out var minute) || hour is < 0 or > 23 || minute is < 0 or > 59) return "";
        return $"{hour:00}:{minute:00}";
    }

    public static int? Minutes(string? value) => Clock(value) is { Length: 5 } clock ? int.Parse(clock[..2]) * 60 + int.Parse(clock[3..]) : null;

    public static bool Active(JsonObject rule, int now)
    {
        if (Minutes(Str(rule, "from")) is not { } from || Minutes(Str(rule, "to")) is not { } to) return false;
        if (from == to) return true;
        return from < to ? now >= from && now < to : now >= from || now < to;
    }

    /// <summary>A new rule as the web adds it: 18:00–06:00, the chat's own background.</summary>
    public static JsonObject New() => new() { ["id"] = $"rule-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}", ["from"] = "18:00", ["to"] = "06:00", ["type"] = "default" };

    /// <summary>
    /// The background for this moment: the chat's own one, changed by the rule that holds <paramref name="now"/>
    /// (minutes since midnight). Null when the chat has none (it follows the app's scene, and rules do not apply).
    /// </summary>
    public static JsonObject? For(JsonObject? background, JsonArray? rules, int now, Func<string, bool> uploadExists)
    {
        if (background is null) return null;
        var rule = rules?.OfType<JsonObject>().FirstOrDefault(entry => Active(entry, now));
        switch (rule is null ? "default" : Str(rule, "type"))
        {
            case "solid" or "gradient":
                var kind = (JsonObject)background.DeepClone();
                kind["type"] = Str(rule!, "type");
                return kind;
            case "preset":
                return new JsonObject { ["type"] = "preset", ["preset"] = Str(rule!, "preset") };
            case "upload" when uploadExists(Str(rule!, "upload")):
                return new JsonObject { ["type"] = "upload", ["upload"] = Str(rule!, "upload") };
            default:
                return background;
        }
    }

    private static string Str(JsonObject json, string key) => json[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
}
