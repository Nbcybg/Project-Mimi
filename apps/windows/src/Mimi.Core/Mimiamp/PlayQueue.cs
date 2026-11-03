using Mimi.Core.Protocol;

namespace Mimi.Core.Mimiamp;

public enum RepeatMode
{
    Off,
    All,
    One,
}

/// <summary>
/// What plays now and next: the queue, shuffle and repeat, the way the web player steps through songs
/// (feature-mimiamp.js). No audio here; the player asks it which track comes next.
/// </summary>
public sealed class PlayQueue
{
    private readonly Random random;
    private List<MimiampTrack> tracks = [];
    private List<int> order = [];
    private int at = -1;

    public PlayQueue(Random? random = null) => this.random = random ?? Random.Shared;

    public IReadOnlyList<MimiampTrack> Tracks => tracks;
    public bool Shuffle { get; private set; }
    public RepeatMode Repeat { get; set; } = RepeatMode.Off;
    public MimiampTrack? Current => at >= 0 && at < order.Count ? tracks[order[at]] : null;

    /// <summary>Replaces the queue and stands on <paramref name="start"/>.</summary>
    public void Load(IReadOnlyList<MimiampTrack> list, int start = 0)
    {
        tracks = [.. list];
        at = tracks.Count == 0 ? -1 : 0;
        BuildOrder(Math.Clamp(start, 0, Math.Max(0, tracks.Count - 1)));
    }

    public void SetShuffle(bool on)
    {
        if (Shuffle == on) return;
        Shuffle = on;
        var current = at >= 0 && at < order.Count ? order[at] : 0;
        BuildOrder(current);
    }

    private void BuildOrder(int first)
    {
        order = Enumerable.Range(0, tracks.Count).ToList();
        if (tracks.Count == 0)
        {
            at = -1;
            return;
        }
        if (Shuffle)
        {
            order.Remove(first);
            for (var i = order.Count - 1; i > 0; i--)
            {
                var j = random.Next(i + 1);
                (order[i], order[j]) = (order[j], order[i]);
            }
            order.Insert(0, first);
            at = 0;
        }
        else
        {
            at = first;
        }
    }

    /// <summary>The song after this one when it ends by itself (repeat one plays it again).</summary>
    public MimiampTrack? Ended() => Repeat == RepeatMode.One ? Current : Next(byUser: false);

    /// <summary>The next song; at the end, the first one again with repeat all (or a pressed "next"), else nothing.</summary>
    public MimiampTrack? Next(bool byUser = true)
    {
        if (order.Count == 0) return null;
        if (at + 1 < order.Count)
        {
            at++;
            return Current;
        }
        if (Repeat == RepeatMode.All || byUser)
        {
            if (Shuffle) BuildOrder(order[at]);
            at = Shuffle && order.Count > 1 ? 1 : 0;
            return Current;
        }
        return null;
    }

    public MimiampTrack? Previous()
    {
        if (order.Count == 0) return null;
        at = at > 0 ? at - 1 : Repeat == RepeatMode.All ? order.Count - 1 : 0;
        return Current;
    }

    /// <summary>
    /// Finds the song an agent named (<c>mimiamp play {query}</c>), the way the web player does: an exact
    /// id / title / artist / album / file / video id first, then the first one that contains the words.
    /// </summary>
    public static MimiampTrack? Find(IReadOnlyList<MimiampTrack> list, string query)
    {
        var wanted = query.Trim().ToLowerInvariant();
        if (wanted.Length == 0) return null;
        static IEnumerable<string> Fields(MimiampTrack track) =>
            new[] { track.Id, track.Title, track.Artist, track.Album, track.File, track.VideoId }.OfType<string>().Select(text => text.ToLowerInvariant());
        return list.FirstOrDefault(track => Fields(track).Contains(wanted)) ?? list.FirstOrDefault(track => Fields(track).Any(text => text.Contains(wanted, StringComparison.Ordinal)));
    }

    /// <summary>The library tracks a playlist names, in its order (songs on another device are skipped).</summary>
    public static IReadOnlyList<MimiampTrack> TracksOf(MimiampPlaylist playlist, IReadOnlyList<MimiampTrack> library)
    {
        var byId = library.ToDictionary(track => track.Id);
        var list = new List<MimiampTrack>();
        foreach (var item in playlist.Entries)
        {
            if (item.TrackId is not null && byId.TryGetValue(item.TrackId, out var known)) list.Add(known);
            else if (item.Source == "file" && item.File is not null && byId.TryGetValue($"file:{item.File}", out var file)) list.Add(file);
            else if (item.Source == "youtube" && item.VideoId is not null)
            {
                list.Add(byId.TryGetValue($"youtube:{item.VideoId}", out var video)
                    ? video
                    : new MimiampTrack($"youtube:{item.VideoId}", "youtube", item.Title, VideoId: item.VideoId, Artist: item.Artist, Duration: item.Duration, Thumbnail: item.Thumbnail));
            }
        }
        return list;
    }

    public static string Clock(double seconds)
    {
        var whole = (int)Math.Max(0, Math.Floor(seconds));
        var (mins, secs) = (whole / 60, whole % 60);
        return mins >= 60 ? $"{mins / 60}:{mins % 60:00}:{secs:00}" : $"{mins}:{secs:00}";
    }
}
