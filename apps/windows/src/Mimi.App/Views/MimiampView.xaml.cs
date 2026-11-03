using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Mimi.Core.Mimiamp;
using Mimi.Core.ViewModels;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace Mimi.App.Views;

public sealed partial class MimiampView : UserControl, INotifyPropertyChanged
{
    private const int BarCount = 18;
    private readonly List<Slider> bands = [];
    private readonly List<TextBlock> bandValues = [];
    private readonly List<Rectangle> bars = [];
    private readonly DispatcherTimer clock = new() { Interval = TimeSpan.FromMilliseconds(400) };
    private readonly DispatcherTimer visual = new() { Interval = TimeSpan.FromMilliseconds(60) };
    private readonly float[] heights = new float[BarCount];
    private bool eqOpen = true;
    private bool settingBands;
    private bool fillingLists;
    private bool showing;

    public MimiampView(MimiampViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        BuildBands();
        BuildBars();
        clock.Tick += (_, _) =>
        {
            // Not while the person drags the position slider.
            if (Seek.FocusState == FocusState.Unfocused || !ViewModel.Playing) ViewModel.Tick();
            Lcd();
        };
        visual.Tick += (_, _) => Visualize();
        Loaded += (_, _) => Showing(showing);
        Unloaded += (_, _) =>
        {
            clock.Stop();
            visual.Stop();
        };
        viewModel.PropertyChanged += (_, args) =>
        {
            switch (args.PropertyName)
            {
                case nameof(MimiampViewModel.NowTitle):
                    Changed(nameof(NowTitleOrHint));
                    break;
                case nameof(MimiampViewModel.Playing):
                    Changed(nameof(PlaySymbol));
                    Lcd();
                    Showing(showing);
                    break;
                case nameof(MimiampViewModel.Repeat):
                    Changed(nameof(RepeatShort));
                    break;
                case nameof(MimiampViewModel.EqEnabled):
                    Changed(nameof(EqLabel));
                    break;
                case nameof(MimiampViewModel.OpenPlaylist):
                    FillLists();
                    break;
                case nameof(MimiampViewModel.Visualizer):
                    Showing(showing);
                    break;
            }
        };
        viewModel.Gains.CollectionChanged += (_, _) => SyncBands();
        viewModel.Playlists.CollectionChanged += (_, _) => FillLists();
        viewModel.Tracks.CollectionChanged += (_, _) => Lcd();
        FillLists();
        Lcd();
    }

    public MimiampViewModel ViewModel { get; }

    public string NowTitleOrHint => ViewModel.HasNowPlaying ? ViewModel.NowTitle : "MIMIAMP — ยังไม่มีเพลง";
    public string PlaySymbol => ViewModel.Playing ? "❚❚" : "▶";
    public string RepeatShort => ViewModel.Repeat switch { RepeatMode.All => "REP ALL", RepeatMode.One => "REP 1", _ => "REP OFF" };
    public string EqLabel => ViewModel.EqEnabled ? "ON" : "OFF";

    public bool EqOpen
    {
        get => eqOpen;
        set
        {
            eqOpen = value;
            Changed(nameof(EqOpen));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Changed(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    /// <summary>On screen or not: the timers keep the clock, the slider and the bars moving only while it shows.</summary>
    public void Showing(bool visible)
    {
        showing = visible;
        if (visible) clock.Start();
        else clock.Stop();
        if (visible && ViewModel.Visualizer && ViewModel.Playing) visual.Start();
        else
        {
            visual.Stop();
            Array.Clear(heights);
            Visualize();
        }
        Bars.Visibility = ViewModel.Visualizer ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>The LCD: state badge, big clock, status line and count.</summary>
    private void Lcd()
    {
        StateBadgeText.Text = ViewModel.Playing ? "PLAY" : ViewModel.HasNowPlaying ? "PAUSE" : "STOP";
        BigClock.Text = Mimi.Core.Mimiamp.PlayQueue.Clock(ViewModel.PositionSeconds);
        StatusText.Text = ViewModel.Preparing ? "LOADING…" : ViewModel.Playing ? "PLAYING" : ViewModel.HasNowPlaying ? "PAUSED" : "STOPPED";
        CountText.Text = $"{ViewModel.Tracks.Count} TRACKS";
        TrackCount.Text = $"{ViewModel.Tracks.Count} TRACKS";
    }

    private void BuildBars()
    {
        var brush = (Brush)Resources["AmpGreen"];
        for (var i = 0; i < BarCount; i++)
        {
            Bars.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var bar = new Rectangle { Fill = brush, VerticalAlignment = VerticalAlignment.Bottom, Height = 1, Opacity = 0.85 };
            Grid.SetColumn(bar, i);
            Bars.Children.Add(bar);
            bars.Add(bar);
        }
    }

    private void Visualize()
    {
        var levels = ViewModel.Bars(BarCount);
        var top = Bars.ActualHeight > 0 ? Bars.ActualHeight : 30;
        for (var i = 0; i < BarCount; i++)
        {
            // Up at once, down slowly (the web's analyser smoothing).
            heights[i] = Math.Max(levels[i], heights[i] * 0.82f);
            bars[i].Height = Math.Max(1, heights[i] * top);
        }
    }

    private void BuildBands()
    {
        for (var i = 0; i < Equalizer.Bands.Length; i++)
        {
            Bands.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var band = i;
            var value = new TextBlock { FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 9, Foreground = (Brush)Resources["AmpGreen"], HorizontalAlignment = HorizontalAlignment.Center };
            var slider = new Slider
            {
                Orientation = Orientation.Vertical,
                Minimum = -12,
                Maximum = 12,
                StepFrequency = 0.5,
                Value = ViewModel.Gains[i],
                Height = 96,
                HorizontalAlignment = HorizontalAlignment.Center,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(slider, $"{Equalizer.BandLabels[i]} Hz");
            slider.ValueChanged += (_, args) =>
            {
                value.Text = $"{args.NewValue:0.0}";
                if (!settingBands) ViewModel.SetGain(band, (float)args.NewValue);
            };
            value.Text = $"{slider.Value:0.0}";
            var label = new TextBlock { Text = Equalizer.BandLabels[i], FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 9, HorizontalAlignment = HorizontalAlignment.Center, Foreground = (Brush)Resources["AmpDim"] };
            var stack = new StackPanel { Spacing = 2 };
            stack.Children.Add(value);
            stack.Children.Add(slider);
            stack.Children.Add(label);
            Grid.SetColumn(stack, i);
            Bands.Children.Add(stack);
            bands.Add(slider);
            bandValues.Add(value);
        }
    }

    private void SyncBands()
    {
        settingBands = true;
        for (var i = 0; i < bands.Count && i < ViewModel.Gains.Count; i++) bands[i].Value = ViewModel.Gains[i];
        settingBands = false;
    }

    private void OnPreset(object sender, SelectionChangedEventArgs e)
    {
        if (((ComboBox)sender).SelectedItem is string name) ViewModel.ApplyPreset(name);
    }

    private void OnPanCentre(object sender, DoubleTappedRoutedEventArgs e) => ViewModel.Pan = 0;

    private void OnSeekReleased(object sender, PointerRoutedEventArgs e) => ViewModel.SeekTo(Seek.Value);

    private void OnSeekKey(object sender, KeyRoutedEventArgs e) => ViewModel.SeekTo(Seek.Value);

    private void OnTrack(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is TrackRow row) _ = ViewModel.PlayRow(row);
    }

    // ---------- the list on screen: the library or a playlist ----------

    private void FillLists()
    {
        fillingLists = true;
        ListBox.Items.Clear();
        ListBox.Items.Add(new ComboBoxItem { Content = "คลังเพลง (ทั้งหมด)", Tag = null });
        foreach (var playlist in ViewModel.Playlists) ListBox.Items.Add(new ComboBoxItem { Content = $"{playlist.Name} · {playlist.Count}", Tag = playlist });
        ListBox.SelectedItem = ListBox.Items.OfType<ComboBoxItem>().FirstOrDefault(item => item.Tag is PlaylistRow row && row.Id == ViewModel.OpenPlaylist?.Id) ?? ListBox.Items[0];
        fillingLists = false;
    }

    private void OnListChosen(object sender, SelectionChangedEventArgs e)
    {
        if (fillingLists || ListBox.SelectedItem is not ComboBoxItem item) return;
        if (item.Tag is PlaylistRow playlist) ViewModel.ShowPlaylist(playlist);
        else ViewModel.ShowLibrary();
    }

    private PlaylistRow? Chosen => ViewModel.OpenPlaylist;

    private void OnDeletePlaylist(object sender, RoutedEventArgs e)
    {
        if (Chosen is not { } row) return;
        if (Native.Win32.Ask("ลบเพลย์ลิสต์", $"ลบเพลย์ลิสต์ \"{row.Name}\"? (เพลงในคลังไม่ถูกลบ)")) _ = ViewModel.DeletePlaylist(row);
    }

    private async void OnRenamePlaylist(object sender, RoutedEventArgs e)
    {
        if (Chosen is not { } row) return;
        var name = new TextBox { Text = row.Name };
        var dialog = new ContentDialog { XamlRoot = XamlRoot, RequestedTheme = Services.Theme.Element, Title = "เปลี่ยนชื่อเพลย์ลิสต์", Content = name, PrimaryButtonText = "บันทึก", CloseButtonText = "ยกเลิก", DefaultButton = ContentDialogButton.Primary };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await ViewModel.RenamePlaylist(row, name.Text);
    }

    private async void OnExportPlaylist(object sender, RoutedEventArgs e)
    {
        if (Chosen is not { } row) return;
        if (await ViewModel.ExportPlaylist(row) is not { } json) return;
        var picker = new Windows.Storage.Pickers.FileSavePicker { SuggestedFileName = $"{row.Name}.mimiamp" };
        picker.FileTypeChoices.Add("Mimiamp playlist", [".json"]);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, App.Instance!.WindowHandle);
        var file = await picker.PickSaveFileAsync();
        if (file is not null) await File.WriteAllTextAsync(file.Path, json);
    }

    private async void OnImportPlaylist(object sender, RoutedEventArgs e)
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        picker.FileTypeFilter.Add(".json");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, App.Instance!.WindowHandle);
        var file = await picker.PickSingleFileAsync();
        if (file is not null) await ViewModel.ImportPlaylist(await File.ReadAllTextAsync(file.Path));
    }

    private void OnNewPlaylist(object sender, RoutedEventArgs e)
    {
        _ = ViewModel.NewPlaylist(PlaylistName.Text);
        PlaylistName.Text = "";
        NewPlaylistFlyout.Hide();
    }

    // ---------- songs of this computer ----------

    private async void OnOpenFiles(object sender, RoutedEventArgs e)
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker { SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.MusicLibrary };
        foreach (var type in MimiampViewModel.LocalTypes) picker.FileTypeFilter.Add(type);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, App.Instance!.WindowHandle);
        var files = await picker.PickMultipleFilesAsync();
        if (files.Count > 0) ViewModel.AddLocalFiles(files.Select(file => file.Path));
    }

    private void OnFilesDragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems)) e.AcceptedOperation = DataPackageOperation.Link;
    }

    private async void OnFilesDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var items = await e.DataView.GetStorageItemsAsync();
        ViewModel.AddLocalFiles(items.OfType<StorageFile>().Select(file => file.Path));
    }

    /// <summary>Right-click a song: add it to a playlist (or take a song of this computer off the list).</summary>
    private void OnTrackMenu(object sender, object e)
    {
        var menu = (MenuFlyout)sender;
        menu.Items.Clear();
        if (menu.Target?.DataContext is not TrackRow track) return;
        if (track.Track.Source == "local")
        {
            var remove = new MenuFlyoutItem { Text = "เอาออกจากรายการ (ไฟล์ยังอยู่)" };
            remove.Click += (_, _) => ViewModel.RemoveLocal(track);
            menu.Items.Add(remove);
            return;
        }
        if (ViewModel.Playlists.Count == 0)
        {
            menu.Items.Add(new MenuFlyoutItem { Text = "ยังไม่มีเพลย์ลิสต์", IsEnabled = false });
            return;
        }
        foreach (var playlist in ViewModel.Playlists)
        {
            var item = new MenuFlyoutItem { Text = $"เพิ่มใน {playlist.Name}" };
            item.Click += (_, _) => _ = ViewModel.AddToPlaylist(playlist, track);
            menu.Items.Add(item);
        }
    }
}
