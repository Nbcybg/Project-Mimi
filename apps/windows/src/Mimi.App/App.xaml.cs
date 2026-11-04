using System.Diagnostics;
using System.Reflection;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Mimi.App.Audio;
using Mimi.App.Native;
using Mimi.App.Services;
using Mimi.App.Views;
using Mimi.Core;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Net;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;
using Windows.Storage.Pickers;
using ChatView = Mimi.App.Views.ChatView;

namespace Mimi.App;

/// <summary>Runs work on the window's thread.</summary>
internal sealed class WinUiDispatcher(DispatcherQueue queue) : IUiDispatcher
{
    public void Post(Action action)
    {
        if (queue.HasThreadAccess) action();
        else queue.TryEnqueue(() => action());
    }
}

/// <summary>
/// The app: what the Electron app's remote.cjs did, natively. It holds no core and no database — only
/// the server address and choices (config.json) and, while signed in, the session token sealed with
/// DPAPI (session.dpapi). Signing out (in the app, from the tray, by auto-lock, or an expired session)
/// ends the session on the server, stops the PC agent, and wipes the token and the cache.
/// Closing the window hides it; the app lives in the tray.
/// </summary>
public sealed partial class App : Application
{
    public static App? Instance { get; private set; }

    public static string Version { get; } =
        typeof(App).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    private static readonly string? UpdateRepo = typeof(App).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(attribute => attribute.Key == "UpdateRepo")?.Value is { Length: > 0 } repo ? repo : null;

    private readonly AppInstance instance;
    private readonly bool background;
    private readonly AppFolders folders = AppFolders.ForUser();
    private readonly string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private readonly HttpClient http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = TimeSpan.FromMinutes(5) };
    private SessionVault vault = null!;
    private MainWindow window = null!;
    private WinUiDispatcher ui = null!;
    private TrayIcon? tray;
    private Toasts toasts = null!;
    private readonly WindowsPush push = new();
    /// <summary>This computer's WNS channel as the signed-in server knows it.</summary>
    private string? pushChannel;
    private PcAgentHost pc = null!;
    private ConnectViewModel connect = null!;
    private ChatListViewModel chatList = null!;
    private ChatViewModel chat = null!;
    private ChatView chatView = null!;
    private ChatListView chatListView = null!;
    private SettingsView settingsView = null!;
    private SearchView searchView = null!;
    private InboxViewModel inbox = null!;
    private Lookups lookups = null!;
    private StageData stageData = null!;
    private WorkflowEditor workflowEditor = null!;
    private SetupWizard setup = null!;
    private bool setupOffered;
    private Speaker? speaker;
    private readonly Dictionary<Page, ManagePage> managed = [];
    private SavedSession? current;
    private DispatcherQueueTimer? saveTimer;
    private DispatcherQueueTimer? lockTimer;
    private bool windowActive;
    private bool signingOut;
    private bool quitting;
    private bool updating;
    private bool notificationsSynced;

    internal AppConfig Config { get; private set; } = null!;
    /// <summary>The window, for the file pickers of the pages.</summary>
    internal nint WindowHandle => window.Handle;
    internal MimiSession Session { get; private set; } = null!;
    internal Images Images { get; private set; } = null!;
    internal UpdateInfo? PendingUpdate { get; private set; }
    internal string PcStatus => Config.PcAgent.Enabled ? (current is null ? "รอเข้าสู่ระบบ" : pc.Status) : "ปิด";

    public App(AppInstance instance, string[] args)
    {
        Instance = this;
        this.instance = instance;
        // Started by a push while it was not running: into the tray, like a start with Windows.
        background = args.Contains("--background") || IsPushStart();
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            Trace.WriteLine(e.Exception);
            // MIMI_DEBUG_LOG=<file>: the same note for a test that cannot see the screen.
            if (Environment.GetEnvironmentVariable("MIMI_DEBUG_LOG") is { Length: > 0 } file)
            {
                try
                {
                    File.AppendAllText(file, $"{DateTime.Now:HH:mm:ss.fff} unhandled: {e.Exception}\n");
                }
                catch (IOException)
                {
                }
            }
            e.Handled = true;
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            Launch();
        }
        catch (Exception error)
        {
            // A start that fails leaves a note for whoever looks (the window may never appear).
            try
            {
                Directory.CreateDirectory(folders.Cache);
                File.WriteAllText(Path.Combine(folders.Cache, "start-error.txt"), error.ToString());
            }
            catch (IOException)
            {
            }
            throw;
        }
    }

    private void Launch()
    {
        ui = new WinUiDispatcher(DispatcherQueue.GetForCurrentThread());
        // WebView2 (Workspace browser, 3D character, terminal) keeps its profile with the app's other local data,
        // which signing out wipes — not beside Mimi.exe.
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", Path.Combine(folders.Cache, "WebView2"));
        Config = AppConfig.Read(folders.Config, home);
        vault = new SessionVault(folders.Session);
        Session = new MimiSession(http, ui, Version);
        Images = new Images(() => Session.Api);
        toasts = new Toasts();
        toasts.Opened += chatId => ui.Post(() =>
        {
            ShowWindow();
            if (chatId is { } id && current is not null) OpenChat(id);
        });
        toasts.Register();
        push.Received += payload => ui.Post(() => _ = NotificationsFromPush());
        push.Start();
        pc = new PcAgentHost(PcLaunch);
        pc.StatusChanged += _ => ui.Post(RefreshTray);
        pc.Consent += request => ui.Post(() => AskConsent(request));

        window = new MainWindow(this);
        connect = new ConnectViewModel(Session.Api) { CanUseLocal = localLaunch is not null };
        connect.Done += signedIn => ui.Post(() => OnSignedIn(signedIn));
        chatList = new ChatListViewModel(Session);
        chat = new ChatViewModel(Session);
        chatListView = new ChatListView(chatList);
        chatListView.Open += OpenChat;
        chatListView.Navigate += Navigate;
        chatList.OpenRequested += OpenChat;
        chatView = new ChatView(chat, () => window.Handle);
        stageData = new StageData(Session);
        chat.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ChatViewModel.Title)) window.SetTitle(chat.Title);
        };
        chat.Sound += Sounds.Play;
        chat.SpeakRequested += (text, style) =>
        {
            try
            {
                speaker ??= new Speaker();
                _ = speaker.Say(text, style);
            }
            catch (Exception error)
            {
                chat.Error = $"อ่านออกเสียงไม่ได้: {error.Message}";
            }
        };
        settingsView = new SettingsView(this);
        chatView.Attach(this, stageData, folders.Cache);
        var search = new SearchViewModel(Session);
        search.OpenRequested += (chatId, sessionId, messageId) => OpenChat(chatId, sessionId, messageId);
        searchView = new SearchView(search);
        inbox = new InboxViewModel(Session, () => windowActive && window.Showing && window.CurrentPage == Page.Chat && chat.ChatId != 0 ? chat.ChatId : null);
        inbox.OpenRequested += id => OpenChat(id);
        inbox.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(InboxViewModel.Unread)) window.InboxUnread(inbox.Unread, inbox.Badge);
        };
        window.AddPage(Page.Connect, new ConnectView(connect, StartLocalCore));
        window.AddPage(Page.Chats, chatListView);
        window.AddPage(Page.Chat, chatView);
        window.AddPage(Page.Search, searchView);
        window.AddPage(Page.Inbox, new InboxView(inbox));
        lookups = new Lookups(Session);
        foreach (var (page, tabs, id) in new[]
        {
            (Page.Agents, (IReadOnlyList<PageTab>)[Catalog.AgentPage], "AgentsPage"),
            (Page.Hub, Catalog.HubTabs, "HubPage"),
            (Page.Workflows, [Catalog.WorkflowPage], "WorkflowsPage"),
            (Page.Overseer, [Catalog.OverseerPage], "OverseerPage"),
            (Page.MimiSettings, Catalog.SettingsTabs, "MimiSettingsPage"),
        })
        {
            var view = new ManagePage(Session, lookups, () => window.Handle, tabs, id) { ModelCache = Path.Combine(folders.Cache, "models") };
            managed[page] = view;
            window.AddPage(page, view);
        }
        // A workflow opens in the editor (canvas + node forms), not in a form.
        workflowEditor = new WorkflowEditor(Session, lookups);
        window.AddPage(Page.WorkflowEditor, workflowEditor);
        workflowEditor.Closed += () => ShowManage(Page.Workflows);
        managed[Page.Workflows].Opener = (def, row) =>
        {
            if (def.Key != "workflows") return false;
            ShowWorkflowEditor(row?.Item);
            return true;
        };
        setup = new SetupWizard(this, Session, lookups);
        window.AddPage(Page.Setup, setup);
        setup.Closed += ShowChats;
        Session.Raw += (type, json) =>
        {
            // The first start that cannot chat yet opens the wizard once (feature-setup.js), unless it was done on any device.
            if (type != "settings" || setupOffered || current is null || Session.UiValue("mimi.setupDone") == "1") return;
            if (json.TryGetProperty("settings", out var view) && view.TryGetProperty("ready", out var ready) && ready.ValueKind == System.Text.Json.JsonValueKind.False)
            {
                setupOffered = true;
                if (window.CurrentPage is Page.Chats) ShowSetup();
            }
        };
        // Settings as the web has it: the account first, the look of the app, and this computer under "แอปและระบบ".
        managed[Page.MimiSettings].AddSection("profile", SettingsSections.Account(this));
        managed[Page.MimiSettings].AddSection("look", SettingsSections.Appearance(this));
        managed[Page.MimiSettings].AddSection("app", settingsView);
        managed[Page.MimiSettings].AddSection("app", SettingsSections.Credits());
        Session.Raw += (type, json) =>
        {
            // The theme is the account's (mimi.theme, shared by its devices).
            if (type is "welcome" or "ui" && Session.UiValue("mimi.theme") is "light" or "dark" && Session.UiValue("mimi.theme") != Config.Theme)
            {
                Config.Theme = Session.UiValue("mimi.theme")!;
                SaveConfig(later: true);
                ApplyTheme();
            }
        };

        Session.StateChanged += OnSocketState;
        Session.Frame += OnFrame;
        Session.ChatsChanged += RefreshTray;

        tray = new TrayIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Mimi.ico"), BuildMenu);
        tray.Clicked += () => ui.Post(() =>
        {
            if (window.Showing && windowActive) window.Hide();
            else ShowWindow();
        });
        tray.ScreenLocked += () => ui.Post(() =>
        {
            if (current is not null && Config.AutoLockMinutes > 0) _ = SignOut("locked");
        });
        instance.Activated += (_, activation) =>
        {
            if (activation.Kind != ExtendedActivationKind.Push) ui.Post(ShowWindow);
        };

        // Auto-lock: off unless chosen (remote.cjs: checked every 30 s).
        lockTimer = DispatcherQueue.GetForCurrentThread().CreateTimer();
        lockTimer.Interval = TimeSpan.FromSeconds(30);
        lockTimer.Tick += (_, _) =>
        {
            if (current is not null && Config.AutoLockMinutes > 0 && Win32.IdleTime() >= TimeSpan.FromMinutes(Config.AutoLockMinutes)) _ = SignOut("locked");
        };
        lockTimer.Start();

        Start();
        if (!background) ShowWindow();

        if (UpdateRepo is not null)
        {
            var updates = DispatcherQueue.GetForCurrentThread().CreateTimer();
            updates.Interval = TimeSpan.FromHours(6);
            updates.Tick += (_, _) => _ = CheckForUpdate();
            updates.Start();
            _ = Task.Delay(TimeSpan.FromSeconds(30)).ContinueWith(_ => ui.Post(() => _ = CheckForUpdate()), TaskScheduler.Default);
        }
    }

    // ---------- signing in and out ----------

    // ---------- the core on this computer (LocalCore, packages/core/src/app/native-host.ts) ----------

    private readonly LocalCore localCore = new();
    private readonly LocalCore.Launch? localLaunch = LocalCore.Find(AppContext.BaseDirectory, Path.Combine(AppContext.BaseDirectory, "node", "node.exe"));
    private string localAddress = "";

    /// <summary>Starts the core on this computer (once); its address is remembered so signing in to it keeps it starting with the app.</summary>
    internal async Task<LocalCoreReady> StartLocalCore()
    {
        if (localLaunch is null) throw new InvalidOperationException("ชุดติดตั้งนี้ไม่มี core (ใช้ตัวติดตั้งที่มีเซิร์ฟเวอร์ในตัว)");
        var ready = await localCore.Start(localLaunch);
        localAddress = ready.Address;
        return ready;
    }

    /// <summary>The app starts with the core on this computer: start it, then go on with the saved session (or sign in to it again on a new port).</summary>
    private async Task ResumeLocal()
    {
        try
        {
            var ready = await StartLocalCore();
            if (current is not null && current.Server == ready.Address) return; // the socket gets through once the core is up
            ui.Post(() =>
            {
                if (current is not null) Session.End();
                OnSignedIn(new SignedIn(ready.Address, ready.Token, "", Gateway: false, Remember: true, new Health(Ok: true)));
            });
        }
        catch (InvalidOperationException problem)
        {
            ui.Post(() =>
            {
                window.Show(Page.Connect);
                connect.Error = $"เปิดเซิร์ฟเวอร์ในเครื่องนี้ไม่ได้: {problem.Message}";
            });
        }
    }

    private void Start()
    {
        if (Config.LocalServer && localLaunch is not null) _ = ResumeLocal();
        current = Config.Server.Length > 0 ? vault.Load(Config.Server) : null;
        if (current is null)
        {
            // Signed out: no temporary files either (remote.cjs).
            WipeCache();
            window.Show(Page.Connect);
            if (Config.Server.Length > 0) _ = connect.Resume(Config.Server);
            return;
        }
        Begin(current, gateway: current.Username.Length > 0);
    }

    private void Begin(SavedSession session, bool gateway)
    {
        current = session;
        notificationsSynced = false;
        Session.Begin(session.Server, session.Token, session.Username, gateway, coreApi: 0);
        ShowChats();
        StartPcAgent();
        RefreshTray();
    }

    private void OnSignedIn(SignedIn signedIn)
    {
        Config.Server = signedIn.Server;
        // Signing in to the core this app started keeps it starting with the app; another server ends that.
        Config.LocalServer = localAddress.Length > 0 && signedIn.Server == localAddress;
        SaveConfig();
        var session = new SavedSession(signedIn.Server, signedIn.Token, signedIn.Username, signedIn.Remember);
        vault.Store(session);
        Begin(session, signedIn.Gateway);
    }

    /// <summary>
    /// Ends this device's session and wipes what the app kept for it (all but config.json).
    /// <paramref name="then"/>: "signin" (back at the sign-in page), "connect" (choose another server) or "quit".
    /// </summary>
    internal async Task SignOut(string reason, string then = "signin")
    {
        if (signingOut) return;
        signingOut = true;
        try
        {
            var was = current;
            current = null;
            await pc.Stop();
            // Signed out of the core this app runs: it stops and no longer starts with the app.
            if (Config.LocalServer)
            {
                Config.LocalServer = false;
                await localCore.Stop();
            }
            if (pushChannel is { } channel)
            {
                try
                {
                    await Session.Api.UnregisterPush(channel);
                }
                catch (Exception error) when (error is MimiHttpException or HttpRequestException or TaskCanceledException)
                {
                    // the server forgets a channel that stops answering
                }
                pushChannel = null;
            }
            push.Stop();
            if (was is not null && Session.Gateway) await Session.Api.Logout(was.Token);
            Session.End();
            chat.Close();
            inbox.Clear();
            searchView.ViewModel.Clear();
            vault.Clear();
            Images.Clear();
            toasts.Clear();
            WipeCache();
            if (reason == "locked") toasts.Show("Mimi ออกจากระบบแล้ว", "ไม่ได้ใช้งานนานเกินเวลาที่ตั้งไว้ เข้าสู่ระบบใหม่เพื่อใช้ต่อ", null);
            if (reason == "expired") toasts.Show("Mimi ออกจากระบบแล้ว", "การเข้าสู่ระบบหมดอายุหรือถูกยกเลิก เข้าสู่ระบบใหม่เพื่อใช้ต่อ", null);
            if (then == "connect")
            {
                Config.Server = "";
                SaveConfig();
            }
            RefreshTray();
            if (then == "quit")
            {
                Quit();
                return;
            }
            connect.Back();
            window.Show(Page.Connect);
            if (then != "connect" && Config.Server.Length > 0) await connect.Resume(Config.Server);
            if (reason != "locked") ShowWindow();
        }
        finally
        {
            signingOut = false;
        }
    }

    private void WipeCache()
    {
        try
        {
            if (Directory.Exists(folders.Cache)) Directory.Delete(folders.Cache, recursive: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // a file still open goes on the next start
        }
    }

    private void OnSocketState(SocketState state)
    {
        window.Connection(state);
        switch (state)
        {
            case SocketState.SignedOut when current is not null:
                _ = SignOut("expired");
                break;
            case SocketState.Online:
                _ = CatchUpNotifications();
                _ = RegisterPush();
                chat.Visible(window.Showing && window.CurrentPage == Page.Chat);
                break;
        }
        RefreshTray();
    }

    // ---------- notifications (push-and-background.md 1.2: tray + socket until WNS) ----------

    private void OnFrame(ServerFrame frame)
    {
        switch (frame)
        {
            case ServerFrame.Notification note when note.Kind != "info":
                if (note.Id is { } id && id > Config.LastNotificationId)
                {
                    Config.LastNotificationId = id;
                    SaveConfig(later: true);
                }
                // Not for the chat the person is looking at.
                if (!(windowActive && window.CurrentPage == Page.Chat && chat.ChatId == note.ChatId)) toasts.Show(note.Title, MessageFormat.Preview(note.Body, 300), note.ChatId);
                break;
            case ServerFrame.SecurityAlert:
                toasts.Show("Mimi: มีการเข้าสู่ระบบใหม่", "บัญชีนี้เพิ่งเข้าสู่ระบบจากอุปกรณ์อื่น ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่าน", null);
                break;
        }
    }

    private static bool IsPushStart()
    {
        try
        {
            return AppInstance.GetCurrent().GetActivatedEventArgs().Kind == ExtendedActivationKind.Push;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Once per sign-in: when the server (its own keys or the gateway's relay) can push to Windows, make the channel
    /// for its Entra ID app and register it (push-and-background.md 2.2). A server without WNS: nothing changes.
    /// </summary>
    private async Task RegisterPush()
    {
        if (current is null || pushChannel is not null) return;
        try
        {
            var info = await Session.Api.PushInfo();
            if (!info.Wns) return;
            if (!push.Supported) push.Start();
            var channel = await push.Channel(Guid.Parse(info.WnsRemoteId!));
            if (channel is null || current is null) return;
            await Session.Api.RegisterWns(channel, Environment.MachineName, Version);
            pushChannel = channel;
        }
        catch (Exception error) when (error is MimiHttpException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            Trace.WriteLine($"push: {error.Message}");
        }
    }

    /// <summary>A push while the socket is away (asleep, reconnecting): fetch what came and show it; with the socket up its frame already did.</summary>
    private async Task NotificationsFromPush()
    {
        if (current is null || Session.Socket.IsOnline) return;
        Session.Socket.Wake();
        notificationsSynced = false;
        await CatchUpNotifications();
    }

    /// <summary>What came while the socket was gone; the very first time only remembers where things stand.</summary>
    private async Task CatchUpNotifications()
    {
        if (notificationsSynced) return;
        notificationsSynced = true;
        try
        {
            var first = Config.LastNotificationId == 0;
            var items = await Session.Api.NotificationsAfter(Config.LastNotificationId);
            foreach (var item in items)
            {
                if (!first && !item.Read && item.Kind != "info") toasts.Show(item.Title, MessageFormat.Preview(item.Body, 300), item.ChatId);
            }
            if (items.Count > 0) Config.LastNotificationId = Math.Max(Config.LastNotificationId, items.Max(item => item.Id));
            SaveConfig(later: true);
        }
        catch (Exception error) when (error is MimiHttpException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            notificationsSynced = false;
        }
    }

    // ---------- pages ----------

    internal void ShowWindow()
    {
        window.ShowAndFocus();
        if (window.CurrentPage == Page.Chat) chatView.FocusComposer();
    }

    internal void WindowVisibilityChanged(bool visible)
    {
        chat.Visible(visible && window.CurrentPage == Page.Chat);
    }

    internal void WindowActiveChanged(bool active)
    {
        windowActive = active;
        if (active && current is not null) Session.Socket.Wake();
    }

    internal void ShowChats()
    {
        if (window.CurrentPage == Page.Chat) chat.Close();
        chatList.Refresh();
        window.Show(Page.Chats);
        ApplyTheme();
    }

    internal void ShowWorkflowEditor(System.Text.Json.JsonElement? workflow)
    {
        if (current is null) return;
        window.Show(Page.WorkflowEditor, workflow is { } flow && flow.TryGetProperty("title", out var title) && title.GetString() is { Length: > 0 } shown ? shown : "Workflow");
        workflowEditor.Open(workflow);
        ApplyTheme();
    }

    /// <summary>The header's back button: from a page to where it was opened from (the chat list, the workflow list).</summary>
    internal async void Back()
    {
        switch (window.CurrentPage)
        {
            case Page.WorkflowEditor:
                if (!await workflowEditor.CanLeave()) return;
                ShowManage(Page.Workflows);
                managed[Page.Workflows].Refresh();
                break;
            default:
                ShowChats();
                break;
        }
    }

    /// <summary>A page from the chat list's nav.</summary>
    private void Navigate(string key)
    {
        switch (key)
        {
            case "chat":
                ShowChats();
                break;
            case "search":
                ShowSearch();
                break;
            case "overseer":
                _ = ChatWithOverseer();
                break;
            case "agents":
                ShowManage(Page.Agents);
                break;
            case "hub":
                ShowManage(Page.Hub);
                break;
            case "workflows":
                ShowManage(Page.Workflows);
                break;
            case "workspace":
                ShowWorkspace();
                break;
            case "settings":
                ShowSettings();
                break;
        }
    }

    internal void ShowSetup()
    {
        if (current is null) return;
        if (window.CurrentPage == Page.Chat) chat.Close();
        window.Show(Page.Setup);
        setup.Open();
        ApplyTheme();
    }

    /// <summary>The wizard's last step: the direct chat with the agent opens and the test message goes once it is on screen.</summary>
    internal async void StartTestChat(string agent, string text)
    {
        chatList.NewChat(agent);
        for (var tries = 0; tries < 60; tries++)
        {
            await Task.Delay(150);
            if (window.CurrentPage == Page.Chat && chat.ChatId != 0 && chat.Chat?.AgentNames.Contains(agent) == true)
            {
                chat.Draft = text;
                chat.Send();
                return;
            }
        }
        ShowChats();
    }

    private Workspace? workspace;

    /// <summary>The Workspace window: files, a browser and a terminal (packages/desktop/workspace.cjs).</summary>
    internal void ShowWorkspace()
    {
        if (workspace is null)
        {
            workspace = new Workspace(Config, () => SaveConfig(later: true), SendToChat);
            workspace.Closed += (_, _) => workspace = null;
        }
        workspace.Activate();
    }

    /// <summary>
    /// The Workspace's drawing goes to the open chat as an attachment waiting for a caption (main.cjs sendImageToChat);
    /// false when no chat is open.
    /// </summary>
    private async Task<bool> SendToChat(byte[] png, string name)
    {
        if (current is null || chat.ChatId == 0) return false;
        if (window.CurrentPage != Page.Chat) window.Show(Page.Chat);
        ShowWindow();
        await chatView.SendPicture(png, name);
        chatView.FocusComposer();
        return true;
    }

    // ---------- the look (Services/Theme.cs) ----------

    /// <summary>The theme the open chat asks for, or null (the app's).</summary>
    internal string? ChatThemeOverride => window.CurrentPage == Page.Chat && chat.ChatId != 0 ? Config.Look(chat.ChatId).Theme : null;

    internal void ApplyTheme() => Services.Theme.Apply(ChatThemeOverride ?? Config.Theme, window.RootElement, window.AppWindow);

    /// <summary>The chat switched to the full-window character screen (or back): the window header follows.</summary>
    internal void ChatSoloChanged(bool solo) => window.SetChatSolo(solo);

    internal void SetAppTheme(string theme)
    {
        Config.Theme = theme == "light" ? "light" : "dark";
        SaveConfig();
        if (current is not null) Session.SetUi("mimi.theme", Config.Theme);
        ApplyTheme();
    }

    /// <summary>A setting of the look changed (app-wide or the open chat's).</summary>
    internal void LookChanged()
    {
        SaveConfig(later: true);
        ApplyTheme();
        chatView.ApplyLook();
    }

    /// <summary>Opens the direct chat with this agent, starting one when there is none (the web's "ทักแชต").</summary>
    internal void ChatWithAgent(string name) => chatList.NewChat(name);

    internal void OpenChat(long chatId) => OpenChat(chatId, null, null);

    /// <summary>Opens a chat; with a session and message (a search hit) it shows that session scrolled to the message.</summary>
    internal void OpenChat(long chatId, long? sessionId, long? messageId)
    {
        if (current is null) return;
        window.Show(Page.Chat, Session.Chats.FirstOrDefault(item => item.Id == chatId) is { } found ? Session.ChatTitle(found) : "แชต");
        chat.Open(chatId, sessionId, messageId);
        ApplyTheme();
        chatView.ApplyLook();
        chatView.FocusComposer();
    }

    internal void ShowSearch()
    {
        if (current is null) return;
        if (window.CurrentPage == Page.Chat) chat.Close();
        window.Show(Page.Search);
        searchView.FocusField();
    }

    /// <summary>Agent, Hub, Workflow, Overseer or Mimi's settings: the management pages.</summary>
    internal void ShowManage(Page page)
    {
        if (current is null || !managed.TryGetValue(page, out var view)) return;
        if (window.CurrentPage == Page.Chat) chat.Close();
        window.Show(page);
        view.Showing();
        ApplyTheme();
    }

    /// <summary>Opens (or starts) the chat with the AI Overseer, once it has a model.</summary>
    internal async Task ChatWithOverseer()
    {
        if (current is null) return;
        try
        {
            var answer = await Session.Ask(ClientFrames.Simple("overseer-get"), "overseer", "overseer-get");
            var overseer = answer.GetProperty("overseer");
            if (!overseer.TryGetProperty("configured", out var ready) || ready.ValueKind != System.Text.Json.JsonValueKind.True)
            {
                ShowManage(Page.Overseer);
                return;
            }
            chatList.NewChat(overseer.GetProperty("name").GetString() ?? "overseer");
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException or KeyNotFoundException)
        {
            ShowManage(Page.Overseer);
        }
    }

    internal void ShowInbox()
    {
        if (current is null) return;
        if (window.CurrentPage == Page.Chat) chat.Close();
        window.Show(Page.Inbox);
    }

    /// <summary>Settings, at a tab: profile (the account), look, memory or app (this computer, providers…).</summary>
    internal void ShowSettings(string tab = "profile")
    {
        if (current is null) return;
        if (window.CurrentPage == Page.Chat) chat.Close();
        window.Show(Page.MimiSettings);
        settingsView.Refresh();
        managed[Page.MimiSettings].SelectKey(tab);
        ApplyTheme();
    }

    internal void SetOnTop(bool onTop)
    {
        Config.Window.OnTop = onTop;
        window.SetOnTop(onTop);
        SaveConfig();
    }

    internal void SaveConfig(bool later = false)
    {
        void Write()
        {
            try
            {
                Config.Write(folders.Config);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // not being able to remember a window size is no reason to stop
            }
        }
        if (!later)
        {
            saveTimer?.Stop();
            Write();
            return;
        }
        saveTimer ??= DispatcherQueue.GetForCurrentThread().CreateTimer();
        saveTimer.Interval = TimeSpan.FromMilliseconds(400);
        saveTimer.IsRepeating = false;
        saveTimer.Tick -= OnSaveTick;
        saveTimer.Tick += OnSaveTick;
        saveTimer.Start();
    }

    private void OnSaveTick(DispatcherQueueTimer sender, object args) => SaveConfig();

    internal void OpenWeb()
    {
        if (Session.Server is { } server) Process.Start(new ProcessStartInfo(server) { UseShellExecute = true });
    }

    /// <summary>The agent's own browser profile in Edge/Chrome, to sign in to sites by hand (Electron's "เปิดเบราว์เซอร์ของ Mimi").</summary>
    internal void OpenAgentBrowser()
    {
        if (current is null || Config.Server.Length == 0) return;
        var browser = AgentBrowser.Find(Environment.GetEnvironmentVariable, File.Exists);
        if (browser is null)
        {
            toasts.Show("เปิดเบราว์เซอร์ของ Mimi ไม่ได้", "ไม่พบ Edge หรือ Chrome บนเครื่องนี้ (หรือตั้ง MIMI_BROWSER_PATH)", null);
            return;
        }
        var profile = folders.AgentBrowserDir(Config.Server, current.Username);
        Directory.CreateDirectory(profile);
        var start = new ProcessStartInfo(browser) { UseShellExecute = false };
        foreach (var argument in AgentBrowser.Arguments(profile)) start.ArgumentList.Add(argument);
        try
        {
            Process.Start(start);
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            toasts.Show("เปิดเบราว์เซอร์ของ Mimi ไม่ได้", error.Message, null);
        }
    }

    /// <summary>Downloads a chat file into the cache and opens it with its Windows app.</summary>
    internal async Task OpenFile(FileItem file)
    {
        try
        {
            var bytes = await Session.Api.Bytes(file.Path);
            var dir = Path.Combine(folders.Cache, "files");
            Directory.CreateDirectory(dir);
            var safe = string.Concat(file.Name.Split(Path.GetInvalidFileNameChars()));
            var target = Path.Combine(dir, safe.Length > 0 ? safe : "file");
            await File.WriteAllBytesAsync(target, bytes);
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            chat.Error = $"เปิด {file.Name} ไม่ได้: {error.Message}";
        }
    }

    /// <summary>Downloads a server file (a CSV export, a backup) to where the person chooses.</summary>
    internal async Task Download(string path, string name)
    {
        try
        {
            var picker = new FileSavePicker { SuggestedFileName = name };
            var extension = Path.GetExtension(name);
            picker.FileTypeChoices.Add(extension.Length > 0 ? extension : "ไฟล์", [extension.Length > 0 ? extension : ".bin"]);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, window.Handle);
            var target = await picker.PickSaveFileAsync();
            if (target is null) return;
            await File.WriteAllBytesAsync(target.Path, await Session.Api.Bytes(path));
        }
        catch (Exception error)
        {
            chat.Error = $"ดาวน์โหลด {name} ไม่ได้: {error.Message}";
        }
    }

    // ---------- the PC agent ----------

    private PcAgentHost.Launch? PcLaunch()
    {
        if (current is null || Config.Server.Length == 0) return null;
        var usable = Config.PcAgent.Folders.Where(dir => AppConfig.FolderProblem(dir, home) is null).ToList();
        if (usable.Count == 0) return null;
        foreach (var dir in usable) Directory.CreateDirectory(dir);
        var (node, entry) = PcAgentFiles();
        if (entry is null) return null;
        var env = PcAgentHost.AgentEnvironment(
            ServerAddress.WebSocketUrl(Config.Server).ToString(),
            usable,
            Config.PcAgent.Apps,
            Config.PcAgent.Shell,
            folders.AgentBrowserDir(Config.Server, current.Username),
            Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value, StringComparer.OrdinalIgnoreCase));
        return new PcAgentHost.Launch(node, entry, current.Token, env);
    }

    /// <summary>
    /// The packaged app carries node.exe and the PC agent's sources beside Mimi.exe (scripts/build-win-native.mjs);
    /// from the sources, the repository's packages/pc-agent runs with the node on PATH.
    /// </summary>
    private static (string Node, string? Entry) PcAgentFiles()
    {
        var baseDir = AppContext.BaseDirectory;
        var packaged = Path.Combine(baseDir, "pc-agent", "src", "main.ts");
        var bundledNode = Path.Combine(baseDir, "node", "node.exe");
        if (File.Exists(packaged)) return (File.Exists(bundledNode) ? bundledNode : "node", packaged);
        for (var dir = new DirectoryInfo(baseDir); dir is not null; dir = dir.Parent)
        {
            var source = Path.Combine(dir.FullName, "packages", "pc-agent", "src", "main.ts");
            if (File.Exists(source)) return ("node", source);
        }
        return ("node", null);
    }

    private void StartPcAgent()
    {
        if (current is null || !Config.PcAgent.Enabled) return;
        pc.Start();
        RefreshTray();
    }

    /// <summary>The PC agent asks before it changes something on this computer.</summary>
    private void AskConsent(ConsentRequest request)
    {
        var allow = Win32.Ask(
            "Mimi ขออนุญาตบนเครื่องนี้",
            $"{(request.Summary.Length > 0 ? request.Summary : $"Mimi ขอใช้ {request.Tool} บนเครื่องนี้")}\n\nเครื่องมือ: {request.Tool} ({(request.Risk.Length > 0 ? request.Risk : "write")})\n" +
            "คำขอนี้มาจาก Mimi บนเซิร์ฟเวอร์ และจะทำบนเครื่องนี้เท่านั้น อ่านรายละเอียดก่อนกดอนุญาต (Yes = อนุญาต)",
            defaultNo: false);
        pc.Answer(request.Id, allow);
    }

    internal async Task SetPcAgent(bool enabled)
    {
        if (enabled && !Config.PcAgent.Enabled)
        {
            var ok = Win32.Ask("ให้ Mimi ใช้เครื่องนี้?",
                $"agent บนเซิร์ฟเวอร์จะสั่งงานบนเครื่องนี้ได้ในชื่อผู้ใช้ \"{Environment.UserName}\": อ่าน/เขียนไฟล์ในโฟลเดอร์ที่อนุญาต รันคำสั่ง และเปิดเบราว์เซอร์ของ agent " +
                $"(คำสั่งที่เสี่ยงยังต้องให้คุณกดอนุญาตในแชต)\n\nโฟลเดอร์ที่อนุญาต:\n{string.Join("\n", Config.PcAgent.Folders)}");
            if (!ok)
            {
                RefreshTray();
                return;
            }
        }
        Config.PcAgent.Enabled = enabled;
        SaveConfig();
        if (enabled) StartPcAgent();
        else await pc.Stop();
        RefreshTray();
    }

    internal async Task SetPcShell(bool enabled)
    {
        if (enabled && !Win32.Ask("ให้ Mimi รันคำสั่งบนเครื่องนี้?",
                $"คำสั่ง (shell), ปิด/หยุดโปรแกรม, ปิดเครื่อง และ MCP server บนเครื่องนี้ ทำงานด้วยสิทธิ์เต็มของผู้ใช้ \"{Environment.UserName}\" " +
                "ไม่ได้จำกัดอยู่ในโฟลเดอร์ที่อนุญาต (อ่านไฟล์อื่นในโฮมได้) ทุกคำสั่งยังต้องให้คุณกดอนุญาตในแชต"))
        {
            RefreshTray();
            return;
        }
        Config.PcAgent.Shell = enabled;
        SaveConfig();
        await RestartPcAgent();
    }

    private async Task RestartPcAgent()
    {
        if (!pc.Running) return;
        await pc.Stop();
        StartPcAgent();
    }

    internal async Task AddFolder()
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window.Handle);
        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;
        if (AppConfig.FolderProblem(folder.Path, home) is { } problem)
        {
            Win32.Tell("ใช้โฟลเดอร์นี้ไม่ได้", $"{folder.Path}: {problem}");
            return;
        }
        if (!Config.PcAgent.Folders.Contains(folder.Path, StringComparer.OrdinalIgnoreCase)) Config.PcAgent.Folders.Add(folder.Path);
        SaveConfig();
        await RestartPcAgent();
    }

    internal async Task RemoveFolder(string folder)
    {
        if (Config.PcAgent.Folders.Count <= 1)
        {
            Win32.Tell("Mimi", "ต้องมีโฟลเดอร์อย่างน้อยหนึ่งโฟลเดอร์ (เพิ่มโฟลเดอร์ใหม่ก่อนแล้วค่อยเอาอันนี้ออก)");
            return;
        }
        Config.PcAgent.Folders.RemoveAll(dir => string.Equals(dir, folder, StringComparison.OrdinalIgnoreCase));
        SaveConfig();
        await RestartPcAgent();
    }

    // ---------- updates (Desktop/Updater.cs) ----------

    private async Task CheckForUpdate()
    {
        if (UpdateRepo is null || updating) return;
        try
        {
            PendingUpdate = await Updater.FindUpdate(http, UpdateRepo, Version);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            return; // offline or GitHub unreachable: the next check tries again
        }
        RefreshTray();
        if (PendingUpdate is { } update) toasts.Show($"Mimi {update.Version} พร้อมอัปเดต", "เลือก \"อัปเดต\" ที่ไอคอน Mimi หรือในหน้าตั้งค่า", null);
    }

    internal async Task InstallUpdate()
    {
        if (PendingUpdate is not { } update || updating) return;
        if (!Win32.Ask("อัปเดต Mimi", $"อัปเดต Mimi เป็นเวอร์ชัน {update.Version}?\n\nตอนนี้ {Version} · ดาวน์โหลด ~{Math.Round(update.Size / 1048576.0)} MB แล้ว Mimi จะปิดและเปิดใหม่เอง (ยังเข้าสู่ระบบอยู่เหมือนเดิม)", defaultNo: false)) return;
        updating = true;
        RefreshTray();
        try
        {
            var stage = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mimi-update");
            var source = await Updater.Download(http, update, stage);
            var target = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            // A signed app only accepts an update signed by the same publisher.
            await Task.Run(() => Updater.CheckSignature(Environment.ProcessPath!, Path.Combine(source, "Mimi.exe")));
            Updater.StartSwap(source, target, stage);
            Quit();
        }
        catch (Exception error)
        {
            updating = false;
            RefreshTray();
            Win32.Tell("อัปเดต Mimi ไม่สำเร็จ", $"{error.Message}\n\nลองใหม่ภายหลัง หรือดาวน์โหลดเองจากหน้า Releases ของ Mimi บน GitHub", error: true);
        }
    }

    // ---------- the tray ----------

    private void RefreshTray()
    {
        chatListView?.PcAgent(Session.PcOnline, Config.PcAgent.Enabled ? pc.Status : "ไม่ได้เชื่อมต่อ");
        if (tray is null) return;
        var unread = Session.Chats.Count(item => item.Unread);
        tray.Tip = current is null ? "Mimi" : $"Mimi{(current.Username.Length > 0 ? $" · {current.Username}" : "")}{(unread > 0 ? $" · ยังไม่อ่าน {unread}" : "")}";
    }

    private IReadOnlyList<TrayItem> BuildMenu()
    {
        var signedIn = current is not null;
        var items = new List<TrayItem>();
        if (PendingUpdate is { } update)
        {
            items.Add(new TrayItem(updating ? $"กำลังอัปเดตเป็น {update.Version}…" : $"⬆ อัปเดตเป็น {update.Version}", () => ui.Post(() => _ = InstallUpdate()), Enabled: !updating));
            items.Add(TrayItem.Separator);
        }
        items.Add(new TrayItem("เปิด Mimi", () => ui.Post(ShowWindow)));
        if (signedIn)
        {
            items.Add(new TrayItem("ตั้งค่า", () => ui.Post(() =>
            {
                ShowWindow();
                ShowSettings("app");
            })));
            items.Add(new TrayItem("เปิดเบราว์เซอร์ของ Mimi", () => ui.Post(OpenAgentBrowser)));
            items.Add(new TrayItem("Workspace", () => ui.Post(ShowWorkspace)));
        }
        items.Add(TrayItem.Separator);
        items.Add(new TrayItem("ให้ Mimi ใช้เครื่องนี้ (PC agent)", () => ui.Post(() => _ = SetPcAgent(!Config.PcAgent.Enabled)), Checked: Config.PcAgent.Enabled));
        items.Add(new TrayItem($"   สถานะ: {PcStatus}", Enabled: false));
        items.Add(new TrayItem("อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)", () => ui.Post(() => _ = SetPcShell(!Config.PcAgent.Shell)), Checked: Config.PcAgent.Shell, Enabled: Config.PcAgent.Enabled));
        items.Add(new TrayItem("ออกจากระบบอัตโนมัติ", Children: AppConfig.LockChoices.Select(minutes => new TrayItem(
            minutes == 0 ? "ปิด" : $"ไม่ได้ใช้ {minutes} นาที",
            () => ui.Post(() =>
            {
                Config.AutoLockMinutes = minutes;
                SaveConfig();
            }),
            Checked: Config.AutoLockMinutes == minutes,
            Radio: true)).ToList()));
        items.Add(TrayItem.Separator);
        items.Add(new TrayItem("ซ่อนเมื่อคลิกที่อื่น", () => ui.Post(() =>
        {
            Config.Window.HideOnBlur = !Config.Window.HideOnBlur;
            SaveConfig();
        }), Checked: Config.Window.HideOnBlur));
        items.Add(new TrayItem("อยู่บนสุดเสมอ", () => ui.Post(() => SetOnTop(!Config.Window.OnTop)), Checked: Config.Window.OnTop));
        items.Add(TrayItem.Separator);
        if (Config.Server.Length > 0) items.Add(new TrayItem("เปลี่ยนเซิร์ฟเวอร์…", () => ui.Post(() => _ = SignOut("server", then: "connect"))));
        if (signedIn) items.Add(new TrayItem("ออกจากระบบ", () => ui.Post(() => _ = SignOut("logout"))));
        items.Add(new TrayItem("ออกจาก Mimi", () => ui.Post(() => _ = QuitAsked())));
        return items;
    }

    /// <summary>"Not my device": nothing of the session outlives the app.</summary>
    private async Task QuitAsked()
    {
        if (current is not null && !current.Remember)
        {
            await SignOut("quit", then: "quit");
            return;
        }
        Quit();
    }

    private void Quit()
    {
        if (quitting) return;
        quitting = true;
        lockTimer?.Stop();
        _ = pc.Stop();
        // Closing its stdin stops the core this app started (a Mimi that was already running stays).
        _ = localCore.Stop();
        speaker?.Dispose();
        Session.Dispose();
        tray?.Dispose();
        tray = null;
        toasts.Dispose();
        window.Quit();
        Exit();
    }
}
