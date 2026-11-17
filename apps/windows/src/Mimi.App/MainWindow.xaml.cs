using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Views;
using Mimi.Core;
using Mimi.Core.Desktop;
using Mimi.Core.Net;
using Windows.Graphics;

namespace Mimi.App;

public enum Page
{
    Connect,
    Chats,
    Chat,
    Settings,
    Search,
    Inbox,
    Agents,
    Hub,
    Workflows,
    Overseer,
    MimiSettings,
    WorkflowEditor,
    Setup,
}

/// <summary>
/// The window: a narrow floating window at the bottom right like the Electron app (410 × 820), its place
/// remembered; closing it only hides it to the tray. Pages switch inside it.
/// </summary>
public sealed partial class MainWindow : Window
{
    private static readonly SizeInt32 DefaultSize = new(410, 820);
    private const int Margin = 12;

    private readonly App app;
    private readonly Dictionary<Page, FrameworkElement> pages = [];
    private bool quitting;
    private bool chatSolo;

    internal MainWindow(App app)
    {
        this.app = app;
        InitializeComponent();
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Mimi.ico"));
        AppWindow.Title = "Mimi";
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = 340;
            presenter.PreferredMinimumHeight = 560;
            presenter.IsAlwaysOnTop = app.Config.Window.OnTop;
        }
        Services.Theme.Apply(app.Config.Theme, Root, AppWindow);
        Place();
        AppWindow.Closing += (_, args) =>
        {
            if (quitting) return;
            args.Cancel = true;
            Hide();
        };
        AppWindow.Changed += (_, args) =>
        {
            if (args.DidPositionChange || args.DidSizeChange) Remember();
            if (args.DidVisibilityChange) app.WindowVisibilityChanged(AppWindow.IsVisible);
        };
        Activated += (_, args) =>
        {
            var active = args.WindowActivationState != WindowActivationState.Deactivated;
            app.WindowActiveChanged(active);
            if (!active && app.Config.Window.HideOnBlur && AppWindow.IsVisible) Hide();
        };
    }

    public Page CurrentPage { get; private set; } = Page.Connect;
    public nint Handle => Win32Interop.GetWindowFromWindowId(AppWindow.Id);
    public bool Showing => AppWindow.IsVisible;

    private void Place()
    {
        var saved = app.Config.Window.Bounds;
        if (saved is not null)
        {
            var area = DisplayArea.GetFromRect(new RectInt32(saved.X, saved.Y, saved.Width, saved.Height), DisplayAreaFallback.None);
            if (area is not null)
            {
                AppWindow.MoveAndResize(new RectInt32(saved.X, saved.Y, saved.Width, saved.Height));
                if (app.Config.Window.Maximized && AppWindow.Presenter is OverlappedPresenter overlapped) overlapped.Maximize();
                return;
            }
        }
        var work = DisplayArea.Primary.WorkArea;
        var height = Math.Min(DefaultSize.Height, work.Height - 2 * Margin);
        AppWindow.MoveAndResize(new RectInt32(work.X + work.Width - DefaultSize.Width - Margin, work.Y + work.Height - height - Margin, DefaultSize.Width, height));
    }

    private void Remember()
    {
        if (AppWindow.Presenter is not OverlappedPresenter presenter || presenter.State == OverlappedPresenterState.Minimized) return;
        app.Config.Window.Maximized = presenter.State == OverlappedPresenterState.Maximized;
        if (!app.Config.Window.Maximized)
        {
            app.Config.Window.Bounds = new WindowBounds(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
        }
        app.SaveConfig(later: true);
    }

    public void SetOnTop(bool onTop)
    {
        if (AppWindow.Presenter is OverlappedPresenter presenter) presenter.IsAlwaysOnTop = onTop;
    }

    public void ShowAndFocus()
    {
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter) presenter.Restore();
        AppWindow.Show();
        Activate();
        Native.Win32.SetForegroundWindow(Handle);
    }

    public void Hide() => AppWindow.Hide();

    public void Quit()
    {
        quitting = true;
        Close();
    }

    public void AddPage(Page page, FrameworkElement view)
    {
        view.Visibility = Visibility.Collapsed;
        pages[page] = view;
        Pages.Children.Add(view);
    }

    public void Show(Page page, string? title = null)
    {
        CurrentPage = page;
        foreach (var (key, view) in pages) view.Visibility = key == page ? Visibility.Visible : Visibility.Collapsed;
        UpdateHeader();
        // The chat list is the home (the web's side panel); every other page goes back to it.
        BackButton.Visibility = page == Page.Chats ? Visibility.Collapsed : Visibility.Visible;
        Logo.Visibility = page == Page.Chats ? Visibility.Visible : Visibility.Collapsed;
        ConnText.Visibility = page == Page.Chats ? Visibility.Visible : Visibility.Collapsed;
        Dot.Visibility = page == Page.Chats ? Visibility.Collapsed : Visibility.Visible;
        ChatsButton.Visibility = page is Page.Chats or Page.Chat ? Visibility.Collapsed : Visibility.Visible;
        TitleText.Text = title ?? page switch
        {
            Page.Chats => "Mimi",
            Page.Settings => "ตั้งค่า",
            Page.Search => Loc.T("ค้นหา"),
            Page.Inbox => "การแจ้งเตือน",
            Page.Agents => "Agent",
            Page.Hub => "Hub",
            Page.Workflows => "Workflow",
            Page.Overseer => "AI Overseer",
            Page.MimiSettings => "ตั้งค่า",
            Page.WorkflowEditor => "Workflow",
            _ => "Mimi",
        };
        RefreshAttention();
    }

    /// <summary>
    /// The character chat is the whole window (the web's .solo screen): its own glass buttons replace this
    /// window's header until the chat is left or the character is switched off.
    /// </summary>
    public void SetChatSolo(bool solo)
    {
        chatSolo = solo;
        UpdateHeader();
    }

    private void UpdateHeader() =>
        Header.Visibility = CurrentPage is Page.Connect or Page.Setup || (CurrentPage == Page.Chat && chatSolo)
            ? Visibility.Collapsed
            : Visibility.Visible;

    public void SetTitle(string title)
    {
        if (CurrentPage == Page.Chat) TitleText.Text = title.Length > 0 ? title : Loc.T("แชต");
    }

    /// <summary>The connection dot and the line under the header.</summary>
    public void Connection(SocketState state)
    {
        var (brush, text) = state switch
        {
            SocketState.Online => ("MimiOkBrush", ""),
            SocketState.Connecting => ("MimiWarnBrush", "กำลังเชื่อมต่อ…"),
            SocketState.Offline offline => ("MimiWarnBrush", offline.RetryIn > TimeSpan.Zero ? $"หลุดการเชื่อมต่อ ลองใหม่ใน {Math.Ceiling(offline.RetryIn.TotalSeconds)} วินาที…" : "หลุดการเชื่อมต่อ กำลังต่อใหม่…"),
            SocketState.RateLimited => ("MimiBadBrush", "ใส่รหัสผิดหลายครั้งเกินไป รอ 15 นาทีแล้วจะลองใหม่เอง"),
            SocketState.AppTooOld => ("MimiBadBrush", "เซิร์ฟเวอร์ต้องการแอปเวอร์ชันใหม่กว่านี้ กรุณาอัปเดต Mimi"),
            _ => ("MimiFaintBrush", ""),
        };
        Dot.Fill = (Brush)Application.Current.Resources[brush];
        ConnText.Text = state is SocketState.Online ? "online" : "offline";
        ConnText.Foreground = (Brush)Application.Current.Resources[state is SocketState.Online ? "MimiOkBrush" : "MimiBadBrush"];
        OfflineText.Text = text;
        Offline.Visibility = text.Length > 0 && CurrentPage != Page.Connect ? Visibility.Visible : Visibility.Collapsed;
    }

    private Microsoft.UI.Xaml.DispatcherTimer? attentionClock;

    /// <summary>
    /// The bars under the header: every question still waiting for the user, whatever chat it came from (it names the agent and
    /// the chat, so it need not be hidden from the other chats), and the PC agent's questions at the computer's own screen
    /// with the time left (nobody answering in time counts as "no").
    /// </summary>
    public void RefreshAttention()
    {
        var items = app.Session.Attention.Items;
        Attention.Children.Clear();
        if (items.Count == 0 || CurrentPage == Page.Connect)
        {
            Attention.Visibility = Visibility.Collapsed;
            attentionClock?.Stop();
            return;
        }
        var clocks = new List<(TextBlock Text, DateTimeOffset Until)>();
        foreach (var item in items.Take(3)) Attention.Children.Add(AttentionRow(item, clocks));
        if (items.Count > 3)
        {
            Attention.Children.Add(new TextBlock
            {
                Text = $"และอีก {items.Count - 3} รายการที่รออยู่",
                FontSize = 12,
                Foreground = Services.Theme.Brush("Muted"),
                HorizontalAlignment = HorizontalAlignment.Center,
            });
        }
        Attention.Visibility = Visibility.Visible;
        if (clocks.Count == 0)
        {
            attentionClock?.Stop();
            return;
        }
        void Tick()
        {
            foreach (var (text, until) in clocks) text.Text = Left(until);
        }
        Tick();
        if (attentionClock is null)
        {
            attentionClock = new Microsoft.UI.Xaml.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        }
        // One timer, re-pointed at the clocks that are on screen now.
        attentionClock.Tick -= OnAttentionTick;
        attentionTick = Tick;
        attentionClock.Tick += OnAttentionTick;
        attentionClock.Start();
    }

    private Action? attentionTick;

    private void OnAttentionTick(object? sender, object e) => attentionTick?.Invoke();

    private static string Left(DateTimeOffset until)
    {
        var left = until - DateTimeOffset.Now;
        return left <= TimeSpan.Zero ? "หมดเวลา" : $"เหลือ {(int)left.TotalMinutes}:{left.Seconds:00}";
    }

    private FrameworkElement AttentionRow(Mimi.Core.Chat.AttentionItem item, List<(TextBlock Text, DateTimeOffset Until)> clocks)
    {
        var session = app.Session;
        var chat = item.ChatId is { } id ? session.Chats.FirstOrDefault(known => known.Id == id) : null;
        var who = item.Agent.Length > 0 ? session.AgentName(item.Agent) : "Mimi";
        // A direct chat is named after its agent already; a group (or any other chat) adds its title.
        var where = chat is not null && !(chat.Kind == "direct" && chat.AgentNames.Count == 1 && chat.AgentNames[0] == item.Agent) ? $"{who} · {session.ChatTitle(chat)}" : who;
        var open = app.OpenChatId;
        var inThisChat = item.ChatId is { } chatId && open == chatId;
        var text = item.AtPc
            ? $"{where} รออนุญาตที่หน้าจอ {item.PcName ?? "PC"} — {item.Summary}"
            : $"{where} รออนุญาต — {(inThisChat ? "ดูการ์ดในแชตนี้" : item.ChatId is null ? item.Summary : "แตะเพื่อเปิดแชต")}";
        var ink = new Microsoft.UI.Xaml.Media.SolidColorBrush(Windows.UI.Color.FromArgb(0xFF, 0x2A, 0x1D, 0x05));
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var mark = new TextBlock { Text = item.AtPc ? "\uD83D\uDCBB" : "!", FontWeight = Microsoft.UI.Text.FontWeights.Bold, FontSize = 14, Foreground = ink, VerticalAlignment = VerticalAlignment.Center };
        var label = new TextBlock { Text = text, FontSize = 12.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = ink, TextTrimming = TextTrimming.CharacterEllipsis, TextWrapping = TextWrapping.NoWrap, VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(label, 1);
        grid.Children.Add(mark);
        grid.Children.Add(label);
        if (item.ExpiresAt is { } until)
        {
            var clock = new TextBlock { FontSize = 12, Foreground = ink, Opacity = .85, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(clock, 2);
            grid.Children.Add(clock);
            clocks.Add((clock, until));
        }
        var row = new Button
        {
            Content = grid,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Padding = new Thickness(10, 7, 10, 7),
            CornerRadius = new CornerRadius(12),
            Background = Services.Theme.Brush(item.AtPc ? "Info" : "Warn"),
            BorderThickness = new Thickness(0),
        };
        if (item.AtPc) ToolTipService.SetToolTip(row, "ต้องกดอนุญาตที่หน้าจอเครื่อง PC เอง (มือถืออนุญาตแทนไม่ได้) · ถ้าไม่มีใครตอบจะถือว่าไม่อนุญาต");
        AutomationProperties.SetAutomationId(row, item.AtPc ? $"attention-pc-{item.Id}" : $"attention-{item.Id}");
        row.Click += (_, _) =>
        {
            if (item.ChatId is { } target && open != target) app.OpenChat(target);
        };
        return row;
    }

    /// <summary>The unread count on the bell.</summary>
    public void InboxUnread(int unread, string badge)
    {
        InboxBadge.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        InboxCount.Text = badge;
        AutomationProperties.SetName(InboxButton, unread > 0 ? $"การแจ้งเตือน ({unread} ใหม่)" : "การแจ้งเตือน");
    }

    private void OnAgents(object sender, RoutedEventArgs e) => app.ShowManage(Page.Agents);
    private void OnHub(object sender, RoutedEventArgs e) => app.ShowManage(Page.Hub);
    private void OnWorkflows(object sender, RoutedEventArgs e) => app.ShowManage(Page.Workflows);
    private void OnOverseer(object sender, RoutedEventArgs e) => app.ShowManage(Page.Overseer);
    private void OnMimiSettings(object sender, RoutedEventArgs e) => app.ShowManage(Page.MimiSettings);
    private void OnAppSettings(object sender, RoutedEventArgs e) => app.ShowSettings("system");
    private void OnOverseerChat(object sender, RoutedEventArgs e) => _ = app.ChatWithOverseer();
    private void OnSearch(object sender, RoutedEventArgs e) => app.ShowSearch();
    private void OnInbox(object sender, RoutedEventArgs e) => app.ShowInbox();

    private void OnSearchKey(Microsoft.UI.Xaml.Input.KeyboardAccelerator sender, Microsoft.UI.Xaml.Input.KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        if (CurrentPage != Page.Connect) app.ShowSearch();
    }

    private void OnBack(object sender, RoutedEventArgs e) => app.Back();

    /// <summary>Where a dialog opened from a page of the window is shown.</summary>
    internal XamlRoot? DialogRoot => Root.XamlRoot;
    private void OnWorkspace(object sender, RoutedEventArgs e) => app.ShowWorkspace();
    private void OnSetup(object sender, RoutedEventArgs e) => app.ShowSetup();

    /// <summary>The window's content root: the theme is set on it.</summary>
    public FrameworkElement RootElement => Root;
    private void OnChats(object sender, RoutedEventArgs e) => app.ShowChats();
    private void OnSettings(object sender, RoutedEventArgs e) => app.ShowSettings();
}
