using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Net;

namespace Mimi.Core.Desktop;

public sealed class PcAgentConfig
{
    /// <summary>The PC agent starts with the app (on by default since 0.8.1).</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>Marks the "on by default" switch as applied, so a later "off" sticks (remote-lib.cjs readConfig).</summary>
    public int AutoOn { get; set; } = 1;
    /// <summary>Commands, power and MCP with the full rights of the Windows account; off unless chosen.</summary>
    public bool Shell { get; set; }
    public List<string> Folders { get; set; } = [];
    public List<string> Apps { get; set; } = [];
}

public sealed class WindowConfig
{
    public WindowBounds? Bounds { get; set; }
    public bool Maximized { get; set; }
    public bool HideOnBlur { get; set; }
    public bool OnTop { get; set; }
}

public sealed record WindowBounds(int X, int Y, int Width, int Height);

/// <summary>How the situation picture of an agent is shown: <see cref="Id"/> is the gallery picture it was set for.</summary>
public sealed class SceneMode
{
    public string Id { get; set; } = "";
    public string Mode { get; set; } = "open";
}

/// <summary>
/// How one chat looks on this computer (the web's "Chat setting → หน้าตา", <c>mimi.chat.&lt;id&gt;.*</c>): null = as the app.
/// </summary>
public sealed class ChatLook
{
    /// <summary>"light", "dark" or null (the app's theme).</summary>
    public string? Theme { get; set; }
    /// <summary>0 small, 1 normal, 2 large.</summary>
    public int? TextSize { get; set; }
    /// <summary>The character on the stage of a direct chat.</summary>
    public bool? Character { get; set; }
    /// <summary>How much chat shows over the character: 0 none, 1 the two newest, 2 all.</summary>
    public int? Bubbles { get; set; }
    /// <summary>The chat's own background: {type: none|solid|gradient|preset|upload, color, from, to, angle, preset, upload}.</summary>
    public JsonObject? Background { get; set; }
    /// <summary>Time spans that change the background (BackgroundRules); null when there are none.</summary>
    public JsonArray? BackgroundRules { get; set; }
    /// <summary>Where the character stands: size and slide (percent of the stage).</summary>
    public double Zoom { get; set; } = 1;
    public double X { get; set; }
    public double Y { get; set; }

    public bool IsEmpty => Theme is null && TextSize is null && Character is null && Bubbles is null && Background is null && BackgroundRules is not { Count: > 0 } && Zoom == 1 && X == 0 && Y == 0;
}

/// <summary>
/// What the app keeps in <c>%APPDATA%\Mimi\config.json</c>: server address, window place, auto-lock and
/// PC agent choices — no personal data. The same file and fields as the Electron app (remote-lib.cjs),
/// so moving from it to this app keeps the choices. Fields this app does not know are kept as they were.
/// </summary>
public sealed class AppConfig
{
    public static readonly int[] LockChoices = [0, 5, 15, 30, 60];

    public string Server { get; set; } = "";
    public int AutoLockMinutes { get; set; }
    public PcAgentConfig PcAgent { get; set; } = new();
    public WindowConfig Window { get; set; } = new();
    /// <summary>Seen notification id: the next start shows only newer ones (push-and-background.md 1.2).</summary>
    public long LastNotificationId { get; set; }
    /// <summary>"dark" or "light"; the account's choice (ui-set mimi.theme) wins once it is known.</summary>
    public string Theme { get; set; } = "dark";
    /// <summary>Text size of chats without their own: 0 small, 1 normal, 2 large.</summary>
    public int TextSize { get; set; } = 1;
    /// <summary>The character on the stage of direct chats, unless a chat says otherwise.</summary>
    public bool Character { get; set; } = true;
    /// <summary>Show tool calls, helper lines and prompt details in the chat (the web's mimi.showPrompt).</summary>
    public bool ShowPrompt { get; set; }
    /// <summary>Per chat id: its own look.</summary>
    public Dictionary<string, ChatLook> Looks { get; set; } = [];
    /// <summary>
    /// Per agent: the situation picture the person last dealt with and how ("open", "min", "closed"), so a
    /// minimised one stays minimised until the agent shows another (feature-gallery.js, localStorage mimi.cg).
    /// </summary>
    public Dictionary<string, SceneMode> Scenes { get; set; } = [];
    /// <summary>The app runs the core on this computer itself and starts it with the app (LocalCore).</summary>
    public bool LocalServer { get; set; }
    /// <summary>The Workspace window's folder.</summary>
    public string WorkspaceRoot { get; set; } = "";

    /// <summary>The look of a chat, created on first change.</summary>
    public ChatLook Look(long chatId, bool create = false)
    {
        var key = chatId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (Looks.TryGetValue(key, out var look)) return look;
        look = new ChatLook();
        if (create) Looks[key] = look;
        return look;
    }

    public void ForgetLook(long chatId) => Looks.Remove(chatId.ToString(System.Globalization.CultureInfo.InvariantCulture));

    private JsonObject extra = [];

    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true, PropertyNameCaseInsensitive = true, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public static AppConfig Defaults(string home) => new() { PcAgent = new PcAgentConfig { Folders = [Path.Combine(home, "Mimi-Workspace")] } };

    public static AppConfig Read(string file, string home)
    {
        var config = Defaults(home);
        JsonObject saved;
        try
        {
            saved = JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? [];
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            return config;
        }
        config.extra = saved;
        try
        {
            config.Server = saved["server"]?.GetValue<string>() is { Length: > 0 } server ? ServerAddress.Normalize(server) : "";
        }
        catch (Exception error) when (error is FormatException or InvalidOperationException)
        {
            config.Server = "";
        }
        var minutes = Int(saved["autoLockMinutes"]);
        config.AutoLockMinutes = LockChoices.Contains(minutes) ? minutes : 0;
        if (saved["pcAgent"] is JsonObject pc)
        {
            // A config from before the default flipped (no autoOn) is switched on once; after that the saved choice rules.
            config.PcAgent.Enabled = Int(pc["autoOn"]) != 1 || Bool(pc["enabled"]);
            config.PcAgent.Shell = Bool(pc["shell"]);
            var folders = Strings(pc["folders"]).Where(dir => FolderProblem(dir, home) is null).ToList();
            if (folders.Count > 0) config.PcAgent.Folders = folders;
            config.PcAgent.Apps = Strings(pc["apps"]).Select(name => name.Trim()).Where(name => name.Length > 0).ToList();
        }
        if (saved["window"] is JsonObject window)
        {
            config.Window.Maximized = Bool(window["maximized"]);
            config.Window.HideOnBlur = Bool(window["hideOnBlur"]);
            config.Window.OnTop = Bool(window["onTop"]);
            if (window["bounds"] is JsonObject bounds)
            {
                config.Window.Bounds = new WindowBounds(Int(bounds["x"]), Int(bounds["y"]), Int(bounds["width"]), Int(bounds["height"]));
                if (config.Window.Bounds.Width < 200 || config.Window.Bounds.Height < 200) config.Window.Bounds = null;
            }
        }
        if (saved["windows"] is JsonObject mine)
        {
            config.LastNotificationId = Math.Max(0, Long(mine["lastNotificationId"]));
            config.Theme = mine["theme"]?.GetValue<string>() == "light" ? "light" : "dark";
            config.TextSize = mine["textSize"] is null ? 1 : Math.Clamp(Int(mine["textSize"]), 0, 2);
            config.Character = mine["character"] is null || Bool(mine["character"]);
            config.WorkspaceRoot = mine["workspaceRoot"]?.GetValue<string>() ?? "";
            if (mine["looks"] is JsonObject looks)
            {
                foreach (var (id, look) in looks)
                {
                    try
                    {
                        if (look?.Deserialize<ChatLook>(Options) is { } read) config.Looks[id] = read;
                    }
                    catch (Exception error) when (error is JsonException or InvalidOperationException)
                    {
                        // a look this version cannot read is dropped
                    }
                }
            }
        }
        return config;
    }

    public void Write(string file)
    {
        var json = extra.DeepClone().AsObject();
        json["server"] = Server;
        json["autoLockMinutes"] = AutoLockMinutes;
        json["pcAgent"] = JsonSerializer.SerializeToNode(PcAgent, Options);
        json["window"] = JsonSerializer.SerializeToNode(Window, Options);
        // This app's own choices live under "windows", which the Electron app leaves alone.
        json["windows"] = new JsonObject
        {
            ["lastNotificationId"] = LastNotificationId,
            ["theme"] = Theme,
            ["textSize"] = TextSize,
            ["character"] = Character,
            ["workspaceRoot"] = WorkspaceRoot,
            ["looks"] = JsonSerializer.SerializeToNode(Looks.Where(entry => !entry.Value.IsEmpty).ToDictionary(), Options),
        };
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, json.ToJsonString(Options));
        File.Move(tmp, file, overwrite: true);
    }

    /// <summary>The PC agent may only use folders inside the Windows account's home (and never the home itself).</summary>
    public static string? FolderProblem(string dir, string home)
    {
        if (string.IsNullOrWhiteSpace(dir) || !Path.IsPathFullyQualified(dir)) return "ต้องเป็นโฟลเดอร์แบบเต็ม (absolute path)";
        var real = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir));
        var homeReal = Path.TrimEndingDirectorySeparator(Path.GetFullPath(home));
        if (string.Equals(real, homeReal, StringComparison.OrdinalIgnoreCase)) return "เลือกโฟลเดอร์ย่อยในโฮม ไม่ใช่โฮมทั้งหมด";
        if (!real.StartsWith(homeReal + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return "ต้องอยู่ในโฮมของผู้ใช้เครื่องนี้";
        var first = real[(homeReal.Length + 1)..].Split(Path.DirectorySeparatorChar)[0];
        // App data and SSH keys of the Windows account stay out of reach.
        string[] system = ["Library", ".ssh", ".gnupg", "AppData", ".mimi"];
        if (system.Contains(first, StringComparer.OrdinalIgnoreCase)) return $"\"{first}\" เป็นโฟลเดอร์ของระบบ ใช้ไม่ได้";
        return null;
    }

    private static int Int(JsonNode? node) => node is JsonValue value && value.TryGetValue<double>(out var number) ? (int)number : 0;
    private static long Long(JsonNode? node) => node is JsonValue value && value.TryGetValue<double>(out var number) ? (long)number : 0;
    private static bool Bool(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    private static IEnumerable<string> Strings(JsonNode? node) =>
        node is JsonArray array ? array.OfType<JsonValue>().Select(value => value.TryGetValue<string>(out var text) ? text : null).OfType<string>() : [];
}
