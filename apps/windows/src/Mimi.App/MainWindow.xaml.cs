using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Views;
using Mimi.Core.Desktop;
using Mimi.Core.Net;
using Windows.Graphics;

namespace Mimi.App;

public enum Page
{
    Connect,
    Chats,
    Chat,
    Music,
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
        Header.Visibility = page is Page.Connect or Page.Setup ? Visibility.Collapsed : Visibility.Visible;
        // The chat list is the home (the web's side panel); every other page goes back to it.
        BackButton.Visibility = page == Page.Chats ? Visibility.Collapsed : Visibility.Visible;
        Logo.Visibility = page == Page.Chats ? Visibility.Visible : Visibility.Collapsed;
        ConnText.Visibility = page == Page.Chats ? Visibility.Visible : Visibility.Collapsed;
        Dot.Visibility = page == Page.Chats ? Visibility.Collapsed : Visibility.Visible;
        ChatsButton.Visibility = page is Page.Chats or Page.Chat ? Visibility.Collapsed : Visibility.Visible;
        TitleText.Text = title ?? page switch
        {
            Page.Chats => "Mimi",
            Page.Music => "Mimiamp",
            Page.Settings => "ตั้งค่า",
            Page.Search => "ค้นหา",
            Page.Inbox => "การแจ้งเตือน",
            Page.Agents => "Agent",
            Page.Hub => "Hub",
            Page.Workflows => "Workflow",
            Page.Overseer => "AI Overseer",
            Page.MimiSettings => "ตั้งค่า",
            Page.WorkflowEditor => "Workflow",
            _ => "Mimi",
        };
        MiniVisible();
    }

    public void SetTitle(string title)
    {
        if (CurrentPage == Page.Chat) TitleText.Text = title.Length > 0 ? title : "แชต";
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

    public void MiniVisible()
    {
        var music = app.Music;
        MiniPlayer.Visibility = music is not null && music.HasNowPlaying && CurrentPage is not (Page.Music or Page.Connect) ? Visibility.Visible : Visibility.Collapsed;
        if (music is null) return;
        MiniTitle.Text = music.NowTitle;
        MiniPlay.Content = music.PlayGlyph;
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
    private void OnAppSettings(object sender, RoutedEventArgs e) => app.ShowSettings("app");
    private void OnOverseerChat(object sender, RoutedEventArgs e) => _ = app.ChatWithOverseer();
    private void OnSearch(object sender, RoutedEventArgs e) => app.ShowSearch();
    private void OnInbox(object sender, RoutedEventArgs e) => app.ShowInbox();

    private void OnSearchKey(Microsoft.UI.Xaml.Input.KeyboardAccelerator sender, Microsoft.UI.Xaml.Input.KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        if (CurrentPage != Page.Connect) app.ShowSearch();
    }

    private void OnBack(object sender, RoutedEventArgs e) => app.Back();
    private void OnWorkspace(object sender, RoutedEventArgs e) => app.ShowWorkspace();
    private void OnSetup(object sender, RoutedEventArgs e) => app.ShowSetup();

    /// <summary>The window's content root: the theme is set on it.</summary>
    public FrameworkElement RootElement => Root;
    private void OnChats(object sender, RoutedEventArgs e) => app.ShowChats();
    private void OnMusic(object sender, RoutedEventArgs e) => app.ShowMusic();
    private void OnSettings(object sender, RoutedEventArgs e) => app.ShowSettings();
    private void OnMiniTapped(object sender, Microsoft.UI.Xaml.Input.TappedRoutedEventArgs e) => app.ShowMusic();
    private void OnMiniPlay(object sender, RoutedEventArgs e) => _ = app.Music?.Toggle();
    private void OnMiniNext(object sender, RoutedEventArgs e) => _ = app.Music?.Next();
}
