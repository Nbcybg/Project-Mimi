using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Audio;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;

namespace Mimi.App.Views;

/// <summary>Chooses how a row of the conversation looks.</summary>
public sealed partial class RowSelector : DataTemplateSelector
{
    public DataTemplate? Message { get; set; }
    public DataTemplate? Pending { get; set; }
    public DataTemplate? Live { get; set; }
    public DataTemplate? Note { get; set; }
    public DataTemplate? Permission { get; set; }
    public DataTemplate? Task { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => item switch
    {
        TaskItem => Task,
        MessageItem => Message,
        PendingItem => Pending,
        LiveItem => Live,
        NoteItem => Note,
        PermissionItem => Permission,
        _ => Note,
    };

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}

/// <summary>Chooses how a part of a streaming answer looks: text, a tool row, a file.</summary>
public sealed partial class PartSelector : DataTemplateSelector
{
    public DataTemplate? Text { get; set; }
    public DataTemplate? Tool { get; set; }
    public DataTemplate? File { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => item switch
    {
        ToolRow => Tool,
        FileItem => File,
        _ => Text,
    };

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}

public sealed partial class ChatView : UserControl
{
    private readonly VoiceRecorder recorder = new();
    private readonly Func<nint> window;

    public ChatView(ChatViewModel viewModel, Func<nint> window)
    {
        ViewModel = viewModel;
        this.window = window;
        InitializeComponent();
        viewModel.Grew += () => DispatcherQueue.TryEnqueue(ScrollDown);
        // The web's emoji panel (feature-chat.js EMOJIS).
        EmojiGrid.ItemsSource = new[]
        {
            "😀", "😄", "😁", "😅", "😂", "🙂", "😉", "😊", "😍", "😘", "😜", "🤪", "🤔", "🤨", "😐", "😴",
            "😢", "😭", "😤", "😡", "🥺", "😱", "🤯", "😎", "🥳", "🤗", "🤭", "🙄", "😬", "🤫", "🫡", "🤝",
            "👍", "👎", "👏", "🙏", "💪", "✌️", "🤞", "👌", "👋", "🫶", "❤️", "🧡", "💛", "💚", "💙", "💜",
            "💔", "✨", "🎉", "🎊", "🔥", "⭐", "🌟", "💯", "✅", "❌", "⚠️", "❓", "❗", "⏰", "📌", "📎",
            "💡", "📝", "📚", "💰", "🛒", "🍜", "🍕", "🍰", "☕", "🍺", "🎮", "🎵", "🎬", "⚽", "🚗", "✈️",
            "🏠", "🌧️", "☀️", "🌙", "🐶", "🐱", "🌸", "🌈", "🎁", "🫠", "🤖", "👻",
        };
        viewModel.JumpRequested += key => DispatcherQueue.TryEnqueue(() =>
        {
            if (ViewModel.Items.FirstOrDefault(item => item.Key == key) is { } row) Messages.ScrollIntoView(row, ScrollIntoViewAlignment.Leading);
        });
    }

    public ChatViewModel ViewModel { get; }

    public static HorizontalAlignment Side(bool user) => user ? HorizontalAlignment.Right : HorizontalAlignment.Left;
    public static Brush Bubble(bool user) => (Brush)Application.Current.Resources[user ? "MimiUserBrush" : "MimiPanelBrush"];
    public static Brush BubbleLine(bool user) => (Brush)Application.Current.Resources[user ? "MimiUserLineBrush" : "MimiLineBrush"];
    public static Brush NoteBrush(bool bad) => (Brush)Application.Current.Resources[bad ? "MimiBadBrush" : "MimiMutedBrush"];
    public static Visibility Not(bool value) => value ? Visibility.Collapsed : Visibility.Visible;
    /// <summary>Several pins: the list; one pin: unpin it.</summary>
    public static string PinsGlyph(bool many) => many ? "" : "";

    public void FocusComposer() => Composer.Focus(FocusState.Programmatic);

    private void ScrollDown()
    {
        if (ViewModel.Items.Count > 0) Messages.ScrollIntoView(ViewModel.Items[^1], ScrollIntoViewAlignment.Leading);
    }

    private void OnComposerKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        var shift = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (shift) return;
        e.Handled = true;
        ViewModel.Send();
    }

    private static T Tagged<T>(object sender) => (T)((FrameworkElement)sender).Tag;

    private void OnApprove(object sender, RoutedEventArgs e) => ViewModel.Approve(Tagged<MessageItem>(sender).Approval!.Id, true);
    private void OnReject(object sender, RoutedEventArgs e) => ViewModel.Approve(Tagged<MessageItem>(sender).Approval!.Id, false);
    private void OnAllowOnce(object sender, RoutedEventArgs e) => ViewModel.Answer(Tagged<PermissionItem>(sender).Request.Id, true, "once");
    private void OnAllowTask(object sender, RoutedEventArgs e) => ViewModel.Answer(Tagged<PermissionItem>(sender).Request.Id, true, "task");
    private void OnAllowSession(object sender, RoutedEventArgs e) => ViewModel.Answer(Tagged<PermissionItem>(sender).Request.Id, true, "session");
    private void OnAllowAlways(object sender, RoutedEventArgs e) => ViewModel.Answer(Tagged<PermissionItem>(sender).Request.Id, true, "always");
    private void OnDeny(object sender, RoutedEventArgs e) => ViewModel.Answer(Tagged<PermissionItem>(sender).Request.Id, false);
    private void OnUnstage(object sender, RoutedEventArgs e) => ViewModel.Unstage(Tagged<AttachmentView>(sender));

    // ---------- emoji, task cards, sessions, the chat menu ----------

    private void OnEmoji(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not string emoji) return;
        var at = Composer.SelectionStart;
        var text = Composer.Text;
        Composer.Text = text[..at] + emoji + text[(at + Composer.SelectionLength)..];
        Composer.SelectionStart = at + emoji.Length;
        EmojiFlyout.Hide();
        FocusComposer();
    }

    private void OnTaskPause(object sender, RoutedEventArgs e) => ViewModel.TaskControl(Tagged<TaskItem>(sender).Id, "pause");
    private void OnTaskResume(object sender, RoutedEventArgs e) => ViewModel.TaskControl(Tagged<TaskItem>(sender).Id, "resume");
    private void OnTaskCancel(object sender, RoutedEventArgs e) => ViewModel.TaskControl(Tagged<TaskItem>(sender).Id, "cancel");
    private void OnTaskUndo(object sender, RoutedEventArgs e) => ViewModel.TaskUndo(Tagged<TaskItem>(sender).Id);

    private static MenuFlyoutItem Item(string text, Action act)
    {
        var item = new MenuFlyoutItem { Text = text };
        item.Click += (_, _) => act();
        return item;
    }

    private void OnSessionsOpening(object sender, object e)
    {
        SessionsMenu.Items.Clear();
        SessionsMenu.Items.Add(Item("+ เริ่ม session ใหม่", ViewModel.NewSession));
        if (ViewModel.SessionChoices.Count > 0) SessionsMenu.Items.Add(new MenuFlyoutSeparator());
        foreach (var (id, label, current) in ViewModel.SessionChoices.Take(40))
        {
            var entry = new ToggleMenuFlyoutItem { Text = label, IsChecked = current };
            entry.Click += (_, _) => ViewModel.OpenSession(id);
            SessionsMenu.Items.Add(entry);
        }
    }

    /// <summary>The chat's menu: read aloud by itself, rename / members, download as CSV, delete.</summary>
    private void OnChatMenuOpening(object sender, object e)
    {
        ChatMenu.Items.Clear();
        var speak = new ToggleMenuFlyoutItem { Text = "อ่านออกเสียงคำตอบอัตโนมัติ", IsChecked = ViewModel.AutoSpeak };
        speak.Click += (_, _) => ViewModel.AutoSpeak = speak.IsChecked;
        ChatMenu.Items.Add(speak);
        ChatMenu.Items.Add(Item(ViewModel.Chat?.Kind == "group" ? "แก้ชื่อและสมาชิกกลุ่ม…" : "แก้ชื่อแชต…", () => _ = EditChat()));
        ChatMenu.Items.Add(Item("ดาวน์โหลดแชตนี้ (CSV)", () => _ = App.Instance?.Download($"/api/export/chat/{ViewModel.ChatId}.csv", $"mimi-chat-{ViewModel.ChatId}.csv")));
        ChatMenu.Items.Add(new MenuFlyoutSeparator());
        ChatMenu.Items.Add(Item("ลบแชตนี้…", () => _ = DeleteChat()));
    }

    private async Task EditChat()
    {
        if (ViewModel.Chat is not { } chat) return;
        var title = new TextBox { Header = "ชื่อแชต (ว่าง = ใช้ชื่อสมาชิก)", Text = chat.Title };
        var content = new StackPanel { Spacing = 10 };
        content.Children.Add(title);
        var boxes = new List<(CheckBox Box, string Name)>();
        if (chat.Kind == "group")
        {
            content.Children.Add(new TextBlock { Text = "สมาชิก (คนแรกตอบเมื่อไม่ได้ @ ใคร)", FontSize = 12 });
            var members = chat.AgentNames.ToList();
            foreach (var (name, shown) in ViewModel.AllAgents.OrderBy(agent => members.IndexOf(agent.Name) is var at && at >= 0 ? at : 999))
            {
                var box = new CheckBox { Content = shown, IsChecked = members.Contains(name) };
                boxes.Add((box, name));
                content.Children.Add(box);
            }
        }
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = chat.Kind == "group" ? "แก้กลุ่ม" : "แก้ชื่อแชต",
            Content = new ScrollViewer { Content = content, MaxHeight = 480 },
            PrimaryButtonText = "บันทึก",
            CloseButtonText = "ยกเลิก",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var chosen = boxes.Where(entry => entry.Box.IsChecked == true).Select(entry => entry.Name).ToList();
        if (chat.Kind == "group" && chosen.Count < 2)
        {
            ViewModel.Error = "กลุ่มต้องมีสมาชิกอย่างน้อย 2 ตัว";
            return;
        }
        ViewModel.UpdateChat(title.Text.Trim(), chat.Kind == "group" ? chosen : null);
    }

    private async Task DeleteChat()
    {
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "ลบแชตนี้?",
            Content = new TextBlock { Text = "ข้อความและ session ทั้งหมดของแชตนี้จะหายไป (agent ยังอยู่)", TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = "ลบ",
            CloseButtonText = "ยกเลิก",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        ViewModel.DeleteChat();
        App.Instance?.ShowChats();
    }

    // ---------- message menu (feature-chat.js: love, react, reply, forward, copy, pin; app.js rewind) ----------

    private void OnMessageContext(UIElement sender, ContextRequestedEventArgs args)
    {
        if (sender is not FrameworkElement { Tag: MessageItem message }) return;
        args.Handled = true;
        var menu = MessageMenu(message);
        if (args.TryGetPosition(sender, out var point)) menu.ShowAt(sender, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions { Position = point });
        else menu.ShowAt((FrameworkElement)sender);
    }

    private void OnMessageMore(object sender, RoutedEventArgs e) => MessageMenu(Tagged<MessageItem>(sender)).ShowAt((FrameworkElement)sender);

    private MenuFlyout MessageMenu(MessageItem message)
    {
        var menu = new MenuFlyout();
        MenuFlyoutItem Item(string text, Action act)
        {
            var item = new MenuFlyoutItem { Text = text };
            item.Click += (_, _) => act();
            return item;
        }
        menu.Items.Add(Item(message.Loved ? "❤️ เลิกถูกใจ" : "🤍 ถูกใจ", () => ViewModel.React(message.Id, ChatViewModel.Love)));
        var react = new MenuFlyoutSubItem { Text = "😊 รีแอ็กชัน" };
        foreach (var emoji in ChatViewModel.QuickReactions)
        {
            react.Items.Add(Item(message.ReactionList.Contains(emoji) ? $"{emoji}  (เอาออก)" : emoji, () => ViewModel.React(message.Id, emoji)));
        }
        menu.Items.Add(react);
        menu.Items.Add(Item("↩ ตอบกลับ", () =>
        {
            ViewModel.ReplyTo(message.Id);
            FocusComposer();
        }));
        var forward = new MenuFlyoutSubItem { Text = "↪ ส่งต่อ" };
        foreach (var (id, title) in ViewModel.ForwardTargets) forward.Items.Add(Item(title, () => ViewModel.Forward(message.Id, id)));
        if (forward.Items.Count == 0) forward.Items.Add(new MenuFlyoutItem { Text = "ไม่มีแชตอื่นให้ส่งต่อ", IsEnabled = false });
        menu.Items.Add(forward);
        if (message.HasText) menu.Items.Add(Item("⧉ คัดลอกข้อความ", () => Copy(ViewModel.TextOf(message.Id))));
        if (!message.IsUser && message.HasText) menu.Items.Add(Item("🔊 อ่านออกเสียง", () => ViewModel.Speak(message.Id)));
        menu.Items.Add(Item(message.Pinned ? "📌 เลิกปักหมุด" : "📌 ปักหมุด", () => ViewModel.TogglePin(message.Id)));
        if (message.IsUser)
        {
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Item("⟲ ย้อนกลับมาแก้ไข", () => _ = AskRewind(message.Id)));
        }
        return menu;
    }

    private void Copy(string text)
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
        ViewModel.Info = "คัดลอกแล้ว";
    }

    private async Task AskRewind(long id)
    {
        if (ViewModel.RewindProblem(id) is { } problem)
        {
            ViewModel.Error = problem;
            return;
        }
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "ย้อนบทสนทนากลับไปก่อนข้อความนี้?",
            Content = new TextBlock
            {
                Text = "ข้อความนี้และทุกอย่างหลังจากนี้จะถูกซ่อน แล้วข้อความจะกลับมาอยู่ในช่องพิมพ์ให้แก้ไขส่งใหม่\n(ไฟล์ที่ agent แก้ไปจะถูกย้อนกลับเท่าที่ทำได้ ส่วนสิ่งที่จำไว้แล้วจะไม่ถูกย้อน)",
                TextWrapping = TextWrapping.Wrap,
            },
            PrimaryButtonText = "ย้อนกลับ",
            CloseButtonText = "ยกเลิก",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        ViewModel.Rewind(id);
        FocusComposer();
    }

    /// <summary>A reaction chip under a bubble: clicking it takes the reaction back.</summary>
    private void OnReactionChip(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Content: string emoji } chip) return;
        for (DependencyObject? node = chip; node is not null; node = VisualTreeHelper.GetParent(node))
        {
            if (node is ItemsControl { Tag: MessageItem message })
            {
                ViewModel.React(message.Id, emoji);
                return;
            }
        }
    }

    private void OnPinsMore(object sender, RoutedEventArgs e)
    {
        if (!ViewModel.ManyPins)
        {
            if (ViewModel.Pins.Count == 1) ViewModel.Unpin(ViewModel.Pins[0].Id);
            return;
        }
        var list = new StackPanel { Spacing = 2, MinWidth = 260, MaxWidth = 380 };
        var flyout = new Flyout { Content = new ScrollViewer { Content = list, MaxHeight = 420 } };
        list.Children.Add(new TextBlock { Text = "📌 ข้อความที่ปักหมุด", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 4) });
        foreach (var pin in ViewModel.Pins)
        {
            var row = new Grid { ColumnSpacing = 6 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var open = new Button
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderThickness = new Thickness(0),
                Content = new TextBlock { Text = ViewModel.PinPreview(pin), TextWrapping = TextWrapping.Wrap, MaxLines = 2, FontSize = 13 },
            };
            open.Click += (_, _) =>
            {
                flyout.Hide();
                ViewModel.GoTo(pin);
            };
            var unpin = new Button { Content = "เลิกปักหมุด", FontSize = 12 };
            unpin.Click += (_, _) =>
            {
                flyout.Hide();
                ViewModel.Unpin(pin.Id);
            };
            Grid.SetColumn(unpin, 1);
            row.Children.Add(open);
            row.Children.Add(unpin);
            list.Children.Add(row);
        }
        flyout.ShowAt(PinsMore);
    }

    private async void OnAttach(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
        picker.FileTypeFilter.Add("*");
        var files = await picker.PickMultipleFilesAsync();
        foreach (var file in files) await Upload(file);
    }

    private async Task Upload(StorageFile file)
    {
        var properties = await file.GetBasicPropertiesAsync();
        if (properties.Size > 25 * 1024 * 1024)
        {
            ViewModel.Error = $"{file.Name} ใหญ่เกิน 25 MB";
            return;
        }
        await using var stream = await file.OpenStreamForReadAsync();
        await ViewModel.Attach(stream, file.Name, string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType);
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems)) e.AcceptedOperation = DataPackageOperation.Copy;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        foreach (var item in await e.DataView.GetStorageItemsAsync())
        {
            if (item is StorageFile file) await Upload(file);
        }
    }

    private async void OnMic(object sender, RoutedEventArgs e)
    {
        if (!recorder.Recording)
        {
            try
            {
                recorder.Start();
                MicButton.IsChecked = true;
                ToolTipService.SetToolTip(MicButton, "กำลังอัด… กดอีกครั้งเพื่อแนบเสียง");
            }
            catch (Exception problem)
            {
                MicButton.IsChecked = false;
                ViewModel.Error = $"อัดเสียงไม่ได้: {problem.Message} (ตรวจสิทธิ์ไมโครโฟนใน Settings → Privacy → Microphone)";
            }
            return;
        }
        MicButton.IsChecked = false;
        ToolTipService.SetToolTip(MicButton, "อัดข้อความเสียง (กดอีกครั้งเพื่อส่ง)");
        var wav = await recorder.Stop();
        if (wav.Length <= 44) return;
        using var stream = new MemoryStream(wav);
        await ViewModel.Attach(stream, $"voice-{DateTime.Now:yyyyMMdd-HHmmss}.wav", "audio/wav");
        // A voice message alone goes out at once, like the web's mic button.
        if (ViewModel.Draft.Trim().Length == 0) ViewModel.Send();
    }
}
