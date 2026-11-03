using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mimi.Core.Protocol;

/// <summary>The client API this app is built against (docs/native/api-versioning.md).</summary>
public static class ClientApi
{
    public const int Version = 1;

    /// <summary>
    /// The oldest core API this app works with. API 0 cores (before Phase 1) still chat, but lack
    /// <c>chat-turn-messages</c>, Range on files and push; the app copes (it reopens the chat after a turn).
    /// </summary>
    public const int MinSupportedCoreApi = 0;
}

/// <summary>Close codes of <c>/ws</c> (docs/native/realtime.md 7.4).</summary>
public static class CloseCodes
{
    public const int HelloTimeout = 4001;
    public const int InvalidToken = 4003;
    public const int RateLimited = 4029;
    public const int ClientTooOld = 4426;
    public const int GatewayCoreRefused = 4502;
}

/// <summary>One JSON setup for the whole app: newer cores add fields, so unknown ones are skipped.</summary>
public static class MimiJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static T? Decode<T>(JsonElement element)
    {
        try
        {
            return element.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? default : element.Deserialize<T>(Options);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    public static string Encode<T>(T value) => JsonSerializer.Serialize(value, Options);
}

public sealed record Health(bool Ok = false, string Version = "", int Api = 0, int MinClientApi = 0, bool Accounts = false);

public sealed record LoginRequest(string Username, string Password, string? Code = null);

public sealed record LoginResponse(string Token, string Username = "", string ExpiresAt = "", string WebhookBase = "");

public sealed record ErrorBody(string Error = "", bool TwoFactor = false);

public sealed record SpeechStyle(string? Emotion = null, string? Tone = null, string? Voice = null, double? Speed = null);

public sealed record AttachmentView(
    string Id,
    string Kind,
    string Name,
    string Mime,
    long Size = 0,
    string Text = "",
    string Caption = "",
    string? DeletedAt = null)
{
    public bool IsImage => Kind == "image" && DeletedAt is null;
}

public sealed record ToolSummary(string Name, string Summary = "");

public sealed record QuotedMessage(long Id, string Role, string Agent = "", string Text = "");

public sealed record ApprovalView(long Id, string Status, string Workflow = "", string ExpiresAt = "", string? Note = null);

/// <summary>Who a forwarded message came from: the writer, and the chat it was in.</summary>
public sealed record ForwardedFrom(string From, string Chat = "");

public sealed record ChatMessageView(
    long Id,
    string Role,
    string Agent = "",
    string Text = "",
    SpeechStyle? Speech = null,
    string CreatedAt = "",
    IReadOnlyList<AttachmentView>? Attachments = null,
    IReadOnlyList<ToolSummary>? Tools = null,
    QuotedMessage? ReplyTo = null,
    string? ClientId = null,
    ApprovalView? Approval = null,
    bool Pinned = false,
    ForwardedFrom? ForwardedFrom = null,
    IReadOnlyList<string>? Reactions = null)
{
    public IReadOnlyList<AttachmentView> Files => Attachments ?? [];
    public IReadOnlyList<ToolSummary> ToolList => Tools ?? [];
    public IReadOnlyList<string> ReactionList => Reactions ?? [];
}

/// <summary>A pinned message, as the pin bar lists it (protocol.ts PinView).</summary>
public sealed record PinView(long Id, long SessionId, string Role, string Agent = "", string Text = "", string CreatedAt = "");

/// <summary>One message found by <c>search</c>.</summary>
public sealed record SearchHit(
    long MessageId,
    long ChatId,
    long SessionId,
    string ChatTitle = "",
    string SessionTitle = "",
    string Role = "",
    string Agent = "",
    string Snippet = "",
    string CreatedAt = "");

public sealed record ChatView(
    long Id,
    string Kind,
    string Title = "",
    IReadOnlyList<string>? Agents = null,
    string? LastMessageAt = null,
    string Preview = "",
    bool Unread = false)
{
    public IReadOnlyList<string> AgentNames => Agents ?? [];
}

public sealed record SessionView(
    long Id,
    long ChatId,
    string Title = "",
    string Summary = "",
    bool Auto = true,
    string CreatedAt = "",
    string LastMessageAt = "",
    string? ReadAt = null,
    bool Unread = false);

public sealed record PermissionRequest(
    string Id,
    string Tool,
    string TraceId = "",
    string Agent = "",
    string Risk = "",
    JsonElement Input = default,
    string Summary = "",
    long TimeoutMs = 0,
    bool NoGrant = false,
    string CreatedAt = "");

public sealed record LiveTool(string Id, string Name, string Arg = "", string? Risk = null, bool? Ok = null, string Output = "");

public sealed record LiveTurnView(
    long SessionId,
    string Agent,
    string Model = "",
    string Text = "",
    SpeechStyle? Speech = null,
    IReadOnlyList<LiveTool>? Tools = null,
    IReadOnlyList<AttachmentView>? Attachments = null,
    IReadOnlyList<PermissionRequest>? PendingPermissions = null);

public sealed record AgentSummary(string Name, string? DisplayName = null, string Description = "");

/// <summary>The fields of an agent the chat screens use (the editor's are many more).</summary>
public sealed record AgentView(string Name, string? DisplayName = null, string Description = "", string? Avatar = null, string? Portrait = null)
{
    public string ShownName => string.IsNullOrWhiteSpace(DisplayName) ? Name : DisplayName!;
}

public sealed record NotificationSyncItem(long Id, string Kind, string Title = "", string Body = "", long? ChatId = null, string CreatedAt = "", bool Read = false);

public sealed record WidgetChat(long Id, string Title = "", string Agent = "", string? Avatar = null, string Preview = "", string? LastMessageAt = null, int Unread = 0);

public sealed record WidgetView(IReadOnlyList<WidgetChat>? Chats = null, long? BusyChat = null);

// ---------- Mimiamp (packages/shared/src/mimiamp.ts) ----------

public sealed record MimiampTrack(
    string Id,
    string Source,
    string Title,
    string? File = null,
    string? VideoId = null,
    string? Artist = null,
    string? Album = null,
    double? Duration = null,
    string Url = "",
    string? Thumbnail = null);

public sealed record MimiampPlaylistItem(
    string Id,
    string Source,
    string Title,
    string? TrackId = null,
    string? File = null,
    string? VideoId = null,
    string? LocalId = null,
    string? Artist = null,
    string? Album = null,
    double? Duration = null,
    string? Thumbnail = null,
    string AddedAt = "");

public sealed record MimiampPlaylist(string Id, string Name, string CreatedAt = "", string UpdatedAt = "", IReadOnlyList<MimiampPlaylistItem>? Items = null)
{
    public IReadOnlyList<MimiampPlaylistItem> Entries => Items ?? [];
}

public sealed record YoutubeStatus(bool Ready = false, bool Google = false, string? Error = null);

public sealed record MimiampState(IReadOnlyList<MimiampTrack>? Tracks = null, IReadOnlyList<MimiampPlaylist>? Playlists = null, YoutubeStatus? Youtube = null)
{
    public IReadOnlyList<MimiampTrack> TrackList => Tracks ?? [];
    public IReadOnlyList<MimiampPlaylist> PlaylistList => Playlists ?? [];
}

public sealed record YoutubeSearchResult(string VideoId, string Title, string? Artist = null, double? Duration = null, string? Thumbnail = null);

public sealed record YoutubeSearchReply(IReadOnlyList<YoutubeSearchResult>? Results = null, string Source = "none", string? Error = null);

public sealed record YoutubePrepared(string VideoId, string Url, string Mime = "");

public sealed record TrackReply(MimiampTrack? Track = null);

public sealed record PlaylistReply(MimiampPlaylist Playlist);

/// <summary>What an agent tells the player (protocol.ts MimiampCommand).</summary>
public sealed record MimiampCommand(string Action, string? Query = null, double? Level = null, double? Seconds = null);
