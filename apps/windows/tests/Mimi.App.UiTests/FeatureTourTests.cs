using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;

namespace Mimi.App.UiTests;

/// <summary>
/// The pages that came with the Electron-like look: the themes, a chat's own look and its stage, Mimiamp's skin,
/// the workflow editor (add a node, link, save, test one node), the setup wizard and the Workspace window.
/// </summary>
public sealed partial class SignInChatMusicTests
{
    private static AutomationElement? Find(Window window, string id) => window.FindFirstDescendant(cf => cf.ByAutomationId(id));

    private void OpenAChat(Window window)
    {
        var existing = Retry(() => ById(window, "ChatList").FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem)) is var rows ? rows : null, "chat rows").FirstOrDefault();
        if (existing is null)
        {
            var newChat = ById(window, "NewChatButton");
            Retry(() => newChat.IsEnabled ? newChat : null, "agents loaded");
            newChat.AsButton().Invoke();
            var agent = Retry(() => app!.GetAllTopLevelWindows(automation).SelectMany(top => top.FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem))).FirstOrDefault(), "agent in the new-chat list");
            Thread.Sleep(700);
            agent.Click();
        }
        else
        {
            for (var tries = 0; tries < 4 && Find(window, "Composer") is null; tries++)
            {
                window.SetForeground();
                existing.Click();
                for (var wait = 0; wait < 20 && Find(window, "Composer") is null; wait++) Thread.Sleep(150);
            }
        }
        ById(window, "Composer", 30);
    }

    [CoreFact]
    public void The_new_pages_work_theme_chat_look_mimiamp_workflow_editor_wizard_workspace()
    {
        var window = Launch();
        try
        {
            SignIn(window);
            ById(window, "nav-hub");
            Thread.Sleep(1500);
            Shot(window, "tour-home");

            // Settings → หน้าตา: light, then back to dark.
            ById(window, "SettingsButton").AsButton().Invoke();
            Press(ById(window, "tab-look"));
            ById(window, "theme-light").Click();
            Thread.Sleep(600);
            Shot(window, "tour-settings-light");
            ById(window, "theme-dark").Click();
            Thread.Sleep(400);
            Press(ById(window, "tab-app"));
            Thread.Sleep(600);
            Shot(window, "tour-settings-app");

            // A chat: its own look (light theme, large text) through the ข้อมูล panel.
            ById(window, "BackButton").AsButton().Invoke();
            OpenAChat(window);
            ById(window, "RailButton").AsButton().Invoke();
            var lookTab = Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("rail-look"))).FirstOrDefault(found => found is not null), "the look tab");
            lookTab!.Click();
            Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-theme-light"))).FirstOrDefault(found => found is not null), "the chat's theme").Click();
            Thread.Sleep(500);
            Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-size-2"))).FirstOrDefault(found => found is not null), "the chat's text size").Click();
            Thread.Sleep(500);
            // The stage: a preset scene behind this chat.
            Press(Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-bg-preset"))).FirstOrDefault(found => found is not null), "the chat's background")!);
            Thread.Sleep(1200);
            Shot(window, "tour-chat-look");
            Press(Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-bg-default"))).FirstOrDefault(found => found is not null), "the chat's background")!);
            // Back to the app's look for this chat.
            Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-theme-"))).FirstOrDefault(found => found is not null), "the chat's theme").Click();
            Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByAutomationId("chat-size-1"))).FirstOrDefault(found => found is not null), "the chat's text size").Click();
            window.SetForeground();
            FlaUI.Core.Input.Keyboard.Press(FlaUI.Core.WindowsAPI.VirtualKeyShort.ESCAPE);

            // Mimiamp's skin.
            ById(window, "MusicButton").AsButton().Invoke();
            Retry(() => ById(window, "Tracks").FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem)).Length > 0 ? window : null, "songs", 30);
            ById(window, "Pan");
            Shot(window, "tour-mimiamp");

            // A new workflow: add a node after the agent, save, test one node alone.
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "Workflow");
            ById(window, "add-workflows").AsButton().Invoke();
            ById(window, "SaveWorkflow");
            var cards = Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).Where(element => (element.Properties.AutomationId.ValueOrDefault ?? "").StartsWith("node-", StringComparison.Ordinal)).ToList() is { Count: 3 } found ? found : null, "the new workflow's three nodes");
            Type(DialogField(window, "ชื่อไฟล์ (a-z, 0-9, -)"), "uitest-" + DateTime.Now.ToString("HHmmss"));
            Thread.Sleep(500); // WinUI raises TextChanged a moment later
            ById(window, "SaveWorkflow").AsButton().Invoke();
            Retry(() => TextContaining(window, "บันทึกแล้ว"), "saved", 30);
            // The "set" node: no model needed to test it.
            ById(window, "AddNode").Patterns.ExpandCollapse.Pattern.Expand();
            var group = Retry(() => app!.GetAllTopLevelWindows(automation).Append(window).Select(top => top.FindFirstDescendant(cf => cf.ByName("ข้อมูล").And(cf.ByControlType(ControlType.MenuItem)))).FirstOrDefault(found => found is not null), "the ข้อมูล menu");
            if (group!.Patterns.ExpandCollapse.IsSupported) group.Patterns.ExpandCollapse.Pattern.Expand();
            else group.Click();
            Thread.Sleep(500);
            MenuItem(window, "set (กำหนดค่า)");
            Retry(() => window.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)).Count(element => (element.Properties.AutomationId.ValueOrDefault ?? "").StartsWith("node-", StringComparison.Ordinal)) == 4 ? window : null, "the added node");
            Type(DialogField(window, "field ที่จะตั้ง (JSON) *"), """{"greeting":"สวัสดี {{ $json.name }}"}""");
            Thread.Sleep(500);
            var test = ById(window, "TestExpander");
            if (test.Patterns.ExpandCollapse.IsSupported) test.Patterns.ExpandCollapse.Pattern.Expand();
            Type(ById(window, "TestInput"), """{"name":"มิมิ"}""");
            Thread.Sleep(300);
            ById(window, "RunNodeTest").AsButton().Invoke();
            Retry(() => TextContaining(window, "ทดสอบผ่าน") ?? TextContaining(window, "node นี้ผิดพลาด"), "the node's test result", 60);
            Thread.Sleep(600);
            Shot(window, "tour-workflow-test");
            Assert.NotNull(TextContaining(window, "ทดสอบผ่าน"));
            ById(window, "SaveWorkflow").AsButton().Invoke();
            Retry(() => TextContaining(window, "บันทึกแล้ว"), "saved again", 30);
            Shot(window, "tour-workflow");
            ById(window, "BackButton").AsButton().Invoke();

            // The setup wizard: its steps, then closed.
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "ตัวช่วยตั้งค่า");
            ById(window, "setup-step-0");
            Thread.Sleep(800);
            Shot(window, "tour-setup-provider");
            ById(window, "setup-step-1").AsButton().Invoke();
            Thread.Sleep(800);
            Shot(window, "tour-setup-agent");
            ById(window, "SetupClose").AsButton().Invoke();
            ById(window, "ChatList");

            // The Workspace window: the folder tree and a live terminal.
            ById(window, "MoreButton").AsButton().Invoke();
            MenuItem(window, "Workspace (เบราว์เซอร์ · ไฟล์ · เทอร์มินัล)");
            var workspace = Retry(() => app!.GetAllTopLevelWindows(automation).FirstOrDefault(top => top.Title == "Mimi Workspace"), "the Workspace window", 30);
            // xterm.js is up when its input is (UI Automation does not reach the labels beside a WebView2 reliably).
            Retry(() => workspace.FindFirstDescendant(cf => cf.ByName("Terminal input")), "the terminal", 30);
            Thread.Sleep(3000);
            Shot(workspace, "tour-workspace");
            workspace.Close();
        }
        catch (Exception)
        {
            var dir = Environment.GetEnvironmentVariable("MIMI_UI_TEST_SHOTS") is { Length: > 0 } shots ? shots : Path.GetTempPath();
            try
            {
                WindowShot.Save(window, Path.Combine(dir, "mimi-ui-tour-failure.png"));
                foreach (var (top, index) in app!.GetAllTopLevelWindows(automation).Where(top => top.Title != window.Title).Select((top, index) => (top, index)))
                {
                    WindowShot.Save(top, Path.Combine(dir, $"mimi-ui-tour-failure-{index}.png"));
                    File.WriteAllLines(Path.Combine(dir, $"mimi-ui-tour-failure-{index}.txt"),
                        top.FindAllDescendants().Select(element => $"{element.Properties.ControlType.ValueOrDefault} id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault}"));
                }
                File.WriteAllLines(Path.Combine(dir, "mimi-ui-tour-failure.txt"),
                    window.FindAllDescendants().Select(element => $"{element.Properties.ControlType.ValueOrDefault} id={element.Properties.AutomationId.ValueOrDefault} name={element.Properties.Name.ValueOrDefault}"));
            }
            catch (Exception)
            {
            }
            throw;
        }
    }
}
