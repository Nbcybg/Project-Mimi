using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Mimi.App.Services;
using Mimi.Core.ViewModels;

namespace Mimi.App.Views;

public sealed partial class ChatListView : UserControl
{
    /// <summary>The web's nav: (key, label). The key goes to <see cref="Navigate"/>.</summary>
    private static readonly (string Key, string Label)[] Pages =
    [
        ("chat", "แชต"), ("overseer", "Overseer"), ("agents", "Agent"), ("hub", "Hub"),
        ("workflows", "Workflow"), ("workspace", "Workspace"), ("settings", "ตั้งค่า"),
    ];

    public ChatListView(ChatListViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        for (var i = 0; i < Pages.Length; i++)
        {
            var (key, label) = Pages[i];
            var button = new Button
            {
                Content = label,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Padding = new Thickness(0, 6, 0, 6),
                FontSize = 12,
                CornerRadius = new CornerRadius(7),
                Background = key == "chat" ? Theme.Brush("Raised") : new Microsoft.UI.Xaml.Media.SolidColorBrush(Theme.Transparent),
                Foreground = key == "chat" ? Theme.Brush("Accent") : Theme.Brush("Ink2"),
                BorderThickness = new Thickness(0),
            };
            AutomationProperties.SetAutomationId(button, $"nav-{key}");
            button.Click += (_, _) => Navigate?.Invoke(key);
            Grid.SetColumn(button, i % 4);
            Grid.SetRow(button, i / 4);
            Nav.Children.Add(button);
        }
    }

    public ChatListViewModel ViewModel { get; }

    public static Visibility Not(bool value) => value ? Visibility.Collapsed : Visibility.Visible;

    /// <summary>The person picked a chat: the window opens it.</summary>
    public event Action<long>? Open;

    /// <summary>A page from the nav (chat, overseer, agents, hub, workflows, workspace, settings) or "search".</summary>
    public event Action<string>? Navigate;

    /// <summary>The line at the bottom: whether the PC agent is connected.</summary>
    public void PcAgent(bool online, string status)
    {
        PcDot.Fill = Theme.Brush(online ? "Ok" : "Faint");
        PcText.Text = $"PC agent: {(online ? "เชื่อมต่อแล้ว" : status)}";
    }

    private void OnSearch(object sender, RoutedEventArgs e) => Navigate?.Invoke("search");

    private void OnChatClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is ChatRow row) Open?.Invoke(row.Id);
    }

    private async void OnNewGroup(object sender, RoutedEventArgs e)
    {
        AgentFlyout.Hide();
        var title = new TextBox { Header = "ชื่อกลุ่ม" };
        var content = new StackPanel { Spacing = 8 };
        content.Children.Add(title);
        content.Children.Add(new TextBlock { Text = "สมาชิก (คนแรกที่ติ๊กจะตอบเมื่อไม่ได้ @ ใคร)", FontSize = 12 });
        var boxes = ViewModel.Agents.Select(agent => (Box: new CheckBox { Content = agent.Shown }, agent.Name)).ToList();
        foreach (var (box, _) in boxes) content.Children.Add(box);
        var order = new List<string>();
        foreach (var (box, name) in boxes)
        {
            box.Checked += (_, _) => order.Add(name);
            box.Unchecked += (_, _) => order.Remove(name);
        }
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            RequestedTheme = Theme.Element,
            Title = "สร้างแชตกลุ่ม",
            Content = new ScrollViewer { Content = content, MaxHeight = 480 },
            PrimaryButtonText = "สร้าง",
            CloseButtonText = "ยกเลิก",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (ViewModel.NewGroup(title.Text, order) is { } problem)
        {
            await new ContentDialog { XamlRoot = XamlRoot, RequestedTheme = Theme.Element, Title = "สร้างกลุ่มไม่ได้", Content = problem, CloseButtonText = "ปิด" }.ShowAsync();
        }
    }

    private void OnAgentClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not AgentChoice agent) return;
        AgentFlyout.Hide();
        ViewModel.NewChat(agent.Name);
    }
}
