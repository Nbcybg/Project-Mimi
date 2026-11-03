using System.Diagnostics;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Controls;
using Mimi.Core;
using Mimi.Core.Hub;
using Windows.Storage.Pickers;

namespace Mimi.App.Views;

/// <summary>
/// A management page of the web client (Agent, Hub, Workflow, Overseer, Mimi's settings) done natively:
/// tabs across the top like the web's, each tab a stack of lists (<see cref="EntityDef"/>); an item opens
/// in a form, and its actions (run, test, connect, upload…) sit under the form.
/// </summary>
public sealed partial class ManagePage : UserControl
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly MimiSession session;
    private readonly Lookups lookups;
    private readonly Func<nint> window;
    private readonly IReadOnlyList<PageTab> tabs;
    private readonly Dictionary<string, (FrameworkElement View, List<EntityList> Lists)> built = [];
    private readonly StackPanel tabBar = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
    private readonly ContentControl body = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly Dictionary<string, List<FrameworkElement>> extras = [];
    private PageTab current;
    private bool dialogOpen;

    /// <summary>A native section shown above the lists of a tab (account, this computer, the look of the app).</summary>
    public void AddSection(string tabKey, FrameworkElement section)
    {
        if (!extras.TryGetValue(tabKey, out var list)) extras[tabKey] = list = [];
        list.Add(section);
    }

    /// <summary>Opens an item (or a new one: row null) somewhere else than the form (the workflow editor); true = handled.</summary>
    public Func<EntityDef, EntityRow?, bool>? Opener { get; set; }

    /// <summary>Asks the open tab's lists again.</summary>
    public void Refresh() => Reload();

    /// <summary>Opens a tab by its key.</summary>
    public void SelectKey(string key)
    {
        if (tabs.FirstOrDefault(tab => tab.Key == key) is { } tab) current = tab;
        Showing();
    }

    public ManagePage(MimiSession session, Lookups lookups, Func<nint> window, IReadOnlyList<PageTab> tabs, string id)
    {
        this.session = session;
        this.lookups = lookups;
        this.window = window;
        this.tabs = tabs;
        current = tabs[0];
        AutomationProperties.SetAutomationId(this, id);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        if (tabs.Count > 1)
        {
            var scroller = new ScrollViewer
            {
                Content = tabBar,
                HorizontalScrollMode = ScrollMode.Enabled,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden,
                VerticalScrollMode = ScrollMode.Disabled,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Padding = new Thickness(10, 6, 10, 4),
            };
            foreach (var tab in tabs)
            {
                var button = new ToggleButton { Content = tab.Label, Tag = tab, Style = (Style)Application.Current.Resources["MimiPill"] };
                ToolTipService.SetToolTip(button, tab.Lead);
                AutomationProperties.SetAutomationId(button, $"tab-{tab.Key}");
                // Checked, not Click: UI Automation toggles too. The tab on screen stays checked.
                button.Checked += (_, _) =>
                {
                    if (!ReferenceEquals(current, button.Tag)) Select((PageTab)button.Tag);
                };
                button.Unchecked += (_, _) =>
                {
                    if (ReferenceEquals(current, button.Tag)) button.IsChecked = true;
                };
                tabBar.Children.Add(button);
            }
            root.Children.Add(scroller);
        }
        Grid.SetRow(body, 1);
        root.Children.Add(body);
        Content = root;
        session.StateChanged += state =>
        {
            if (state is Mimi.Core.Net.SocketState.Online && Visibility == Visibility.Visible) Reload();
        };
    }

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    /// <summary>The page came on screen: show the tab and ask for its lists.</summary>
    public void Showing() => Select(current);

    public void Select(PageTab tab)
    {
        current = tab;
        foreach (var button in tabBar.Children.OfType<ToggleButton>()) button.IsChecked = ReferenceEquals(button.Tag, tab);
        if (!built.TryGetValue(tab.Key, out var page))
        {
            page = Build(tab);
            built[tab.Key] = page;
        }
        body.Content = page.View;
        Reload();
    }

    private void Reload()
    {
        if (!built.TryGetValue(current.Key, out var page)) return;
        // One question per frame type: several lists may come from the same reply.
        foreach (var load in page.Lists.Select(list => list.Def.Load).Where(load => load is not null).Distinct()) session.Send(load!);
    }

    private (FrameworkElement, List<EntityList>) Build(PageTab tab)
    {
        var stack = new StackPanel { Spacing = 18, Padding = new Thickness(12, 6, 12, 24) };
        if (tabs.Count > 1 || tab.Lists.Count > 1) stack.Children.Add(new TextBlock { Text = tab.Lead, FontSize = 12, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap });
        if (extras.TryGetValue(tab.Key, out var sections))
        {
            foreach (var section in sections) stack.Children.Add(section);
        }
        var lists = new List<EntityList>();
        foreach (var def in tab.Lists)
        {
            var list = new EntityList(session, def);
            lists.Add(list);
            stack.Children.Add(ListView(list, showLead: tab.Lists.Count > 1 || tabs.Count == 1));
        }
        return (new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, lists);
    }

    // ---------- one list ----------

    private FrameworkElement ListView(EntityList list, bool showLead)
    {
        var def = list.Def;
        var panel = new StackPanel { Spacing = 6 };
        var head = new Grid { ColumnSpacing = 6 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new TextBlock { Text = def.Label, FontSize = 16, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInkBrush"), VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap });
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        Grid.SetColumn(tools, 1);
        head.Children.Add(tools);
        if (def.New is not null)
        {
            var add = new Button { Content = "+ เพิ่ม", Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            AutomationProperties.SetAutomationId(add, $"add-{def.Key}");
            add.Click += (_, _) => Safe(list, Edit(list, null));
            tools.Children.Add(add);
        }
        var pageActions = def.Actions?.Where(action => !action.ForItem).ToList() ?? [];
        if (pageActions.Count > 0)
        {
            var more = new DropDownButton { Content = "ทำ…" };
            var menu = new MenuFlyout();
            foreach (var action in pageActions)
            {
                var entry = new MenuFlyoutItem { Text = action.Label };
                entry.Click += (_, _) => Safe(list, Run(list, action, default));
                menu.Items.Add(entry);
            }
            more.Flyout = menu;
            tools.Children.Add(more);
        }
        var refresh = new Button { Content = "", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), Padding = new Thickness(8, 5, 8, 5) };
        ToolTipService.SetToolTip(refresh, "โหลดใหม่");
        AutomationProperties.SetName(refresh, $"โหลด {def.Label} ใหม่");
        refresh.Click += (_, _) => list.Refresh();
        tools.Children.Add(refresh);
        panel.Children.Add(head);
        if (showLead && def.Lead.Length > 0) panel.Children.Add(new TextBlock { Text = def.Lead, FontSize = 12, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap });

        var error = new TextBlock { FontSize = 12, Foreground = Brush("MimiBadBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var note = new TextBlock { FontSize = 12, Foreground = Brush("MimiOkBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        panel.Children.Add(error);
        panel.Children.Add(note);
        var rows = new ItemsControl();
        AutomationProperties.SetAutomationId(rows, $"list-{def.Key}");
        panel.Children.Add(rows);
        var empty = new TextBlock { Text = "ยังไม่มีรายการ", FontSize = 12, Foreground = Brush("MimiFaintBrush"), Visibility = Visibility.Collapsed };
        panel.Children.Add(empty);

        void Paint()
        {
            rows.Items.Clear();
            foreach (var row in list.Rows) rows.Items.Add(RowButton(list, row));
            empty.Visibility = list.Empty ? Visibility.Visible : Visibility.Collapsed;
        }
        list.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(EntityList.Error))
            {
                error.Text = list.Error;
                error.Visibility = list.Error.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            }
            else if (e.PropertyName == nameof(EntityList.Note))
            {
                note.Text = list.Note;
                note.Visibility = list.Note.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            }
            else if (e.PropertyName == nameof(EntityList.Version))
            {
                Paint();
            }
        };
        return new Border { Background = Brush("MimiPanelBrush"), BorderBrush = Brush("MimiLineBrush"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 10, 12, 12), Child = panel };
    }

    private Button RowButton(EntityList list, EntityRow row)
    {
        var text = new StackPanel { Spacing = 2 };
        text.Children.Add(new TextBlock { Text = row.Title, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInkBrush"), TextTrimming = TextTrimming.CharacterEllipsis });
        if (row.Subtitle.Length > 0) text.Children.Add(new TextBlock { Text = row.Subtitle, FontSize = 12, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis });
        var button = new Button
        {
            Content = text,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(10, 7, 10, 7),
            Margin = new Thickness(0, 0, 0, 4),
            Background = Brush("MimiRaisedBrush"),
        };
        AutomationProperties.SetName(button, row.Title);
        button.Click += (_, _) => Safe(list, Edit(list, row));
        return button;
    }

    // ---------- dialogs ----------

    /// <summary>One ContentDialog at a time: a dialog opened right after another waits until that one has closed.</summary>
    private async Task<ContentDialogResult> ShowDialog(ContentDialog dialog)
    {
        for (var tries = 0; dialogOpen && tries < 50; tries++) await Task.Delay(50);
        dialogOpen = true;
        try
        {
            dialog.XamlRoot = XamlRoot;
            dialog.RequestedTheme = Services.Theme.Element;
            for (var tries = 0; ; tries++)
            {
                try
                {
                    Log($"show dialog {dialog.Title} (try {tries})");
                    var shown = await dialog.ShowAsync();
                    Log($"dialog {dialog.Title} -> {shown}");
                    return shown;
                }
                catch (Exception error) when (tries < 20)
                {
                    Log($"dialog {dialog.Title} failed: {error.Message}");
                    // the last dialog is still closing
                    await Task.Delay(100);
                }
            }
        }
        finally
        {
            dialogOpen = false;
        }
    }

    /// <summary>MIMI_DEBUG_LOG=<file>: the steps of the dialogs, for tests that cannot see the screen.</summary>
    private static void Log(string text)
    {
        if (Environment.GetEnvironmentVariable("MIMI_DEBUG_LOG") is { Length: > 0 } file) File.AppendAllText(file, $"{DateTime.Now:HH:mm:ss.fff} {text}\n");
    }

    /// <summary>Runs a dialog flow; what goes wrong shows on the list instead of vanishing.</summary>
    private static async void Safe(EntityList list, Task work)
    {
        try
        {
            await work;
        }
        catch (Exception problem)
        {
            Log($"flow failed: {problem}");
            list.Error = problem.Message;
        }
    }

    private static ScrollViewer Scroll(UIElement content) => new() { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 560, Padding = new Thickness(0, 0, 12, 0) };

    private async Task<bool> Confirm(string text)
    {
        var dialog = new ContentDialog { Title = "ยืนยัน", Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap }, PrimaryButtonText = "ตกลง", CloseButtonText = "ยกเลิก", DefaultButton = ContentDialogButton.Close };
        return await ShowDialog(dialog) == ContentDialogResult.Primary;
    }

    private async Task Tell(string title, string text)
    {
        // A selectable TextBlock: copyable, and screen readers (and UI tests) read it, which a read-only TextBox does not offer.
        var box = new TextBlock
        {
            Text = text,
            IsTextSelectionEnabled = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
        };
        await ShowDialog(new ContentDialog { Title = title, Content = Scroll(box), CloseButtonText = "ปิด" });
    }

    /// <summary>What an action answered, readable (Controls/ResultView.cs), the JSON folded under it.</summary>
    private async Task Show(string title, string type, JsonElement reply)
    {
        var view = ResultView.Build(type, reply);
        await ShowDialog(new ContentDialog { Title = title, Content = Scroll(view), CloseButtonText = "ปิด" });
    }

    /// <summary>An item in a form: save, delete, and its actions (the form closes first; one dialog at a time).</summary>
    private async Task Edit(EntityList list, EntityRow? row)
    {
        var def = list.Def;
        if (Opener?.Invoke(def, row) == true) return;
        var item = row is null ? def.New!() : row.Item.Obj();
        if (row is not null && row.Item.ValueKind == JsonValueKind.String) item = J.O(("name", JsonValue.Create(row.Item.GetString())));
        var form = new JsonForm(item, def.Fields, lookups);
        var content = new StackPanel { Spacing = 12 };
        content.Children.Add(form);
        EntityAction? chosen = null;
        var dialog = new ContentDialog
        {
            Title = row is null ? $"เพิ่ม: {def.Label}" : row.Title,
            CloseButtonText = "ปิด",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (def.Save is not null) dialog.PrimaryButtonText = "บันทึก";
        if (def.Delete is not null && row is not null && !def.Single) dialog.SecondaryButtonText = "ลบ";
        var actions = row is null ? [] : def.Actions?.Where(action => action.ForItem && (action.When?.Invoke(row.Item) ?? true)).ToList() ?? [];
        if (actions.Count > 0)
        {
            var bar = new StackPanel { Spacing = 6 };
            bar.Children.Add(new TextBlock { Text = "ทำกับรายการนี้", FontSize = 12, Foreground = Brush("MimiMutedBrush") });
            foreach (var action in actions)
            {
                var button = new Button { Content = action.Label, Margin = new Thickness(0, 0, 6, 6) };
                button.Click += (_, _) =>
                {
                    chosen = action;
                    dialog.Hide();
                };
                bar.Children.Add(button);
            }
            content.Children.Add(bar);
        }
        dialog.Content = Scroll(content);
        dialog.PrimaryButtonClick += (_, args) =>
        {
            if (form.Problems.Count > 0)
            {
                args.Cancel = true;
                list.Error = $"แก้ JSON ก่อน: {string.Join(", ", form.Problems)}";
            }
        };
        var result = await ShowDialog(dialog);
        if (result == ContentDialogResult.Primary && def.Save is not null)
        {
            list.Save(item, row?.Id);
            list.Note = "กำลังบันทึก…";
            return;
        }
        if (result == ContentDialogResult.Secondary && row is not null)
        {
            if (await Confirm($"ลบ \"{row.Title}\"?")) list.Delete(row);
            return;
        }
        if (chosen is not null && row is not null)
        {
            await Task.Delay(150); // the form closes first
            await Run(list, chosen, row.Item);
        }
    }

    /// <summary>Runs an action: questions, confirmation, then a frame (and its answer), an upload, a download or a delete.</summary>
    private async Task Run(EntityList list, EntityAction action, JsonElement item)
    {
        Log($"run {action.Label}");
        var input = new JsonObject();
        if (action.Ask is { Count: > 0 })
        {
            var form = new JsonForm(input, action.Ask, lookups);
            var ask = new ContentDialog { Title = action.Label, Content = Scroll(form), PrimaryButtonText = "ตกลง", CloseButtonText = "ยกเลิก", DefaultButton = ContentDialogButton.Primary };
            if (await ShowDialog(ask) != ContentDialogResult.Primary) return;
        }
        if (action.Confirm is { } question && !await Confirm(question)) return;
        list.Error = "";
        if (action.View == "graph")
        {
            var graph = WorkflowGraph.Create(item, Math.Max(320, ActualWidth - 60), Math.Max(360, ActualHeight - 220));
            await ShowDialog(new ContentDialog { Title = action.Label, Content = graph, CloseButtonText = "ปิด" });
            return;
        }
        try
        {
            if (action.UploadPath is { } upload)
            {
                var picker = new FileOpenPicker();
                WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
                if (action.UploadFilter == "image")
                {
                    foreach (var extension in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif" }) picker.FileTypeFilter.Add(extension);
                }
                else picker.FileTypeFilter.Add(action.UploadFilter ?? "*");
                var file = await picker.PickSingleFileAsync();
                if (file is null) return;
                await using var stream = await file.OpenStreamForReadAsync();
                list.Note = "กำลังอัปโหลด…";
                var path = upload(item, input);
                if (path.EndsWith("name=", StringComparison.Ordinal)) path += Uri.EscapeDataString(file.Name);
                var uploaded = await session.Api.SendBody(HttpMethod.Post, path, stream, string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType);
                list.Note = $"อัปโหลด {file.Name} แล้ว";
                // An uploaded file may go on into a frame (a knowledge document takes the attachment id).
                if (uploaded.ValueKind == JsonValueKind.Object && uploaded.TryGetProperty("id", out var uploadedId) && uploadedId.ValueKind == JsonValueKind.String)
                {
                    input["attachmentId"] = uploadedId.GetString();
                    if (action.Frame(item, input) is { } next)
                    {
                        if (action.Reply is null) session.Send(next);
                        else
                        {
                            var nextType = JsonDocument.Parse(next).RootElement.GetProperty("type").GetString();
                            var reply = await session.Ask(next, action.Reply, nextType, timeout: TimeSpan.FromMinutes(3));
                            await Show(action.Label, action.Reply, reply);
                        }
                    }
                }
                list.Refresh();
                return;
            }
            if (action.DeletePath is { } remove)
            {
                await session.Api.SendBody(HttpMethod.Delete, remove(item));
                list.Note = "ลบแล้ว";
                list.Refresh();
                return;
            }
            if (action.DownloadPath is { } download)
            {
                var (path, name) = download(item);
                var picker = new FileSavePicker { SuggestedFileName = name };
                var extension = Path.GetExtension(name);
                picker.FileTypeChoices.Add(extension.Length > 0 ? extension : "ไฟล์", [extension.Length > 0 ? extension : ".bin"]);
                WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
                var target = await picker.PickSaveFileAsync();
                if (target is null) return;
                list.Note = "กำลังดาวน์โหลด…";
                var bytes = await session.Api.Bytes(path);
                await File.WriteAllBytesAsync(target.Path, bytes);
                list.Note = $"บันทึกที่ {target.Path} แล้ว";
                return;
            }
            if (action.PostPath is { } post || action.GetPath is not null)
            {
                list.Note = "กำลังทำ…";
                var reply = action.PostPath is { } target2
                    ? await session.Api.PostJson(target2, input)
                    : await session.Api.SendBody(HttpMethod.Get, action.GetPath!);
                list.Note = "เสร็จแล้ว";
                if (reply.ValueKind == JsonValueKind.Undefined) await Tell(action.Label, "เรียบร้อย");
                else await Show(action.Label, "", reply);
                return;
            }
            var frame = action.Frame(item, input);
            if (frame is null) return;
            var type = JsonDocument.Parse(frame).RootElement.GetProperty("type").GetString();
            if (action.Reply is null)
            {
                session.Send(frame);
                list.Note = "ส่งแล้ว";
                return;
            }
            list.Note = "กำลังทำ…";
            Log($"ask {frame}");
            var answer = await session.Ask(frame, action.Reply, type, timeout: TimeSpan.FromMinutes(3));
            Log($"answer {answer.GetRawText()[..Math.Min(300, answer.GetRawText().Length)]}");
            list.Note = "";
            if (answer.TryGetProperty("url", out var url) && url.GetString() is { } link && Uri.TryCreate(link, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http")
            {
                Process.Start(new ProcessStartInfo(link) { UseShellExecute = true });
                list.Note = "เปิดหน้าเข้าสู่ระบบในเบราว์เซอร์แล้ว — ทำต่อในเบราว์เซอร์ แล้วกดโหลดใหม่";
                return;
            }
            await Show(action.Label, action.Reply, answer);
            list.Refresh();
        }
        catch (Exception problem)
        {
            Log($"action failed: {problem}");
            list.Note = "";
            list.Error = $"{action.Label}: {problem.Message}";
        }
    }
}
