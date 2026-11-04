using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Microsoft.Web.WebView2.Core;
using Mimi.App.Controls;
using Mimi.App.Native;
using Mimi.App.Services;
using Mimi.Core.Desktop;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;

namespace Mimi.App.Views;

/// <summary>
/// Mimi Workspace (packages/desktop/workspace.*): a window of its own with the files of a folder (tree + a
/// text editor), a browser (WebView2, with drawing on a picture of the page) and a terminal (ConPTY + xterm.js).
/// Everything stays on this computer; the folder is remembered in config.json.
/// </summary>
internal sealed partial class Workspace : Window
{
    private const int MaxFile = 1_500_000;
    private const int MaxEntries = 2000;
    private readonly AppConfig config;
    private readonly Action save;
    private readonly TextBlock rootText = new() { FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TreeView tree = new() { SelectionMode = TreeViewSelectionMode.None, CanDragItems = false, CanReorderItems = false };
    private readonly TextBox filter = new() { PlaceholderText = "กรองชื่อไฟล์…", FontSize = 12, MinWidth = 90 };
    private readonly TextBlock fileName = new() { Text = "ไฟล์ที่เปิดจะแสดงที่นี่", FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBox editor = new() { AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, IsSpellCheckEnabled = false, Visibility = Visibility.Collapsed };
    private readonly TextBlock saved = new() { FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
    private readonly WebView2 browser = new();
    private readonly TextBox url = new() { PlaceholderText = "พิมพ์ URL หรือคำค้น", IsSpellCheckEnabled = false };
    private readonly WebView2 terminal = new();
    private readonly TextBlock termStatus = new() { FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid annotate = new() { Visibility = Visibility.Collapsed };
    private readonly Image shot = new() { Stretch = Stretch.Uniform };
    private readonly Canvas ink = new() { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
    private readonly Grid picture = new();
    private bool crlf;
    private string root = "";
    private string? openFile;
    private ConPty? shell;
    private (int Cols, int Rows) size = (100, 30);
    private Polyline? stroke;
    private Windows.UI.Color pen = Windows.UI.Color.FromArgb(255, 240, 70, 110);

    private readonly Func<byte[], string, Task<bool>>? sendToChat;

    public Workspace(AppConfig config, Action save, Func<byte[], string, Task<bool>>? sendToChat = null)
    {
        this.config = config;
        this.save = save;
        this.sendToChat = sendToChat;
        Title = "Mimi Workspace";
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "Mimi.ico"));
        var area = DisplayArea.Primary.WorkArea;
        AppWindow.Resize(new SizeInt32(Math.Min(1380, area.Width - 40), Math.Min(860, area.Height - 40)));
        AppWindow.TitleBar.PreferredTheme = Theme.Current == "light" ? TitleBarTheme.Light : TitleBarTheme.Dark;

        var top = new Grid { Padding = new Thickness(12, 8, 12, 8), ColumnSpacing = 10, Background = Theme.Brush("Panel"), BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 0, 0, 1) };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var brand = Ui.Row(8, new Border
        {
            Width = 24,
            Height = 24,
            CornerRadius = new CornerRadius(7),
            Background = Theme.Brush("Accent"),
            Child = new TextBlock { Text = "M", Foreground = new SolidColorBrush(Microsoft.UI.Colors.White), FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
        }, new TextBlock { Text = "Mimi Workspace", FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        top.Children.Add(brand);
        var choose = Ui.Button("เลือกโฟลเดอร์", () => _ = ChooseRoot(), "ghost", "WorkspaceRoot");
        Grid.SetColumn(choose, 1);
        Grid.SetColumn(rootText, 2);
        rootText.Foreground = Theme.Brush("Muted");
        top.Children.Add(choose);
        top.Children.Add(rootText);

        var layout = new Grid { ColumnSpacing = 0 };
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 220 });
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star), MinWidth = 320 });
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.4, GridUnitType.Star), MinWidth = 260 });
        var files = FilesPane();
        var web = BrowserPane();
        var term = TerminalPane();
        Grid.SetColumn(web, 1);
        Grid.SetColumn(term, 2);
        layout.Children.Add(files);
        layout.Children.Add(web);
        layout.Children.Add(term);

        var page = new Grid { Background = Theme.Brush("Bg"), RequestedTheme = Theme.Element };
        page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        page.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(layout, 1);
        page.Children.Add(top);
        page.Children.Add(layout);
        page.KeyboardAccelerators.Add(Accelerator(Windows.System.VirtualKey.S, () => _ = SaveFile()));
        Content = page;
        Closed += (_, _) =>
        {
            shell?.Dispose();
            shell = null;
        };
        root = Directory.Exists(config.WorkspaceRoot) ? config.WorkspaceRoot : config.PcAgent.Folders.FirstOrDefault(Directory.Exists) ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        ShowRoot();
        _ = StartBrowser();
        _ = StartTerminal();
    }

    private static KeyboardAccelerator Accelerator(Windows.System.VirtualKey key, Action act)
    {
        var accelerator = new KeyboardAccelerator { Key = key, Modifiers = Windows.System.VirtualKeyModifiers.Control };
        accelerator.Invoked += (_, args) =>
        {
            args.Handled = true;
            act();
        };
        return accelerator;
    }

    private static Border Pane(string title, UIElement? actions, UIElement body, string id)
    {
        var head = new Grid { Padding = new Thickness(10, 6, 8, 6), ColumnSpacing = 6, BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 0, 0, 1) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.Children.Add(new TextBlock { Text = title, FontSize = 11, CharacterSpacing = 60, Foreground = Theme.Brush("Faint"), VerticalAlignment = VerticalAlignment.Center });
        if (actions is FrameworkElement element)
        {
            element.HorizontalAlignment = HorizontalAlignment.Right;
            Grid.SetColumn(element, 1);
            head.Children.Add(element);
        }
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow((FrameworkElement)body, 1);
        grid.Children.Add(head);
        grid.Children.Add(body);
        var pane = new Border { Child = grid, Background = Theme.Brush("Panel"), BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 0, 1, 0) };
        AutomationProperties.SetAutomationId(pane, id);
        return pane;
    }

    // ---------- files ----------

    private Border FilesPane()
    {
        var refresh = Ui.Button("↻", ShowRoot, "ghost", tip: "โหลดใหม่");
        filter.TextChanged += (_, _) => ShowRoot();
        var body = new Grid();
        body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        tree.Expanding += (_, args) => Fill(args.Node);
        tree.ItemInvoked += (sender, args) =>
        {
            if (args.InvokedItem is TreeViewNode { Content: Entry entry } node)
            {
                if (entry.Dir) node.IsExpanded = !node.IsExpanded;
                else _ = OpenFile(entry.Path);
            }
        };
        AutomationProperties.SetAutomationId(tree, "WorkspaceTree");
        body.Children.Add(tree);
        var head = new Grid { Padding = new Thickness(10, 6, 8, 6), ColumnSpacing = 6, BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 1, 0, 1) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(fileName);
        var actions = Ui.Row(4, saved, Ui.Button("บันทึก", () => _ = SaveFile(), "pri", "WorkspaceSave", "บันทึก (Ctrl+S)"), Ui.Button("×", CloseFile, "ghost", tip: "ปิดไฟล์"));
        Grid.SetColumn(actions, 1);
        head.Children.Add(actions);
        var preview = new Grid();
        preview.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        preview.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        ScrollViewer.SetHorizontalScrollBarVisibility(editor, ScrollBarVisibility.Auto);
        ScrollViewer.SetVerticalScrollBarVisibility(editor, ScrollBarVisibility.Auto);
        editor.BorderThickness = new Thickness(0);
        AutomationProperties.SetName(editor, "เนื้อหาไฟล์");
        editor.TextChanged += (_, _) =>
        {
            saved.Text = "แก้แล้ว";
            saved.Foreground = Theme.Brush("Warn");
        };
        Grid.SetRow(editor, 1);
        preview.Children.Add(head);
        preview.Children.Add(editor);
        Grid.SetRow(preview, 1);
        body.Children.Add(preview);
        return Pane("FILES", Ui.Row(4, filter, refresh), body, "WorkspaceFiles");
    }

    private sealed record Entry(string Name, string Path, bool Dir, long Size)
    {
        public override string ToString() => Dir ? $"📁 {Name}" : $"{Name}   {(Size >= 1024 ? $"{Size / 1024} KB" : $"{Size} B")}";
    }

    /// <summary>A path inside the chosen folder, or an error (the workspace never reaches outside it).</summary>
    private string Inside(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var top = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(root));
        if (!string.Equals(full, top, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(top + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("ไฟล์นี้อยู่นอกโฟลเดอร์ของ Workspace");
        }
        return full;
    }

    private void ShowRoot()
    {
        rootText.Text = root;
        ToolTipService.SetToolTip(rootText, root);
        tree.RootNodes.Clear();
        var top = new TreeViewNode { Content = new Entry(System.IO.Path.GetFileName(root.TrimEnd('\\')) is { Length: > 0 } name ? name : root, root, true, 0), HasUnrealizedChildren = true };
        tree.RootNodes.Add(top);
        Fill(top);
        top.IsExpanded = true;
    }

    private void Fill(TreeViewNode node)
    {
        if (node.Content is not Entry { Dir: true } entry || !node.HasUnrealizedChildren && node.Children.Count > 0) return;
        node.Children.Clear();
        node.HasUnrealizedChildren = false;
        try
        {
            var dir = new DirectoryInfo(Inside(entry.Path));
            var word = filter.Text.Trim();
            var items = dir.EnumerateFileSystemInfos()
                .Where(info => info.Name != ".git" && (info.Attributes & FileAttributes.Hidden) == 0)
                .Take(MaxEntries)
                .Select(info => new Entry(info.Name, info.FullName, info is DirectoryInfo, info is FileInfo file ? file.Length : 0))
                .Where(item => item.Dir || word.Length == 0 || item.Name.Contains(word, StringComparison.OrdinalIgnoreCase))
                .OrderBy(item => item.Dir ? 0 : 1).ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase);
            foreach (var item in items) node.Children.Add(new TreeViewNode { Content = item, HasUnrealizedChildren = item.Dir });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            node.Children.Add(new TreeViewNode { Content = new Entry($"อ่านไม่ได้: {error.Message}", entry.Path, false, 0) });
        }
    }

    private async Task ChooseRoot()
    {
        var picker = new FolderPicker();
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;
        root = folder.Path;
        config.WorkspaceRoot = root;
        save();
        CloseFile();
        ShowRoot();
        // The terminal starts again in the new folder.
        shell?.Dispose();
        shell = null;
        StartShell();
    }

    private async Task OpenFile(string path)
    {
        try
        {
            var file = new FileInfo(Inside(path));
            if (file.Length > MaxFile) throw new IOException($"ไฟล์ใหญ่เกินจะเปิดที่นี่ ({file.Length / 1024} KB)");
            var bytes = await File.ReadAllBytesAsync(file.FullName);
            if (bytes.AsSpan(0, Math.Min(8000, bytes.Length)).Contains((byte)0)) throw new IOException("ดูเหมือนเป็นไฟล์ไบนารี");
            openFile = file.FullName;
            fileName.Text = System.IO.Path.GetRelativePath(root, file.FullName);
            var content = System.Text.Encoding.UTF8.GetString(bytes);
            crlf = content.Contains("\r\n");
            editor.Text = content;
            editor.Visibility = Visibility.Visible;
            saved.Text = "";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            fileName.Text = $"เปิดไม่ได้: {error.Message}";
        }
    }

    private async Task SaveFile()
    {
        if (openFile is null) return;
        try
        {
            // The editor ends lines with \r; the file keeps the line ends it had.
            var text = editor.Text.Replace("\r\n", "\n").Replace('\r', '\n');
            await File.WriteAllTextAsync(Inside(openFile), crlf ? text.Replace("\n", "\r\n") : text);
            saved.Text = "บันทึกแล้ว";
            saved.Foreground = Theme.Brush("Ok");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            saved.Text = $"บันทึกไม่ได้: {error.Message}";
            saved.Foreground = Theme.Brush("Bad");
        }
    }

    private void CloseFile()
    {
        openFile = null;
        editor.Text = "";
        editor.Visibility = Visibility.Collapsed;
        fileName.Text = "ไฟล์ที่เปิดจะแสดงที่นี่";
        saved.Text = "";
    }

    // ---------- the browser ----------

    private Border BrowserPane()
    {
        var bar = new Grid { Padding = new Thickness(6), ColumnSpacing = 4 };
        foreach (var width in new[] { GridLength.Auto, GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto }) bar.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        var items = new UIElement[]
        {
            Ui.Button("←", () => { if (browser.CanGoBack) browser.GoBack(); }, "ghost", tip: "ย้อนกลับ"),
            Ui.Button("→", () => { if (browser.CanGoForward) browser.GoForward(); }, "ghost", tip: "ถัดไป"),
            Ui.Button("⟳", () => browser.Reload(), "ghost", tip: "โหลดใหม่"),
            Ui.Button("✎", () => _ = Annotate(), "ghost", "WorkspaceAnnotate", "วาด / ทำเครื่องหมายบนหน้าเว็บ"),
            url,
            Ui.Button("ไป", Go, "pri", "WorkspaceGo"),
        };
        for (var i = 0; i < items.Length; i++)
        {
            Grid.SetColumn((FrameworkElement)items[i], i);
            bar.Children.Add(items[i]);
        }
        AutomationProperties.SetAutomationId(url, "WorkspaceUrl");
        url.KeyDown += (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Enter) return;
            e.Handled = true;
            Go();
        };
        AutomationProperties.SetAutomationId(browser, "WorkspaceBrowser");
        var body = new Grid();
        body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var view = new Grid();
        view.Children.Add(browser);
        view.Children.Add(AnnotateLayer());
        Grid.SetRow(view, 1);
        body.Children.Add(bar);
        body.Children.Add(view);
        return Pane("BROWSER", null, body, "WorkspaceBrowserPane");
    }

    private async Task StartBrowser()
    {
        try
        {
            await browser.EnsureCoreWebView2Async();
            var core = browser.CoreWebView2;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.SourceChanged += (_, _) => url.Text = core.Source == "about:blank" ? "" : core.Source;
            // Links that open a new window open in this pane.
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                core.Navigate(args.Uri);
            };
            core.NavigateToString("<html><body style=\"background:#171215;color:#a48b97;font:14px Segoe UI;display:grid;place-items:center;height:90vh\"><div style=\"text-align:center\"><div style=\"font-size:34px\">◍</div><b style=\"color:#f2e7ec\">Browse the web</b><br>พิมพ์ URL ด้านบนเพื่อเปิดเว็บ</div></body></html>");
        }
        catch (Exception error)
        {
            url.PlaceholderText = $"เบราว์เซอร์ใช้ไม่ได้: ต้องมี Microsoft Edge WebView2 Runtime ({error.Message})";
            url.IsEnabled = false;
        }
    }

    /// <summary>A typed address: a URL as is, a host gets https://, anything else is a search.</summary>
    public static string Address(string typed)
    {
        typed = typed.Trim();
        if (Uri.TryCreate(typed, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "file") return uri.ToString();
        if (!typed.Contains(' ') && typed.Contains('.') && Uri.TryCreate($"https://{typed}", UriKind.Absolute, out var host)) return host.ToString();
        if (typed.StartsWith("localhost", StringComparison.OrdinalIgnoreCase)) return $"http://{typed}";
        return $"https://www.bing.com/search?q={Uri.EscapeDataString(typed)}";
    }

    private void Go()
    {
        if (url.Text.Trim().Length == 0 || browser.CoreWebView2 is null) return;
        browser.CoreWebView2.Navigate(Address(url.Text));
    }

    // ---------- drawing on a picture of the page (workspace-annotate.js) ----------

    private Grid AnnotateLayer()
    {
        annotate.Background = Theme.Brush("Bg");
        picture.Children.Add(shot);
        picture.Children.Add(ink);
        annotate.Children.Add(picture);
        ink.PointerPressed += (_, e) =>
        {
            stroke = new Polyline { Stroke = new SolidColorBrush(pen), StrokeThickness = 4, StrokeLineJoin = PenLineJoin.Round, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round };
            stroke.Points.Add(e.GetCurrentPoint(ink).Position);
            ink.Children.Add(stroke);
            ink.CapturePointer(e.Pointer);
        };
        ink.PointerMoved += (_, e) => stroke?.Points.Add(e.GetCurrentPoint(ink).Position);
        ink.PointerReleased += (_, e) =>
        {
            stroke = null;
            ink.ReleasePointerCapture(e.Pointer);
        };
        var colors = new[] { (240, 70, 110), (255, 196, 0), (70, 200, 120), (80, 160, 255), (255, 255, 255) };
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 10, 0, 0), Padding = new Thickness(8, 6, 8, 6), Background = Theme.Brush("Glass"), CornerRadius = new CornerRadius(10) };
        AutomationProperties.SetName(tools, "เครื่องมือวาด");
        foreach (var (r, g, b) in colors)
        {
            var color = Windows.UI.Color.FromArgb(255, (byte)r, (byte)g, (byte)b);
            var swatch = new Button { Width = 24, Height = 24, MinWidth = 0, Padding = new Thickness(0), CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(color) };
            swatch.Click += (_, _) => pen = color;
            tools.Children.Add(swatch);
        }
        tools.Children.Add(Ui.Button("ล้าง", () => ink.Children.Clear(), "ghost"));
        if (sendToChat is not null) tools.Children.Add(Ui.Button("ส่งเข้าแชต", () => _ = SendDrawing(), "ghost", "AnnotateSend", "แนบภาพนี้ในแชตที่เปิดอยู่ แล้วพิมพ์ข้อความประกอบ"));
        tools.Children.Add(Ui.Button("คัดลอก", () => _ = CopyDrawing(), "ghost", "AnnotateCopy"));
        tools.Children.Add(Ui.Button("บันทึก PNG", () => _ = SaveDrawing(), "ghost"));
        tools.Children.Add(Ui.Button("ปิด", () => annotate.Visibility = Visibility.Collapsed, "pri"));
        annotate.Children.Add(tools);
        return annotate;
    }

    private async Task Annotate()
    {
        if (browser.CoreWebView2 is null) return;
        var stream = new InMemoryRandomAccessStream();
        await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        stream.Seek(0);
        var bitmap = new BitmapImage();
        await bitmap.SetSourceAsync(stream);
        shot.Source = bitmap;
        ink.Children.Clear();
        annotate.Visibility = Visibility.Visible;
    }

    private async Task<byte[]> Drawing()
    {
        var target = new RenderTargetBitmap();
        await target.RenderAsync(picture);
        var pixels = await target.GetPixelsAsync();
        var stream = new InMemoryRandomAccessStream();
        var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied,
            (uint)target.PixelWidth, (uint)target.PixelHeight, 96, 96, WindowsRuntimeBufferExtensions.ToArray(pixels));
        await encoder.FlushAsync();
        var bytes = new byte[stream.Size];
        stream.Seek(0);
        await stream.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
        return bytes;
    }

    private async Task CopyDrawing()
    {
        var bytes = await Drawing();
        var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(bytes.AsBuffer());
        stream.Seek(0);
        var package = new DataPackage();
        package.SetBitmap(RandomAccessStreamReference.CreateFromStream(stream));
        Clipboard.SetContent(package);
    }

    private async Task SendDrawing()
    {
        if (sendToChat is null) return;
        var name = $"workspace-{DateTime.Now:yyyyMMdd-HHmmss}.png";
        if (await sendToChat(await Drawing(), name))
        {
            annotate.Visibility = Visibility.Collapsed;
            return;
        }
        await new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            RequestedTheme = Theme.Element,
            Title = "ยังไม่มีแชตที่เปิดอยู่",
            Content = "เปิดแชตในหน้าต่างหลักของ Mimi ก่อน แล้วกด \"ส่งเข้าแชต\" อีกครั้ง (หรือกดคัดลอกแล้ววางในแชต)",
            CloseButtonText = "ปิด",
        }.ShowAsync();
    }

    private async Task SaveDrawing()
    {
        var picker = new FileSavePicker { SuggestedFileName = $"workspace-{DateTime.Now:yyyyMMdd-HHmmss}" };
        picker.FileTypeChoices.Add("PNG", [".png"]);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSaveFileAsync();
        if (file is not null) await File.WriteAllBytesAsync(file.Path, await Drawing());
    }

    // ---------- the terminal ----------

    private Border TerminalPane()
    {
        AutomationProperties.SetAutomationId(terminal, "WorkspaceTerminal");
        var actions = Ui.Row(4, termStatus,
            Ui.Button("Clear", () => PostTerminal(new JsonObject { ["type"] = "clear" }), "ghost"),
            Ui.Button("Restart", () =>
            {
                shell?.Dispose();
                shell = null;
                PostTerminal(new JsonObject { ["type"] = "clear" });
                StartShell();
            }, "ghost", "TerminalRestart"));
        return Pane("TERMINAL", actions, terminal, "WorkspaceTerminalPane");
    }

    private async Task StartTerminal()
    {
        try
        {
            await terminal.EnsureCoreWebView2Async();
            var core = terminal.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.SetVirtualHostNameToFolderMapping("app.mimi", System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "web"), CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += (_, args) =>
            {
                var message = JsonNode.Parse(args.WebMessageAsJson) as JsonObject;
                switch (message?["type"]?.GetValue<string>())
                {
                    case "ready":
                        size = (message["cols"]?.GetValue<int>() ?? 100, message["rows"]?.GetValue<int>() ?? 30);
                        if (shell is null) StartShell();
                        break;
                    case "input":
                        shell?.Write(message["data"]?.GetValue<string>() ?? "");
                        break;
                    case "resize":
                        size = (message["cols"]?.GetValue<int>() ?? size.Cols, message["rows"]?.GetValue<int>() ?? size.Rows);
                        shell?.Resize(size.Cols, size.Rows);
                        break;
                }
            };
            terminal.Source = new Uri("https://app.mimi/terminal.html");
        }
        catch (Exception error)
        {
            termStatus.Text = $"เทอร์มินัลใช้ไม่ได้: {error.Message}";
        }
    }

    private void PostTerminal(JsonObject message)
    {
        try
        {
            terminal.CoreWebView2?.PostWebMessageAsJson(message.ToJsonString());
        }
        catch (Exception error) when (error is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            // the page is loading
        }
    }

    /// <summary>PowerShell (pwsh when installed) in the workspace folder, under ConPTY.</summary>
    private void StartShell()
    {
        var pwsh = Environment.GetEnvironmentVariable("PATH")?.Split(';').Select(dir => System.IO.Path.Combine(dir.Trim(), "pwsh.exe")).FirstOrDefault(File.Exists);
        var command = pwsh is not null ? $"\"{pwsh}\" -NoLogo" : "powershell.exe -NoLogo";
        try
        {
            shell = new ConPty(command, Directory.Exists(root) ? root : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), size.Cols, size.Rows);
            termStatus.Text = pwsh is not null ? "pwsh" : "PowerShell";
            termStatus.Foreground = Theme.Brush("Ok");
            var queue = DispatcherQueue;
            shell.Output += text => queue.TryEnqueue(() => PostTerminal(new JsonObject { ["type"] = "output", ["data"] = text }));
            shell.Exited += () => queue.TryEnqueue(() =>
            {
                termStatus.Text = "จบแล้ว — กด Restart";
                termStatus.Foreground = Theme.Brush("Warn");
            });
            PostTerminal(new JsonObject { ["type"] = "focus" });
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or EntryPointNotFoundException)
        {
            termStatus.Text = $"เริ่ม shell ไม่ได้: {error.Message}";
            termStatus.Foreground = Theme.Brush("Bad");
        }
    }
}
