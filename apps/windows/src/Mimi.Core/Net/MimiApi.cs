using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Mimi.Core.Protocol;

namespace Mimi.Core.Net;

/// <summary>A refusal of the server, with its own message (<c>{"error": …}</c>, api-contract.md 0).</summary>
public sealed class MimiHttpException(HttpStatusCode status, string message, bool twoFactor = false) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
    /// <summary>The password was right, the account wants its authenticator code (auth-and-session.md 3.1).</summary>
    public bool TwoFactor { get; } = twoFactor;
}

/// <summary>
/// The HTTP side of the core / gateway (docs/native/api-contract.md part A). Every <c>/api/*</c> and
/// <c>/mimiamp/*</c> request carries the Bearer token; there are no cookies.
/// </summary>
public sealed class MimiApi(HttpClient http, Func<string?> server, Func<string?> token)
{
    public HttpClient Http => http;

    public string Base => server() ?? throw new InvalidOperationException("no server");

    /// <summary>A path the server gave (e.g. <c>/mimiamp/Song.wav</c>) made absolute.</summary>
    public Uri Absolute(string path) => new(new Uri(Base), path);

    private HttpRequestMessage Request(HttpMethod method, string path, bool auth = true)
    {
        var request = new HttpRequestMessage(method, Absolute(path));
        var value = token();
        if (auth && !string.IsNullOrEmpty(value)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", value);
        return request;
    }

    /// <summary>Adds the token to a request built elsewhere (the audio stream, images).</summary>
    public void Authorize(HttpRequestMessage request)
    {
        var value = token();
        if (!string.IsNullOrEmpty(value)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", value);
    }

    private static async Task<MimiHttpException> Failure(HttpResponseMessage response, CancellationToken cancel)
    {
        var body = await response.Content.ReadAsStringAsync(cancel).ConfigureAwait(false);
        ErrorBody? error = null;
        try
        {
            error = JsonSerializer.Deserialize<ErrorBody>(body, MimiJson.Options);
        }
        catch (JsonException)
        {
        }
        var message = string.IsNullOrWhiteSpace(error?.Error) ? $"HTTP {(int)response.StatusCode}" : error!.Error;
        return new MimiHttpException(response.StatusCode, message, error?.TwoFactor ?? false);
    }

    private async Task<T> Send<T>(HttpRequestMessage request, CancellationToken cancel)
    {
        using (request)
        using (var response = await http.SendAsync(request, cancel).ConfigureAwait(false))
        {
            if (!response.IsSuccessStatusCode) throw await Failure(response, cancel).ConfigureAwait(false);
            return (await response.Content.ReadFromJsonAsync<T>(MimiJson.Options, cancel).ConfigureAwait(false))!;
        }
    }

    private Task<T> Get<T>(string path, CancellationToken cancel) => Send<T>(Request(HttpMethod.Get, path), cancel);

    private Task<T> Post<T>(string path, object? body, CancellationToken cancel, bool auth = true)
    {
        var request = Request(HttpMethod.Post, path, auth);
        request.Content = JsonContent.Create(body ?? new { }, options: MimiJson.Options);
        return Send<T>(request, cancel);
    }

    // ---------- connecting (auth-and-session.md) ----------

    /// <summary><c>GET /health</c> of any server address, before one is chosen.</summary>
    public async Task<Health> Health(string address, CancellationToken cancel = default)
    {
        using var response = await http.GetAsync(new Uri(new Uri(address), "/health"), cancel).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new MimiHttpException(response.StatusCode, "ไม่ใช่เซิร์ฟเวอร์ Mimi");
        return (await response.Content.ReadFromJsonAsync<Health>(MimiJson.Options, cancel).ConfigureAwait(false)) ?? new Health();
    }

    public Task<LoginResponse> Login(LoginRequest login, CancellationToken cancel = default) => Post<LoginResponse>("/auth/login", login, cancel, auth: false);

    /// <summary>Ends a gateway session; offline is fine (the session lapses by itself).</summary>
    public async Task Logout(string sessionToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, Absolute("/auth/logout"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", sessionToken);
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var _ = await http.SendAsync(request, cancel.Token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
        }
    }

    /// <summary>Checks a token of a single core (no login endpoint there): 401 = wrong.</summary>
    public Task<WidgetView> Widget(CancellationToken cancel = default) => Get<WidgetView>("/api/widget", cancel);

    // ---------- chat files (A.3, A.4) ----------

    public async Task<AttachmentView> Upload(Stream content, string name, string mime, string? caption = null, CancellationToken cancel = default)
    {
        var request = Request(HttpMethod.Post, $"/api/upload?name={Uri.EscapeDataString(name)}");
        request.Content = new StreamContent(content);
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(string.IsNullOrEmpty(mime) ? "application/octet-stream" : mime);
        if (!string.IsNullOrEmpty(caption)) request.Headers.Add("X-Mimi-Caption", Uri.EscapeDataString(caption));
        return await Send<AttachmentView>(request, cancel).ConfigureAwait(false);
    }

    public async Task<byte[]> Bytes(string path, CancellationToken cancel = default)
    {
        using var request = Request(HttpMethod.Get, path);
        using var response = await http.SendAsync(request, cancel).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw await Failure(response, cancel).ConfigureAwait(false);
        return await response.Content.ReadAsByteArrayAsync(cancel).ConfigureAwait(false);
    }

    /// <summary>Any request with a raw body (pictures, models, files) or none; answers the JSON the server sends (or null).</summary>
    public async Task<JsonElement> SendBody(HttpMethod method, string path, Stream? body = null, string? contentType = null, CancellationToken cancel = default)
    {
        using var request = Request(method, path);
        if (body is not null)
        {
            request.Content = new StreamContent(body);
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType);
        }
        using var response = await http.SendAsync(request, cancel).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw await Failure(response, cancel).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(cancel).ConfigureAwait(false);
        try
        {
            return string.IsNullOrWhiteSpace(text) ? default : JsonDocument.Parse(text).RootElement.Clone();
        }
        catch (JsonException)
        {
            return default;
        }
    }

    /// <summary>POST of a JSON body to any route (2FA, password); the server's JSON answer.</summary>
    public Task<JsonElement> PostJson(string path, object body, CancellationToken cancel = default) => Post<JsonElement>(path, body, cancel);

    public static string FilePath(string attachmentId) => $"/api/files/{Uri.EscapeDataString(attachmentId)}";

    public static string AgentImagePath(string agent, string kind, string stamp) =>
        $"/api/agent-image/{Uri.EscapeDataString(agent)}/{kind}?v={Uri.EscapeDataString(stamp)}";

    // ---------- notifications (A.6, A.6.2) ----------

    public Task<List<NotificationSyncItem>> NotificationsAfter(long afterId, CancellationToken cancel = default) =>
        Get<List<NotificationSyncItem>>($"/api/notifications?afterId={afterId}", cancel);

    public Task<JsonElement> AnswerPermission(string requestId, bool allow, string scope = "once", CancellationToken cancel = default) =>
        Post<JsonElement>($"/api/permissions/{Uri.EscapeDataString(requestId)}", allow ? new { allow, scope } : (object)new { allow }, cancel);

    // ---------- Mimiamp (A.7) ----------

    public Task<MimiampState> MimiampState(CancellationToken cancel = default) => Get<MimiampState>("/api/mimiamp/state", cancel);

    public Task<YoutubePrepared> PrepareYoutube(string videoId, CancellationToken cancel = default) =>
        Post<YoutubePrepared>($"/api/mimiamp/youtube/{Uri.EscapeDataString(videoId)}/prepare", null, cancel);

    public Task<TrackReply> AddYoutube(string url, string? playlist = null, CancellationToken cancel = default) =>
        Post<TrackReply>("/api/mimiamp/youtube", new { url, playlist }, cancel);

    public Task<YoutubeSearchReply> SearchYoutube(string query, CancellationToken cancel = default) =>
        Get<YoutubeSearchReply>($"/api/mimiamp/youtube/search?q={Uri.EscapeDataString(query)}", cancel);

    public Task<PlaylistReply> CreatePlaylist(string name, CancellationToken cancel = default) =>
        Post<PlaylistReply>("/api/mimiamp/playlists", new { name }, cancel);

    public async Task DeletePlaylist(string id, CancellationToken cancel = default) =>
        await Send<JsonElement>(Request(HttpMethod.Delete, $"/api/mimiamp/playlists/{Uri.EscapeDataString(id)}"), cancel).ConfigureAwait(false);

    public Task<PlaylistReply> AddToPlaylist(string playlistId, string trackId, CancellationToken cancel = default) =>
        Post<PlaylistReply>($"/api/mimiamp/playlists/{Uri.EscapeDataString(playlistId)}/items", new { trackId }, cancel);

    public Task<PlaylistReply> RemoveFromPlaylist(string playlistId, string itemId, CancellationToken cancel = default) =>
        Send<PlaylistReply>(Request(HttpMethod.Delete, $"/api/mimiamp/playlists/{Uri.EscapeDataString(playlistId)}/items/{Uri.EscapeDataString(itemId)}"), cancel);

    /// <summary>A request for a range of bytes of a song or file, with the token (media.md 1.3: Bearer on <c>/mimiamp/*</c> too).</summary>
    public HttpRequestMessage RangeRequest(Uri url, long from, long? to)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        Authorize(request);
        request.Headers.Range = new RangeHeaderValue(from, to);
        return request;
    }
}
