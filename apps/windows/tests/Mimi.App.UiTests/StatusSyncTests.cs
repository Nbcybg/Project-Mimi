using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace Mimi.App.UiTests;

/// <summary>
/// The character chat's live status: the "กำลังตอบ…" line while the answer streams, and the
/// chat setting panel (สถานะ / Session) following a status change that comes from the server.
/// </summary>
public sealed partial class StatusSyncTests : IDisposable
{
    private readonly string home = Path.Combine(Path.GetTempPath(), "mimi-ui-status-" + Guid.NewGuid().ToString("n")[..8]);
    private readonly UIA3Automation automation = new();
    private Application? app;

    private static string AppExe()
    {
        if (Environment.GetEnvironmentVariable("MIMI_UI_TEST_APP") is { Length: > 0 } exe) return exe;
        var root = AppContext.BaseDirectory;
        for (var dir = new DirectoryInfo(root); dir is not null; dir = dir.Parent)
        {
            var built = Path.Combine(dir.FullName, "src", "Mimi.App", "bin");
            if (Directory.Exists(built))
            {
                return Directory.GetFiles(built, "Mimi.exe", SearchOption.AllDirectories).OrderByDescending(File.GetLastWriteTimeUtc).First();
            }
        }
        throw new FileNotFoundException("Mimi.exe not built (dotnet build src/Mimi.App)");
    }

    private Window Launch()
    {
        Directory.CreateDirectory(Path.Combine(home, "Roaming", "Mimi"));
        File.WriteAllText(Path.Combine(home, "Roaming", "Mimi", "config.json"), """{"server":"","pcAgent":{"enabled":false,"autoOn":1}}""");
        var start = new ProcessStartInfo(AppExe()) { UseShellExecute = false };
        start.Environment["MIMI_WINDOWS_HOME"] = home;
        if (Environment.GetEnvironmentVariable("MIMI_DEBUG_LOG") is { Length: > 0 } log) start.Environment["MIMI_DEBUG_LOG"] = log;
        app = Application.Launch(start);
        return Retry(() => app.GetMainWindow(automation, TimeSpan.FromSeconds(5)), "main window");
    }

    private static T Retry<T>(Func<T?> find, string what, int seconds = 20) where T : class
    {
        var end = DateTime.UtcNow.AddSeconds(seconds);
        while (true)
        {
            try
            {
                if (find() is { } found) return found;
            }
            catch (Exception) when (DateTime.UtcNow < end)
            {
            }
            if (DateTime.UtcNow > end) throw new TimeoutException($"not found: {what}");
            Thread.Sleep(200);
        }
    }

    private IEnumerable<AutomationElement> Everywhere() =>
        app!.GetAllTopLevelWindows(automation).SelectMany(top => top.FindAllDescendants());

    private AutomationElement ByIdEverywhere(string id, int seconds = 20) =>
        Retry(() => Everywhere().FirstOrDefault(element => element.Properties.AutomationId.ValueOrDefault == id && !element.Properties.IsOffscreen.ValueOrDefault), id, seconds);

    private AutomationElement? TextContaining(string part) =>
        Everywhere().FirstOrDefault(element => element.Properties.ControlType.ValueOrDefault == ControlType.Text
            && !element.Properties.IsOffscreen.ValueOrDefault
            && (element.Properties.Name.ValueOrDefault ?? "").Contains(part, StringComparison.Ordinal));

    private static void Type(AutomationElement box, string text)
    {
        box.Focus();
        box.AsTextBox().Text = text;
    }

    private void SignIn(Window window)
    {
        var core = Environment.GetEnvironmentVariable("MIMI_UI_TEST_CORE")!;
        var token = Environment.GetEnvironmentVariable("MIMI_UI_TEST_TOKEN")!;
        Type(ById(window, "ServerBox"), core);
        ById(window, "CheckButton").AsButton().Invoke();
        Type(ById(window, "TokenBox"), token);
        ById(window, "SignInButton").AsButton().Invoke();
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId("ChatList"))
            ?? (window.FindFirstDescendant(cf => cf.ByAutomationId("ConnectError")) is { } error && !string.IsNullOrEmpty(error.Properties.Name.ValueOrDefault) ? throw new InvalidOperationException($"sign-in: {error.Properties.Name.ValueOrDefault}") : null), "ChatList", 30);
    }

    private static AutomationElement ById(Window window, string id, int seconds = 20) =>
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId(id)), id, seconds);

    /// <summary>Sets one status key straight through the core's socket, like another device would.</summary>
    private static async Task StatusSet(string core, string token, string agent, string key, string value)
    {
        using var socket = new ClientWebSocket();
        var baseUrl = new Uri(new Uri(core), "/ws");
        await socket.ConnectAsync(new Uri(baseUrl.Scheme == "https" ? $"wss://{baseUrl.Authority}/ws" : $"ws://{baseUrl.Authority}/ws"), CancellationToken.None);
        static Task Send(ClientWebSocket socket, object frame) =>
            socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(frame)), WebSocketMessageType.Text, true, CancellationToken.None);
        await Send(socket, new { type = "hello", role = "client", token, name = "uitest", client = new { platform = "windows", version = "0" } });
        await Send(socket, new { type = "status-set", agent, key, value });
        await Task.Delay(1200);
        socket.Abort();
    }

    [CoreFact]
    public void The_status_line_shows_while_the_answer_streams_and_the_panel_follows_a_status_change()
    {
        var window = Launch();
        try
        {
            SignIn(window);

            // Open the chat (an existing row, or a new one from the menu).
            bool ChatOpen() => Everywhere().Any(element => element.Properties.AutomationId.ValueOrDefault == "Composer" && !element.Properties.IsOffscreen.ValueOrDefault);
            var existing = Retry(() => ById(window, "ChatList").FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem)) is var rows ? rows : null, "chat rows").FirstOrDefault();
            if (existing is not null)
            {
                for (var tries = 0; tries < 4 && !ChatOpen(); tries++)
                {
                    window.SetForeground();
                    existing.Click();
                    for (var wait = 0; wait < 20 && !ChatOpen(); wait++) Thread.Sleep(150);
                }
            }
            else
            {
                var newChat = ById(window, "NewChatButton");
                Retry(() => newChat.IsEnabled ? newChat : null, "agents loaded");
                newChat.AsButton().Invoke();
                var agent = Retry(() => window.Popup?.FindFirstDescendant(cf => cf.ByControlType(ControlType.ListItem))
                    ?? app!.GetAllTopLevelWindows(automation).SelectMany(top => top.FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem))).FirstOrDefault(), "agent in the new-chat list");
                Thread.Sleep(700);
                for (var tries = 0; tries < 4 && !ChatOpen(); tries++)
                {
                    window.SetForeground();
                    agent.Click();
                    for (var wait = 0; wait < 20 && !ChatOpen(); wait++) Thread.Sleep(150);
                }
            }

            // The rail (chat setting): สถานะ / Session, with the agent's live status boxes.
            ByIdEverywhere("RailButton", 30).AsButton().Invoke();
            var mood = Retry(() => Everywhere().FirstOrDefault(element => element.Properties.Name.ValueOrDefault == "อารมณ์" && element.Properties.ControlType.ValueOrDefault == ControlType.Edit) is { } box ? box : null, "the mood box", 30);
            var stamp = DateTime.Now.ToString("HHmmss");
            var nextMood = $"ง่วง {stamp}";

            // Another device sets the mood: the open panel follows it without any click.
            StatusSet(Environment.GetEnvironmentVariable("MIMI_UI_TEST_CORE")!, Environment.GetEnvironmentVariable("MIMI_UI_TEST_TOKEN")!, "test", "mood", nextMood).Wait();
            Retry(() => mood.AsTextBox().Text == nextMood ? mood : null, "the mood updated in the open panel", 30);

            // Close the rail and stream a message: the answering line shows above the composer.
            ByIdEverywhere("RailButton", 30).AsButton().Invoke();
            var composer = ById(window, "Composer", 30);
            Type(composer, $"สถานะแถบ {stamp}");
            ById(window, "SendButton").AsButton().Invoke();
            var busy = Retry(() => TextContaining("กำลังตอบ") ?? TextContaining("กำลังส่ง"), "the answering line while streaming", 30);
            if (Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is { Length: > 0 } dir)
            {
                // What is on screen while the answer streams (MIMI_UI_TEST_SHOTS set).
                File.WriteAllLines(Path.Combine(dir, "mimi-ui-busy.txt"),
                    Everywhere().Where(element => !element.Properties.IsOffscreen.ValueOrDefault && element.Properties.ControlType.ValueOrDefault == ControlType.Text)
                        .Select(element => $"id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault}"));
            }
            Retry(() => TextContaining($"สถานะแถบ {stamp}") is not null && TextContaining("กำลังตอบ") is null ? window : null, "the answering line gone when the turn is over", 90);
        }
        catch (Exception)
        {
            var dir = Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is { Length: > 0 } shots ? shots : Path.GetTempPath();
            try
            {
                window.SetForeground();
                Thread.Sleep(300);
                FlaUI.Core.Capturing.Capture.Element(window).ToFile(Path.Combine(dir, "mimi-ui-status-failure.png"));
                File.WriteAllLines(Path.Combine(dir, "mimi-ui-status-failure.txt"),
                    Everywhere().Select(element => $"{element.Properties.ControlType.ValueOrDefault} id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault}"));
            }
            catch (Exception)
            {
            }
            throw;
        }
    }

    public void Dispose()
    {
        try
        {
            app?.Kill();
        }
        catch (Exception)
        {
        }
        app?.Dispose();
        automation.Dispose();
        Thread.Sleep(500);
        if (Environment.GetEnvironmentVariable("MIMI_UI_TEST_KEEP") == "1") return;
        try
        {
            Directory.Delete(home, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
