using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mimi.Core.Desktop;
using Mimi.Core.Mimiamp;
using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

public sealed record TrackRow(MimiampTrack Track, string Title, string Detail, string Length, bool Youtube)
{
    public string Id => Track.Id;
}

public sealed record PlaylistRow(MimiampPlaylist Playlist, string Name, string Count)
{
    public string Id => Playlist.Id;
}

/// <summary>
/// Mimiamp (docs/native/media.md 1): the library and playlists from <c>/api/mimiamp/state</c>, the queue
/// with shuffle / repeat, YouTube (prepare before play), the ten-band EQ, and what an agent tells the
/// player over the socket (<c>mimiamp</c> frames, media.md 1.4).
/// </summary>
public sealed partial class MimiampViewModel : ObservableObject
{
    private readonly MimiSession session;
    private readonly IAudioPlayer player;
    private readonly IUiDispatcher ui;
    private readonly AppConfig config;
    private readonly Action save;
    private readonly PlayQueue queue = new();
    private MimiampState state = new();
    private CancellationTokenSource? loading;

    public MimiampViewModel(MimiSession session, IAudioPlayer player, IUiDispatcher ui, AppConfig config, Action save)
    {
        this.session = session;
        this.player = player;
        this.ui = ui;
        this.config = config;
        this.save = save;
        player.Equalizer.Enabled = config.EqEnabled;
        player.Equalizer.SetGains(config.EqGains);
        player.Volume = config.Volume / 100f;
        volume = config.Volume;
        player.Pan = config.Pan;
        pan = Math.Round(config.Pan * 100);
        visualizer = config.Visualizer;
        eqEnabled = config.EqEnabled;
        queue.SetShuffle(config.Shuffle);
        shuffle = config.Shuffle;
        queue.Repeat = config.Repeat switch { "all" => RepeatMode.All, "one" => RepeatMode.One, _ => RepeatMode.Off };
        repeat = queue.Repeat;
        Gains = new ObservableCollection<float>(player.Equalizer.Gains);
        player.Ended += () => ui.Post(() => _ = PlayTrack(queue.Ended(), keepQueue: true));
        player.StateChanged += () => ui.Post(() => Playing = player.Playing);
        session.Frame += frame =>
        {
            if (frame is ServerFrame.Mimiamp command) _ = Apply(command.Command);
        };
    }

    public ObservableCollection<TrackRow> Tracks { get; } = [];
    public ObservableCollection<PlaylistRow> Playlists { get; } = [];
    public ObservableCollection<float> Gains { get; }
    public IReadOnlyList<string> Presets { get; } = [.. Equalizer.Presets.Keys];
    public IReadOnlyList<string> BandLabels { get; } = Equalizer.BandLabels;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNowPlaying))]
    private string nowTitle = "";

    [ObservableProperty]
    private string nowDetail = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PlayGlyph))]
    private bool playing;

    [ObservableProperty]
    private bool preparing;

    [ObservableProperty]
    private double positionSeconds;

    [ObservableProperty]
    private double durationSeconds;

    [ObservableProperty]
    private string clock = "0:00 / 0:00";

    [ObservableProperty]
    private int volume;

    [ObservableProperty]
    private bool shuffle;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RepeatLabel))]
    private RepeatMode repeat;

    [ObservableProperty]
    private bool eqEnabled;

    /// <summary>Balance, -100 (left) … 100 (right).</summary>
    [ObservableProperty]
    private double pan;

    [ObservableProperty]
    private bool visualizer;

    [ObservableProperty]
    private string error = "";

    [ObservableProperty]
    private string youtubeText = "";

    [ObservableProperty]
    private string listTitle = "เพลงทั้งหมด";

    /// <summary>The playlist on screen; null = the whole library.</summary>
    [ObservableProperty]
    private PlaylistRow? openPlaylist;

    public bool HasNowPlaying => NowTitle.Length > 0;
    public string PlayGlyph => Playing ? "" : "";
    public string RepeatLabel => Repeat switch { RepeatMode.All => "วนทั้งหมด", RepeatMode.One => "วนเพลงเดียว", _ => "ไม่วน" };
    public MimiampTrack? Current => queue.Current;

    /// <summary>An agent asked to show the player.</summary>
    public event Action? OpenRequested;

    private static TrackRow Row(MimiampTrack track) => new(
        track,
        track.Title,
        string.Join(" · ", new[] { track.Artist, track.Album }.Where(text => !string.IsNullOrEmpty(text))),
        track.Duration is { } seconds ? PlayQueue.Clock(seconds) : "",
        track.Source == "youtube");

    [RelayCommand]
    public async Task Refresh()
    {
        Error = "";
        try
        {
            state = await session.Api.MimiampState();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            Error = $"โหลดคลังเพลงไม่ได้: {problem.Message}";
            return;
        }
        Playlists.Clear();
        foreach (var playlist in state.PlaylistList) Playlists.Add(new PlaylistRow(playlist, playlist.Name, $"{playlist.Entries.Count} เพลง"));
        ShowList(OpenPlaylist is { } open ? state.PlaylistList.FirstOrDefault(item => item.Id == open.Id) : null);
    }

    /// <summary>Songs of this computer (Config.LocalTracks), played from disk without the server.</summary>
    public static MimiampTrack LocalTrack(string path) =>
        new($"local:{path}", "local", Path.GetFileNameWithoutExtension(path), File: path, Artist: "ไฟล์ในเครื่อง", Url: new Uri(path).AbsoluteUri);

    public static readonly string[] LocalTypes = [".mp3", ".m4a", ".aac", ".wav", ".flac", ".wma", ".ogg", ".opus"];

    public void AddLocalFiles(IEnumerable<string> paths)
    {
        var added = 0;
        foreach (var path in paths)
        {
            if (!LocalTypes.Contains(Path.GetExtension(path).ToLowerInvariant()) || config.LocalTracks.Contains(path, StringComparer.OrdinalIgnoreCase)) continue;
            config.LocalTracks.Add(path);
            added++;
        }
        save();
        if (OpenPlaylist is null) ShowList(null);
        Error = added == 0 ? "ไม่มีไฟล์เสียงใหม่ (mp3, m4a, wav, flac, ogg…)" : "";
    }

    public void RemoveLocal(TrackRow row)
    {
        if (row.Track.Source != "local" || row.Track.File is null) return;
        config.LocalTracks.RemoveAll(path => string.Equals(path, row.Track.File, StringComparison.OrdinalIgnoreCase));
        save();
        if (OpenPlaylist is null) ShowList(null);
    }

    /// <summary>Levels for the visualizer bars (0–1).</summary>
    public float[] Bars(int count) => Playing ? player.Spectrum.Bars(count) : new float[count];

    partial void OnPanChanged(double value)
    {
        player.Pan = (float)Math.Clamp(value / 100, -1, 1);
        config.Pan = player.Pan;
        save();
    }

    partial void OnVisualizerChanged(bool value)
    {
        config.Visualizer = value;
        save();
    }

    private void ShowList(MimiampPlaylist? playlist)
    {
        var list = playlist is null ? state.TrackList.Concat(config.LocalTracks.Select(LocalTrack)).ToList() : PlayQueue.TracksOf(playlist, state.TrackList);
        OpenPlaylist = playlist is null ? null : Playlists.FirstOrDefault(row => row.Id == playlist.Id);
        ListTitle = playlist?.Name ?? "เพลงทั้งหมด";
        Tracks.Clear();
        foreach (var track in list) Tracks.Add(Row(track));
    }

    [RelayCommand]
    public void ShowLibrary() => ShowList(null);

    [RelayCommand]
    public void ShowPlaylist(PlaylistRow row) => ShowList(row.Playlist);

    /// <summary>Plays a song of the list on screen; the list becomes the queue.</summary>
    [RelayCommand]
    public Task PlayRow(TrackRow row)
    {
        var list = Tracks.Select(item => item.Track).ToList();
        queue.Load(list, list.FindIndex(track => track.Id == row.Id));
        return PlayTrack(queue.Current, keepQueue: true);
    }

    private async Task PlayTrack(MimiampTrack? track, bool keepQueue)
    {
        if (track is null)
        {
            player.Stop();
            Playing = false;
            return;
        }
        loading?.Cancel();
        var cancel = (loading = new CancellationTokenSource()).Token;
        NowTitle = track.Title;
        NowDetail = string.Join(" · ", new[] { track.Artist, track.Album }.Where(text => !string.IsNullOrEmpty(text)));
        Error = "";
        try
        {
            var url = track.Url;
            if (track.Source == "youtube" && track.VideoId is not null)
            {
                // The server fetches the sound first (it may take a while: media.md 1.2).
                Preparing = true;
                var prepared = await session.Api.PrepareYoutube(track.VideoId, cancel);
                url = prepared.Url;
            }
            if (cancel.IsCancellationRequested) return;
            await player.Play(track.Source == "local" && track.File is { } file ? new Uri(file) : session.Api.Absolute(url), cancel);
            DurationSeconds = player.Duration.TotalSeconds > 0 ? player.Duration.TotalSeconds : track.Duration ?? 0;
            Playing = true;
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception problem)
        {
            Error = $"เล่น \"{track.Title}\" ไม่ได้: {problem.Message}";
            Playing = false;
        }
        finally
        {
            Preparing = false;
        }
    }

    /// <summary>Called by the screen a few times a second while it shows the player.</summary>
    public void Tick()
    {
        PositionSeconds = player.Position.TotalSeconds;
        if (player.Duration.TotalSeconds > 0) DurationSeconds = player.Duration.TotalSeconds;
        Clock = $"{PlayQueue.Clock(PositionSeconds)} / {PlayQueue.Clock(DurationSeconds)}";
    }

    [RelayCommand]
    public async Task Toggle()
    {
        if (player.Playing)
        {
            player.Pause();
        }
        else if (queue.Current is null)
        {
            if (Tracks.Count > 0) await PlayRow(Tracks[0]);
        }
        else if (player.Duration > TimeSpan.Zero)
        {
            player.Resume();
        }
        else
        {
            await PlayTrack(queue.Current, keepQueue: true);
        }
        Playing = player.Playing;
    }

    [RelayCommand]
    public Task Next() => PlayTrack(queue.Next(), keepQueue: true);

    [RelayCommand]
    public Task Previous()
    {
        // Like any player: a song past its first seconds starts over first.
        if (player.Position > TimeSpan.FromSeconds(3) && queue.Current is not null)
        {
            player.Seek(TimeSpan.Zero);
            return Task.CompletedTask;
        }
        return PlayTrack(queue.Previous(), keepQueue: true);
    }

    [RelayCommand]
    public void StopPlaying()
    {
        player.Stop();
        Playing = false;
    }

    public void SeekTo(double seconds) => player.Seek(TimeSpan.FromSeconds(Math.Max(0, seconds)));

    /// <summary>The volume as a slider wants it.</summary>
    public double VolumeLevel
    {
        get => Volume;
        set => Volume = (int)Math.Round(Math.Clamp(value, 0, 100));
    }

    partial void OnVolumeChanged(int value)
    {
        OnPropertyChanged(nameof(VolumeLevel));
        player.Volume = Math.Clamp(value, 0, 100) / 100f;
        config.Volume = Math.Clamp(value, 0, 100);
        save();
    }

    partial void OnShuffleChanged(bool value)
    {
        queue.SetShuffle(value);
        config.Shuffle = value;
        save();
    }

    partial void OnRepeatChanged(RepeatMode value)
    {
        queue.Repeat = value;
        config.Repeat = value switch { RepeatMode.All => "all", RepeatMode.One => "one", _ => "off" };
        save();
    }

    partial void OnEqEnabledChanged(bool value)
    {
        player.Equalizer.Enabled = value;
        config.EqEnabled = value;
        save();
    }

    [RelayCommand]
    public void CycleRepeat() => Repeat = Repeat switch { RepeatMode.Off => RepeatMode.All, RepeatMode.All => RepeatMode.One, _ => RepeatMode.Off };

    public void SetGain(int band, float db)
    {
        player.Equalizer.SetGain(band, db);
        Gains[band] = player.Equalizer.Gains[band];
        config.EqGains = player.Equalizer.Gains;
        save();
    }

    [RelayCommand]
    public void ApplyPreset(string name)
    {
        if (!Equalizer.Presets.TryGetValue(name, out var gains)) return;
        player.Equalizer.SetGains(gains);
        for (var i = 0; i < gains.Length; i++) Gains[i] = gains[i];
        EqEnabled = true;
        config.EqGains = player.Equalizer.Gains;
        save();
    }

    /// <summary>Adds a YouTube link to the library (media.md 1.2).</summary>
    [RelayCommand]
    public async Task AddYoutube()
    {
        var link = YoutubeText.Trim();
        if (link.Length == 0) return;
        Error = "";
        try
        {
            await session.Api.AddYoutube(link, OpenPlaylist?.Id);
            YoutubeText = "";
            await Refresh();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException or TaskCanceledException)
        {
            Error = problem.Message;
        }
    }

    [RelayCommand]
    public async Task NewPlaylist(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return;
        try
        {
            await session.Api.CreatePlaylist(name.Trim());
            await Refresh();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = problem.Message;
        }
    }

    public async Task AddToPlaylist(PlaylistRow playlist, TrackRow track)
    {
        try
        {
            await session.Api.AddToPlaylist(playlist.Id, track.Id);
            await Refresh();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = problem.Message;
        }
    }

    public async Task DeletePlaylist(PlaylistRow playlist)
    {
        try
        {
            await session.Api.DeletePlaylist(playlist.Id);
            if (OpenPlaylist?.Id == playlist.Id) OpenPlaylist = null;
            await Refresh();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = problem.Message;
        }
    }

    private static MemoryStream JsonBody(object body) => new(System.Text.Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(body)));

    /// <summary>Renames a playlist (feature-mimiamp.js, PATCH /api/mimiamp/playlists/:id).</summary>
    public async Task RenamePlaylist(PlaylistRow playlist, string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return;
        try
        {
            await session.Api.SendBody(HttpMethod.Patch, $"/api/mimiamp/playlists/{Uri.EscapeDataString(playlist.Id)}", JsonBody(new { name = name.Trim() }), "application/json");
            await Refresh();
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = problem.Message;
        }
    }

    /// <summary>A playlist as the web exports it (mimiamp-playlist JSON), to save as a file.</summary>
    public async Task<string?> ExportPlaylist(PlaylistRow playlist)
    {
        try
        {
            var data = await session.Api.SendBody(HttpMethod.Get, $"/api/mimiamp/playlists/{Uri.EscapeDataString(playlist.Id)}/export");
            return System.Text.Json.JsonSerializer.Serialize(data, new System.Text.Json.JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = problem.Message;
            return null;
        }
    }

    /// <summary>Imports a playlist file exported by Mimiamp (here or on the web).</summary>
    public async Task ImportPlaylist(string text)
    {
        try
        {
            using var parsed = System.Text.Json.JsonDocument.Parse(text);
            await session.Api.PostJson("/api/mimiamp/import", new { playlist = parsed.RootElement.Clone() });
            await Refresh();
        }
        catch (System.Text.Json.JsonException)
        {
            Error = "ไฟล์ไม่ใช่ JSON ที่ถูกต้อง";
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException)
        {
            Error = $"นำเข้าไม่ได้: {problem.Message}";
        }
    }

    /// <summary>What an agent asks of the player (protocol.ts MimiampCommand).</summary>
    public async Task Apply(MimiampCommand command)
    {
        switch (command.Action)
        {
            case "refresh":
                await Refresh();
                break;
            case "open":
                OpenRequested?.Invoke();
                break;
            case "pause":
                player.Pause();
                break;
            case "stop":
                StopPlaying();
                break;
            case "next":
                await Next();
                break;
            case "previous":
                await Previous();
                break;
            case "volume" when command.Level is { } level:
                Volume = (int)Math.Clamp(level, 0, 100);
                break;
            case "seek" when command.Seconds is { } seconds:
                SeekTo(seconds);
                break;
            case "playlist-play":
            {
                await Refresh();
                var playlist = state.PlaylistList.FirstOrDefault(item => item.Id == command.Query) ?? state.PlaylistList.FirstOrDefault(item => item.Name == command.Query);
                if (playlist is null) return;
                ShowList(playlist);
                queue.Load(PlayQueue.TracksOf(playlist, state.TrackList));
                await PlayTrack(queue.Current, keepQueue: true);
                break;
            }
            case "play":
            {
                if (string.IsNullOrWhiteSpace(command.Query))
                {
                    if (queue.Current is null || !player.Playing) await Toggle();
                    return;
                }
                // The queue first, then the whole library (reloaded) — media.md 1.4.
                var found = PlayQueue.Find(queue.Tracks, command.Query);
                if (found is null)
                {
                    if (state.TrackList.Count == 0) await Refresh();
                    found = PlayQueue.Find(state.TrackList, command.Query);
                }
                if (found is null)
                {
                    await Refresh();
                    found = PlayQueue.Find(state.TrackList, command.Query);
                }
                if (found is null) return;
                var list = queue.Tracks.Any(track => track.Id == found.Id) ? queue.Tracks : state.TrackList;
                queue.Load(list, list.ToList().FindIndex(track => track.Id == found.Id));
                await PlayTrack(queue.Current, keepQueue: true);
                break;
            }
        }
        Playing = player.Playing;
    }
}
