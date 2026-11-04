using System.Diagnostics;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;

namespace Mimi.App.UiTests;

/// <summary>Skips a test when the local core it needs is not given.</summary>
public sealed class CoreFactAttribute : FactAttribute
{
    public CoreFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MIMI_UI_TEST_CORE")) || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MIMI_UI_TEST_TOKEN")))
        {
            Skip = "set MIMI_UI_TEST_CORE and MIMI_UI_TEST_TOKEN (a core on this computer with a test agent; apps/windows/README.md)";
        }
    }
}

/// <summary>
/// Sign in → chat (streamed answer) → pins, search, inbox → sign out, on the real app with its own empty data folder
/// (MIMI_WINDOWS_HOME), so nothing of a real install on this computer is touched.
/// </summary>
public sealed partial class SignInChatMusicTests : IDisposable
{
    private readonly string home = Path.Combine(Path.GetTempPath(), "mimi-ui-test-" + Guid.NewGuid().ToString("n")[..8]);
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
        // No PC agent in this test: it would act on this computer's home folder.
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

    private static AutomationElement ById(Window window, string id, int seconds = 20) =>
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId(id)), id, seconds);

    private static AutomationElement ByName(Window window, string name, int seconds = 20) =>
        Retry(() => window.FindFirstDescendant(cf => cf.ByName(name)), name, seconds);

    private static AutomationElement? TextContaining(Window window, string part) =>
        window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).FirstOrDefault(element => (element.Properties.Name.ValueOrDefault ?? "").Contains(part, StringComparison.Ordinal));

    /// <summary>A picture of a page, when MIMI_UI_TEST_SHOTS names a folder for them.</summary>
    private static void Shot(Window window, string name)
    {
        if (Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is not { Length: > 0 } dir) return;
        Thread.Sleep(600);
        // The window alone (PrintWindow), never the screen around it.
        WindowShot.Save(window, Path.Combine(dir, $"mimi-ui-{name}.png"));
    }

    /// <summary>Opens the menu of the newest stored message and picks an item (the menu is a popup of its own).</summary>
    private void MessageMenu(Window window, string item)
    {
        var more = Retry(() => window.FindAllDescendants(cf => cf.ByName("ตัวเลือกข้อความ")).LastOrDefault(), "a message's menu button", 30);
        more.AsButton().Invoke();
        var entry = Retry(() => window.FindFirstDescendant(cf => cf.ByName(item))
            ?? app!.GetAllTopLevelWindows(automation).Select(top => top.FindFirstDescendant(cf => cf.ByName(item))).FirstOrDefault(found => found is not null), $"menu item {item}");
        if (entry.Patterns.Invoke.IsSupported) entry.Patterns.Invoke.Pattern.Invoke();
        else entry.Click();
    }

    private static void Type(AutomationElement box, string text)
    {
        box.Focus();
        box.AsTextBox().Text = text;
    }

    [CoreFact]
    public void Sign_in_with_the_token_chat_with_a_streamed_answer_and_play_a_song()
    {
        var window = Launch();
        try
        {
            Flow(window);
        }
        catch (Exception)
        {
            // What the window showed when it went wrong (MIMI_UI_TEST_SHOTS, else the temp folder).
            var dir = Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is { Length: > 0 } shots ? shots : Path.GetTempPath();
            try
            {
                window.SetForeground();
                Thread.Sleep(300);
                FlaUI.Core.Capturing.Capture.Element(window).ToFile(Path.Combine(dir, "mimi-ui-test-failure.png"));
                File.WriteAllLines(Path.Combine(dir, "mimi-ui-test-failure.txt"),
                    window.FindAllDescendants().Select(element => $"{element.Properties.ControlType.ValueOrDefault} id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault} offscreen={element.Properties.IsOffscreen.ValueOrDefault}"));
            }
            catch (Exception)
            {
            }
            throw;
        }
    }

    private static void SignIn(Window window)
    {
        var core = Environment.GetEnvironmentVariable("MIMI_UI_TEST_CORE")!;
        var token = Environment.GetEnvironmentVariable("MIMI_UI_TEST_TOKEN")!;

        // Connect: the server, then the core's token.
        Type(ById(window, "ServerBox"), core);
        ById(window, "CheckButton").AsButton().Invoke();
        Type(ById(window, "TokenBox"), token);
        ById(window, "SignInButton").AsButton().Invoke();

        // Signed in: the chat list (or the app's own words for why not).
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId("ChatList"))
            ?? (window.FindFirstDescendant(cf => cf.ByAutomationId("ConnectError")) is { } error && !string.IsNullOrEmpty(error.Properties.Name.ValueOrDefault) ? throw new InvalidOperationException($"sign-in: {error.Properties.Name.ValueOrDefault}") : null), "ChatList", 30);
    }

    [CoreFact]
    public void Every_management_page_loads_and_a_skill_is_added_edited_and_removed()
    {
        var window = Launch();
        try
        {
            SignIn(window);
            // Every page of the menu and every tab: each list says what it has, or that it is empty, without an error.
            foreach (var (item, page) in new[] { ("Agent", "Agent"), ("Hub", "Hub"), ("Workflow", "Workflow"), ("AI Overseer", "AI Overseer"), ("ตั้งค่า Mimi", "ตั้งค่า") })
            {
                ById(window, "MoreButton").AsButton().Invoke();
                MenuItem(window, item);
                Retry(() => ById(window, "TitleText").Properties.Name.ValueOrDefault == page ? window : null, $"page {page}");
                var view = window;
                List<string> Tabs() => view.FindAllDescendants(cf => cf.ByControlType(ControlType.Button)).Where(button => (button.Properties.AutomationId.ValueOrDefault ?? "").StartsWith("tab-", StringComparison.Ordinal)).Select(button => button.Properties.AutomationId.Value).ToList();
                var tabs = page is "Hub" or "ตั้งค่า" ? Retry(() => Tabs() is { Count: > 0 } found ? found : null, $"tabs of {page}") : Tabs();
                foreach (var tab in tabs.DefaultIfEmpty(""))
                {
                    if (tab.Length > 0) Press(ById(window, tab));
                    Thread.Sleep(700);
                    // The look of the app is native only (no list on the server).
                    if (tab != "tab-look") Retry(() => view.FindAllDescendants(cf => cf.ByControlType(ControlType.Button)).Any(button => (button.Properties.Name.ValueOrDefault ?? "").StartsWith("โหลด ", StringComparison.Ordinal)) ? view : null, $"lists of {page} {tab}");
                    Shot(window, $"{page}-{(tab.Length > 0 ? tab : "main")}");
                    var problem = view.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).Select(text => text.Properties.Name.ValueOrDefault ?? "").FirstOrDefault(text => text.StartsWith("อ่านข้อมูลไม่ได้", StringComparison.Ordinal));
                    Assert.Null(problem);
                }
            }

            // A skill through the generic form: add, edit, remove.
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "Hub");
            Press(ById(window, "tab-skills"));
            var name = "uitest-" + DateTime.Now.ToString("HHmmss");
            ById(window, "add-skills").AsButton().Invoke();
            Type(DialogField(window, "ชื่อ skill"), name);
            Type(DialogField(window, "ใช้เมื่อไร (agent อ่านบรรทัดนี้เพื่อเลือก)"), "ทดสอบจาก UI test");
            Type(DialogField(window, "คู่มือ (Markdown)"), "# ทดสอบ\nทำตามนี้");
            Shot(window, "skill-form");
            DialogButton(window, "บันทึก");
            var row = Retry(() => window.FindFirstDescendant(cf => cf.ByName(name).And(cf.ByControlType(ControlType.Button))), "the new skill", 30);
            row.AsButton().Invoke();
            Type(DialogField(window, "ใช้เมื่อไร (agent อ่านบรรทัดนี้เพื่อเลือก)"), "แก้แล้ว");
            DialogButton(window, "บันทึก");
            Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).Any(text => text.Properties.Name.ValueOrDefault == "แก้แล้ว") ? window : null, "the edited description", 30);
            window.FindFirstDescendant(cf => cf.ByName(name).And(cf.ByControlType(ControlType.Button)))!.AsButton().Invoke();
            DialogButton(window, "ลบ");
            DialogButton(window, "ตกลง");
            Retry(() => window.FindFirstDescendant(cf => cf.ByName(name).And(cf.ByControlType(ControlType.Button))) is null ? window : null, "the skill gone", 30);

            // A pack through its actions: install (confirm, then the report), one of its workflows drawn, then removed again.
            Press(ById(window, "tab-packs"));
            Retry(() => window.FindFirstDescendant(cf => cf.ByName("สรุปเช้า (อากาศ)").And(cf.ByControlType(ControlType.Button))), "the pack", 30).AsButton().Invoke();
            Shot(window, "pack-form");
            DialogButton(window, "ติดตั้ง");
            Thread.Sleep(800);
            Shot(window, "pack-confirm");
            DialogButton(window, "ตกลง");
            Thread.Sleep(1500);
            Shot(window, "pack-after");
            Report(window, "ติดตั้ง", "morning-brief");
            Shot(window, "pack-report");
            DialogButton(window, "ปิด");
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "Workflow");
            Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Button)).FirstOrDefault(button => (button.Properties.Name.ValueOrDefault ?? "").StartsWith("○", StringComparison.Ordinal)), "a workflow", 30).AsButton().Invoke();
            ById(window, "SaveWorkflow");
            var cards = Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text))
                .Where(element => (element.Properties.AutomationId.ValueOrDefault ?? "").StartsWith("node-", StringComparison.Ordinal)).ToList() is { Count: > 1 } found ? found : null, "the workflow's nodes", 30);
            Thread.Sleep(800);
            Shot(window, "workflow-graph");
            Assert.True(cards.Count >= 2);
            ById(window, "BackButton").AsButton().Invoke();
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "Hub");
            Press(ById(window, "tab-packs"));
            Retry(() => window.FindFirstDescendant(cf => cf.ByName("สรุปเช้า (อากาศ)").And(cf.ByControlType(ControlType.Button))), "the pack", 30).AsButton().Invoke();
            DialogButton(window, "ถอนการติดตั้ง");
            DialogButton(window, "ตกลง");
            Report(window, "ถอนการติดตั้ง", "morning-brief");
            DialogButton(window, "ปิด");
        }
        catch (Exception)
        {
            var dir = Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is { Length: > 0 } shots ? shots : Path.GetTempPath();
            try
            {
                window.SetForeground();
                Thread.Sleep(300);
                FlaUI.Core.Capturing.Capture.Element(window).ToFile(Path.Combine(dir, "mimi-ui-manage-failure.png"));
                File.WriteAllLines(Path.Combine(dir, "mimi-ui-manage-failure.txt"),
                    window.FindAllDescendants().Select(element => $"{element.Properties.ControlType.ValueOrDefault} id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault}"));
            }
            catch (Exception)
            {
            }
            throw;
        }
    }

    /// <summary>The result dialog of an action: its title, and its text says <paramref name="part"/>.</summary>
    private void Report(Window window, string title, string part)
    {
        Retry(() => app!.GetAllTopLevelWindows(automation).Append(window)
            .SelectMany(top => top.FindAllDescendants(cf => cf.ByControlType(ControlType.Text).And(cf.ByName(title)))).FirstOrDefault(), $"the {title} report", 60);
        // The report is drawn as rows (Controls/ResultView.cs); the pack's id is one of them.
        var texts = Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text))
            .Select(text => text.Properties.Name.ValueOrDefault ?? "")
            .FirstOrDefault(text => text.Contains(part, StringComparison.Ordinal)), $"{part} in the {title} report", 20);
        Assert.Contains(part, texts);
    }

    /// <summary>A button or toggle button, pressed through UI Automation.</summary>
    private static void Press(AutomationElement element)
    {
        if (element.Patterns.Toggle.IsSupported)
        {
            if (element.Patterns.Toggle.Pattern.ToggleState.Value != ToggleState.On) element.Patterns.Toggle.Pattern.Toggle();
        }
        else if (element.Patterns.Invoke.IsSupported) element.Patterns.Invoke.Pattern.Invoke();
        else element.Click();
    }

    /// <summary>A menu item of the window's popups, invoked.</summary>
    private void MenuItem(Window window, string name)
    {
        var entry = Retry(() => window.FindFirstDescendant(cf => cf.ByName(name).And(cf.ByControlType(ControlType.MenuItem)))
            ?? app!.GetAllTopLevelWindows(automation).Select(top => top.FindFirstDescendant(cf => cf.ByName(name).And(cf.ByControlType(ControlType.MenuItem)))).FirstOrDefault(found => found is not null), $"menu item {name}");
        entry.Patterns.Invoke.Pattern.Invoke();
    }

    /// <summary>A field of the open dialog, by its label.</summary>
    private AutomationElement DialogField(Window window, string label) =>
        Retry(() => window.FindFirstDescendant(cf => cf.ByName(label).And(cf.ByControlType(ControlType.Edit)))
            ?? app!.GetAllTopLevelWindows(automation).Select(top => top.FindFirstDescendant(cf => cf.ByName(label).And(cf.ByControlType(ControlType.Edit)))).FirstOrDefault(found => found is not null), $"field {label}");

    private void DialogButton(Window window, string text)
    {
        var button = Retry(() => window.FindFirstDescendant(cf => cf.ByName(text).And(cf.ByControlType(ControlType.Button)))
            ?? app!.GetAllTopLevelWindows(automation).Select(top => top.FindFirstDescendant(cf => cf.ByName(text).And(cf.ByControlType(ControlType.Button)))).FirstOrDefault(found => found is not null), $"button {text}");
        button.AsButton().Invoke();
    }

    private void Flow(Window window)
    {
        SignIn(window);
        // A direct chat with the agent opens from the list when it is there (the "new chat" menu reopens that same chat).
        var existing = Retry(() => ById(window, "ChatList").FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem)) is var rows ? rows : null, "chat rows").FirstOrDefault();
        if (existing is not null)
        {
            // The first click may only bring the window forward: click again until the chat is open.
            for (var tries = 0; tries < 4 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; tries++)
            {
                window.SetForeground();
                existing.Click();
                for (var wait = 0; wait < 20 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; wait++) Thread.Sleep(150);
            }
        }
        else
        {
            var newChat = ById(window, "NewChatButton");
            Retry(() => newChat.IsEnabled ? newChat : null, "agents loaded");
            newChat.AsButton().Invoke();
            var agent = Retry(() => window.Popup?.FindFirstDescendant(cf => cf.ByControlType(ControlType.ListItem))
                ?? app!.GetAllTopLevelWindows(automation).SelectMany(top => top.FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem))).FirstOrDefault(), "agent in the new-chat list");
            Thread.Sleep(700); // the flyout animates in; a click before that only closes it
            for (var tries = 0; tries < 4 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; tries++)
            {
                window.SetForeground();
                agent.Click();
                for (var wait = 0; wait < 20 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; wait++) Thread.Sleep(150);
            }
        }

        // The chat: send, see the answer stream in from the core's model.
        var composer = ById(window, "Composer", 30);
        var stamp = DateTime.Now.ToString("HHmmss");
        Type(composer, $"ทดสอบจากแอป Windows {stamp}");
        ById(window, "SendButton").AsButton().Invoke();
        Retry(() => TextContaining(window, $"ทดสอบจากแอป Windows {stamp}"), "my message");
        // The answer comes word by word; its last words mean the turn is through.
        Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).FirstOrDefault(element => element.Properties.Name.ValueOrDefault is { } text && text.Contains(stamp, StringComparison.Ordinal) && text.Contains("streaming", StringComparison.Ordinal)), "the whole answer", 60);
        Shot(window, "chat");
        Assert.Null(TextContaining(window, "ผิดพลาด"));

        // The answer's menu: pin it (the pin bar shows), reply to it (the reply bar shows), then search for it.
        MessageMenu(window, "📌 ปักหมุด");
        ById(window, "PinBar", 30);
        MessageMenu(window, "↩ ตอบกลับ");
        Retry(() => ById(window, "ReplyBar").Properties.Name.ValueOrDefault is { } reply && reply.StartsWith("ตอบกลับ", StringComparison.Ordinal) ? reply : null, "the reply bar");
        ByName(window, "ยกเลิกการตอบกลับ").AsButton().Invoke();
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId("ReplyBar")) is null ? window : null, "the reply bar gone");
        Shot(window, "pinned");

        // The character screen has its own glass back button; search lives on the chat list.
        ById(window, "BackButton").AsButton().Invoke();
        ById(window, "ChatList");
        ById(window, "SearchButton").AsButton().Invoke();
        Type(ById(window, "SearchField"), stamp);
        var hit = Retry(() => ById(window, "SearchResults").FindFirstDescendant(cf => cf.ByControlType(ControlType.ListItem)), "a search hit", 30);
        Shot(window, "search");
        // The first click may only bring the window forward: click again until the chat opens.
        for (var tries = 0; tries < 4 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; tries++)
        {
            window.SetForeground();
            hit.Click();
            for (var wait = 0; wait < 20 && window.FindFirstDescendant(cf => cf.ByAutomationId("Composer")) is null; wait++) Thread.Sleep(150);
        }
        ById(window, "Composer", 30);

        // Unpin: the bar goes, so a next run starts without pins.
        MessageMenu(window, "📌 เลิกปักหมุด");
        Retry(() => window.FindFirstDescendant(cf => cf.ByAutomationId("PinBar")) is null ? window : null, "the pin bar gone", 30);

        // The character screen has only its glass buttons; the chat list is the way to the rest.
        ById(window, "BackButton").AsButton().Invoke();
        ById(window, "ChatList");

        // The notification inbox opens from the bell.
        ById(window, "InboxButton").AsButton().Invoke();
        ById(window, "InboxList");
        ById(window, "ChatsButton").AsButton().Invoke();
        ById(window, "ChatList");

        // Settings and sign-out bring the connect page back, and the token is gone from disk.
        ById(window, "SettingsButton").AsButton().Invoke();
        ById(window, "SignOut").AsButton().Invoke();
        ById(window, "TokenBox", 30);
        Assert.False(File.Exists(Path.Combine(home, "Roaming", "Mimi", "session.dpapi")));
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
        // MIMI_UI_TEST_KEEP=1 leaves the test home (its start-error.txt, DPAPI file) for a look.
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
