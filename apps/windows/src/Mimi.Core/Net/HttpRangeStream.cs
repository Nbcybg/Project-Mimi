using System.Net;
using System.Net.Http.Headers;

namespace Mimi.Core.Net;

/// <summary>
/// A seekable, read-only stream over HTTP Range requests (media.md 1.3: songs and files support Range,
/// and need the Bearer header, which Windows' own media URLs cannot carry). Reads go through a window
/// of <see cref="ChunkSize"/> bytes, so a decoder's small reads and seeks cost few requests.
/// When the server ignores Range (a core before api 1), the whole body is read once and kept.
/// </summary>
public sealed class HttpRangeStream : Stream
{
    public const int ChunkSize = 256 * 1024;

    private readonly HttpClient http;
    private readonly Func<long, long?, HttpRequestMessage> request;
    private long length = -1;
    private long position;
    private byte[] window = [];
    private long windowStart;
    private byte[]? whole;

    private HttpRangeStream(HttpClient http, Func<long, long?, HttpRequestMessage> request)
    {
        this.http = http;
        this.request = request;
    }

    /// <summary>Opens the stream: one first request learns the length (Content-Range) and fills the first window.</summary>
    public static async Task<HttpRangeStream> Open(HttpClient http, Func<long, long?, HttpRequestMessage> request, CancellationToken cancel = default)
    {
        var stream = new HttpRangeStream(http, request);
        await stream.Fill(0, cancel).ConfigureAwait(false);
        return stream;
    }

    /// <summary>Content-Type of the first answer (what the decoder may need to know).</summary>
    public string? ContentType { get; private set; }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => length;

    public override long Position
    {
        get => position;
        set => position = Math.Clamp(value, 0, length);
    }

    private async Task Fill(long from, CancellationToken cancel)
    {
        using var message = request(from, length >= 0 ? Math.Min(from + ChunkSize, length) - 1 : from + ChunkSize - 1);
        using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false);
        ContentType ??= response.Content.Headers.ContentType?.MediaType;
        if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
        {
            window = [];
            windowStart = from;
            if (length < 0) length = from;
            return;
        }
        if (!response.IsSuccessStatusCode) throw new MimiHttpException(response.StatusCode, $"HTTP {(int)response.StatusCode}");
        if (response.StatusCode == HttpStatusCode.PartialContent && response.Content.Headers.ContentRange is ContentRangeHeaderValue range)
        {
            if (range.Length is long total) length = total;
            window = await response.Content.ReadAsByteArrayAsync(cancel).ConfigureAwait(false);
            windowStart = range.From ?? from;
            if (length < 0) length = windowStart + window.Length;
            return;
        }
        // 200: Range was not honoured. Keep the whole body (songs are a few tens of MB at most).
        whole = await response.Content.ReadAsByteArrayAsync(cancel).ConfigureAwait(false);
        length = whole.Length;
        window = whole;
        windowStart = 0;
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        if (position >= length || buffer.Length == 0) return 0;
        if (position < windowStart || position >= windowStart + window.Length)
        {
            if (whole is null) Fill(position, CancellationToken.None).GetAwaiter().GetResult();
            if (position < windowStart || position >= windowStart + window.Length) return 0;
        }
        var at = (int)(position - windowStart);
        var take = Math.Min(buffer.Length, window.Length - at);
        window.AsSpan(at, take).CopyTo(buffer);
        position += take;
        return take;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (position >= length || buffer.Length == 0) return 0;
        if ((position < windowStart || position >= windowStart + window.Length) && whole is null) await Fill(position, cancellationToken).ConfigureAwait(false);
        return Read(buffer.Span);
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => position + offset,
            _ => length + offset,
        };
        return position;
    }

    public override void Flush()
    {
    }

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
