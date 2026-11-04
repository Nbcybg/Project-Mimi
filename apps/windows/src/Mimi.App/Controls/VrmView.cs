using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Mimi.Core.Net;

namespace Mimi.App.Controls;

/// <summary>
/// The 3D character (VRM) on the chat stage: three.js + three-vrm in a WebView2 (Assets/web/vrm.html), since
/// WinUI has no glTF/VRM renderer. The model is fetched with the token by the app and handed to the page from
/// a local folder, so the page never sees the token or talks to the server. The agent's Mixamo motions (.fbx)
/// come the same way: the idle motion plays while the character stands, others when asked (<see cref="Play"/>).
/// </summary>
internal sealed partial class VrmView : Grid
{
    private const string AppHost = "app.mimi";
    private const string ModelHost = "model.mimi";
    private readonly WebView2 web = new() { DefaultBackgroundColor = Microsoft.UI.Colors.Transparent, IsHitTestVisible = false };
    private readonly Func<MimiApi> api;
    private readonly string folder;
    private Task? starting;
    private bool pageReady;
    private string wanted = "";
    private string? mood;
    private JsonObject? view;
    private JsonObject? motions;
    private string motionsKey = "";

    public VrmView(Func<MimiApi> api, string folder)
    {
        this.api = api;
        this.folder = folder;
        Children.Add(web);
    }

    /// <summary>"loading", "ready" or "failed" for the model asked for last.</summary>
    public string State { get; private set; } = "none";

    /// <summary>The model is on screen, or could not be shown (the stage shows the 2D picture then).</summary>
    public event Action? StateChanged;

    private Task Start() => starting ??= StartCore();

    private async Task StartCore()
    {
        Directory.CreateDirectory(folder);
        await web.EnsureCoreWebView2Async();
        var core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppContext.BaseDirectory, "Assets", "web"), CoreWebView2HostResourceAccessKind.Allow);
        core.SetVirtualHostNameToFolderMapping(ModelHost, folder, CoreWebView2HostResourceAccessKind.Allow);
        core.WebMessageReceived += (_, args) =>
        {
            var message = JsonNode.Parse(args.WebMessageAsJson) as JsonObject;
            switch (message?["type"]?.GetValue<string>())
            {
                case "page":
                    pageReady = true;
                    Replay();
                    break;
                case "ready":
                    State = "ready";
                    StateChanged?.Invoke();
                    break;
                case "failed":
                    State = "failed";
                    StateChanged?.Invoke();
                    break;
                case "motions":
                    MotionsLoaded?.Invoke(
                        (message["loaded"] as JsonArray)?.Select(entry => entry?.GetValue<string>() ?? "").ToList() ?? [],
                        (message["failed"] as JsonArray)?.OfType<JsonObject>().Select(entry => (entry["name"]?.GetValue<string>() ?? "", entry["message"]?.GetValue<string>() ?? "")).ToList() ?? []);
                    break;
                case "playing":
                    Playing?.Invoke(message["name"]?.GetValue<string>());
                    break;
            }
        };
        web.Source = new Uri($"https://{AppHost}/vrm.html");
    }

    private void Post(JsonObject message)
    {
        if (pageReady) web.CoreWebView2?.PostWebMessageAsJson(message.ToJsonString());
    }

    private void Replay()
    {
        if (wanted.Length > 0) Post(new JsonObject { ["type"] = "load", ["url"] = $"https://{ModelHost}/{wanted}" });
        if (mood is not null) Post(new JsonObject { ["type"] = "mood", ["key"] = mood });
        if (view is not null) Post(new JsonObject { ["type"] = "view", ["view"] = view.DeepClone() });
        if (motions is not null) Post((JsonObject)motions.DeepClone());
    }

    /// <summary>Motions that could be played (names), and those that could not with why (an FBX that is not a Mixamo rig…).</summary>
    public event Action<IReadOnlyList<string>, IReadOnlyList<(string Name, string Message)>>? MotionsLoaded;

    /// <summary>The motion now playing (null: the breathing pose).</summary>
    public event Action<string?>? Playing;

    private static string Hashed(string path, string extension) =>
        $"{Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.UTF8.GetBytes(path)))[..16]}{extension}";

    /// <summary>
    /// The agent's motions (name, server path with its ?v= stamp) and which one plays while it stands (null: the
    /// breathing pose). Files are fetched once; the same list again does nothing.
    /// </summary>
    public async void Motions(IReadOnlyList<(string Name, string Path)> list, string? idle)
    {
        var key = string.Join("|", list.Select(entry => $"{entry.Name}={entry.Path}")) + $"#{idle}";
        if (key == motionsKey) return;
        motionsKey = key;
        try
        {
            await Start();
            var entries = new JsonArray();
            foreach (var (name, path) in list)
            {
                var file = Hashed(path, ".fbx");
                var local = Path.Combine(folder, file);
                try
                {
                    if (!File.Exists(local)) await File.WriteAllBytesAsync(local, await api().Bytes(path));
                }
                catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException or TaskCanceledException)
                {
                    continue; // the page reports the motion as missing when it is asked for
                }
                entries.Add(new JsonObject { ["name"] = name, ["url"] = $"https://{ModelHost}/{file}" });
            }
            if (key != motionsKey) return;
            motions = new JsonObject { ["type"] = "motions", ["list"] = entries, ["idle"] = idle };
            Post((JsonObject)motions.DeepClone());
        }
        catch (Exception)
        {
            // no WebView2 runtime: the motions stay off, as the model does
        }
    }

    /// <summary>Plays a motion (looped or once, then back to the idle motion); null stops it.</summary>
    public void Play(string? name, bool loop = true) => Post(new JsonObject { ["type"] = "play", ["name"] = name, ["loop"] = loop });

    /// <summary>Shows the model at this server path (with its ?v= stamp).</summary>
    public async void Show(string path)
    {
        var name = Hashed(path, ".vrm");
        if (name == wanted && State is "ready" or "loading") return;
        wanted = name;
        State = "loading";
        try
        {
            await Start();
            var file = Path.Combine(folder, name);
            if (!File.Exists(file)) await File.WriteAllBytesAsync(file, await api().Bytes(path));
            if (wanted != name) return;
            Visibility = Visibility.Visible;
            Post(new JsonObject { ["type"] = "load", ["url"] = $"https://{ModelHost}/{name}" });
        }
        catch (Exception)
        {
            // no WebView2 runtime, no model on the server, no network: the 2D picture stays
            State = "failed";
            StateChanged?.Invoke();
        }
    }

    public void Hide()
    {
        wanted = "";
        motionsKey = "";
        motions = null;
        State = "none";
        Visibility = Visibility.Collapsed;
        Post(new JsonObject { ["type"] = "clear" });
    }

    public void Mood(string? key)
    {
        mood = key;
        if (key is not null) Post(new JsonObject { ["type"] = "mood", ["key"] = key });
    }

    public void Talk() => Post(new JsonObject { ["type"] = "talk" });

    public void View(double zoom, double x, double y)
    {
        view = new JsonObject { ["zoom"] = zoom, ["x"] = x, ["y"] = y };
        Post(new JsonObject { ["type"] = "view", ["view"] = view.DeepClone() });
    }
}
