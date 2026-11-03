using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Mimi.Core.Protocol;

namespace Mimi.Core.Net;

public abstract record SocketState
{
    public sealed record Idle : SocketState;
    public sealed record Connecting : SocketState;
    public sealed record Online(ServerFrame.Welcome Welcome) : SocketState;
    /// <summary>Lost; tries again by itself after <see cref="RetryIn"/>.</summary>
    public sealed record Offline(TimeSpan RetryIn) : SocketState;
    /// <summary>close 4003: the token no longer works. Never retried.</summary>
    public sealed record SignedOut : SocketState;
    /// <summary>close 4426: this app is older than the core serves. Never retried.</summary>
    public sealed record AppTooOld : SocketState;
    /// <summary>close 4029: too many wrong tokens from this address. Retried after 15 minutes.</summary>
    public sealed record RateLimited : SocketState;
}

/// <summary>The bits of a WebSocket the client needs; tests give a fake one.</summary>
public interface IWebSocketConnection : IDisposable
{
    Task ConnectAsync(Uri url, CancellationToken cancel);
    Task SendAsync(string text, CancellationToken cancel);
    /// <summary>The next text frame, or null with the close code when the socket ended.</summary>
    Task<(string? Text, int? CloseCode)> ReceiveAsync(CancellationToken cancel);
    void Abort();
}

public sealed class ClientWebSocketConnection : IWebSocketConnection
{
    // No Origin header and no keep-alive pings of our own at this level: the core pings us (realtime.md 7.1).
    private readonly ClientWebSocket socket = new() { Options = { KeepAliveInterval = TimeSpan.FromSeconds(30) } };
    private readonly SemaphoreSlim sending = new(1, 1);

    public Task ConnectAsync(Uri url, CancellationToken cancel) => socket.ConnectAsync(url, cancel);

    public async Task SendAsync(string text, CancellationToken cancel)
    {
        await sending.WaitAsync(cancel).ConfigureAwait(false);
        try
        {
            await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, cancel).ConfigureAwait(false);
        }
        finally
        {
            sending.Release();
        }
    }

    public async Task<(string? Text, int? CloseCode)> ReceiveAsync(CancellationToken cancel)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await socket.ReceiveAsync(buffer, cancel).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
                return (null, (int?)socket.CloseStatus);
            }
            if (result.MessageType == WebSocketMessageType.Close) return (null, (int?)result.CloseStatus);
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                if (result.MessageType != WebSocketMessageType.Text) return ("", null);
                return (Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length), null);
            }
        }
    }

    public void Abort() => socket.Abort();

    public void Dispose()
    {
        socket.Dispose();
        sending.Dispose();
    }
}

/// <summary>
/// The one WebSocket to <c>/ws</c> (docs/native/realtime.md): <c>hello</c> first, an app-level ping every
/// 25 s, a fresh socket when nothing was heard for a while, backoff 1 s → 15 s, and no retry after the
/// core said the token is dead (4003) or the app too old (4426). Same rules as the Android MimiSocket.
/// Events are raised on a background thread.
/// </summary>
public sealed class MimiSocket : IDisposable
{
    private readonly Func<IWebSocketConnection> connect;
    private readonly Func<(string? Server, string? Token)> session;
    private readonly string appVersion;
    private readonly object gate = new();
    private readonly Queue<string> waiting = new();
    private readonly TimeSpan ping;
    private IWebSocketConnection? socket;
    private CancellationTokenSource? run;
    private int generation;
    private TimeSpan retry = TimeSpan.FromSeconds(1);
    private DateTime lastTraffic;
    private bool wanted;
    private SocketState state = new SocketState.Idle();

    public MimiSocket(Func<IWebSocketConnection> connect, Func<(string? Server, string? Token)> session, string appVersion, TimeSpan? pingEvery = null)
    {
        this.connect = connect;
        this.session = session;
        this.appVersion = appVersion;
        ping = pingEvery ?? TimeSpan.FromSeconds(25);
    }

    public event Action<ServerFrame>? Frame;
    /// <summary>Every frame but pongs and chat events as JSON, after <see cref="Frame"/>: (type, frame).</summary>
    public event Action<string, JsonElement>? Raw;
    public event Action<SocketState>? StateChanged;

    public SocketState State
    {
        get
        {
            lock (gate) return state;
        }
    }

    public bool IsOnline => State is SocketState.Online;

    private void SetState(SocketState next)
    {
        lock (gate) state = next;
        StateChanged?.Invoke(next);
    }

    /// <summary>Connects (and keeps reconnecting) while a token is stored.</summary>
    public void Start()
    {
        lock (gate)
        {
            wanted = true;
            if (socket is not null) return;
        }
        var (server, token) = session();
        if (string.IsNullOrEmpty(server) || string.IsNullOrEmpty(token)) return;
        IWebSocketConnection mine;
        int number;
        CancellationTokenSource cancel;
        lock (gate)
        {
            if (socket is not null) return;
            run?.Cancel();
            run = cancel = new CancellationTokenSource();
            number = ++generation;
            socket = mine = connect();
            lastTraffic = DateTime.UtcNow;
        }
        SetState(new SocketState.Connecting());
        _ = Task.Run(() => Loop(mine, number, ServerAddress.WebSocketUrl(server), token, cancel.Token));
    }

    /// <summary>Closes for good (sign-out).</summary>
    public void Stop()
    {
        IWebSocketConnection? old;
        lock (gate)
        {
            wanted = false;
            generation++;
            run?.Cancel();
            run = null;
            old = socket;
            socket = null;
            waiting.Clear();
        }
        old?.Abort();
        old?.Dispose();
        SetState(new SocketState.Idle());
    }

    /// <summary>Back on screen / network back: a socket that heard nothing for 12 s is presumed dead and replaced.</summary>
    public void Wake()
    {
        IWebSocketConnection? current;
        lock (gate)
        {
            wanted = true;
            current = socket;
        }
        if (current is not null && DateTime.UtcNow - lastTraffic > TimeSpan.FromSeconds(12)) DropAndRetry(current, TimeSpan.Zero);
        else if (current is null && State is not (SocketState.SignedOut or SocketState.AppTooOld))
        {
            lock (gate) retry = TimeSpan.FromSeconds(1);
            Start();
        }
    }

    /// <summary>Sends now, or once the next <c>welcome</c> arrives (at most 100 waiting frames).</summary>
    public void Send(string frame)
    {
        IWebSocketConnection? current;
        lock (gate)
        {
            current = state is SocketState.Online ? socket : null;
            if (current is null)
            {
                if (waiting.Count < 100) waiting.Enqueue(frame);
                return;
            }
        }
        _ = SendQuietly(current, frame);
    }

    private static async Task SendQuietly(IWebSocketConnection connection, string frame)
    {
        try
        {
            await connection.SendAsync(frame, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception error) when (error is WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            // the receive loop notices the dead socket and reconnects
        }
    }

    private void DropAndRetry(IWebSocketConnection current, TimeSpan delay)
    {
        lock (gate)
        {
            if (!ReferenceEquals(socket, current)) return;
            generation++;
            socket = null;
        }
        current.Abort();
        current.Dispose();
        ScheduleRetry(delay);
    }

    private void ScheduleRetry(TimeSpan delay)
    {
        CancellationToken cancel;
        lock (gate)
        {
            if (!wanted) return;
            cancel = run?.Token ?? CancellationToken.None;
        }
        SetState(new SocketState.Offline(delay));
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, cancel).ConfigureAwait(false);
            }
            catch (TaskCanceledException)
            {
                return;
            }
            Start();
        });
    }

    private bool Current(int number)
    {
        lock (gate) return number == generation;
    }

    private async Task Loop(IWebSocketConnection mine, int number, Uri url, string token, CancellationToken cancel)
    {
        int? closeCode = null;
        using var heartbeat = new CancellationTokenSource();
        try
        {
            await mine.ConnectAsync(url, cancel).ConfigureAwait(false);
            lastTraffic = DateTime.UtcNow;
            await mine.SendAsync(ClientFrames.Hello(token, appVersion), cancel).ConfigureAwait(false);
            _ = Heartbeat(mine, number, heartbeat.Token);
            while (!cancel.IsCancellationRequested)
            {
                var (text, code) = await mine.ReceiveAsync(cancel).ConfigureAwait(false);
                if (text is null)
                {
                    closeCode = code;
                    break;
                }
                if (!Current(number)) return;
                lastTraffic = DateTime.UtcNow;
                var frame = FrameParser.Parse(text);
                if (frame is ServerFrame.Welcome welcome)
                {
                    string[] queued;
                    lock (gate)
                    {
                        retry = TimeSpan.FromSeconds(1);
                        queued = [.. waiting];
                        waiting.Clear();
                    }
                    SetState(new SocketState.Online(welcome));
                    foreach (var frameText in queued) await mine.SendAsync(frameText, cancel).ConfigureAwait(false);
                }
                if (frame is not ServerFrame.Pong) Deliver(frame);
                // The management screens read frames as plain JSON (all but the stream's own events).
                if (Raw is not null && frame is not (ServerFrame.Pong or ServerFrame.ChatEvent)) DeliverRaw(text);
            }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException or InvalidOperationException or IOException)
        {
        }
        finally
        {
            heartbeat.Cancel();
        }
        Ended(mine, number, closeCode);
    }

    private void DeliverRaw(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            var json = document.RootElement.Clone();
            if (json.ValueKind == JsonValueKind.Object && json.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String) Raw?.Invoke(type.GetString()!, json);
        }
        catch (Exception error)
        {
            System.Diagnostics.Trace.WriteLine($"mimi socket: a raw handler failed: {error}");
        }
    }

    /// <summary>A screen that trips over one frame must not take the connection down with it.</summary>
    private void Deliver(ServerFrame frame)
    {
        try
        {
            Frame?.Invoke(frame);
        }
        catch (Exception error)
        {
            System.Diagnostics.Trace.WriteLine($"mimi socket: a handler failed on {frame.GetType().Name}: {error}");
        }
    }

    private async Task Heartbeat(IWebSocketConnection mine, int number, CancellationToken cancel)
    {
        while (!cancel.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(ping, cancel).ConfigureAwait(false);
            }
            catch (TaskCanceledException)
            {
                return;
            }
            if (!Current(number)) return;
            // The last ping got no pong (or anything else) back: the socket is dead.
            if (DateTime.UtcNow - lastTraffic > ping + TimeSpan.FromSeconds(5)) DropAndRetry(mine, TimeSpan.Zero);
            else await SendQuietly(mine, ClientFrames.Simple("ping")).ConfigureAwait(false);
        }
    }

    private void Ended(IWebSocketConnection mine, int number, int? code)
    {
        TimeSpan wait;
        lock (gate)
        {
            if (number != generation) return;
            socket = null;
            wait = retry;
            retry = TimeSpan.FromTicks(Math.Min(retry.Ticks * 2, TimeSpan.FromSeconds(15).Ticks));
        }
        mine.Dispose();
        switch (code)
        {
            case CloseCodes.InvalidToken:
                SetState(new SocketState.SignedOut());
                break;
            case CloseCodes.ClientTooOld:
                SetState(new SocketState.AppTooOld());
                break;
            case CloseCodes.RateLimited:
                SetState(new SocketState.RateLimited());
                ScheduleRetryQuiet(TimeSpan.FromMinutes(15));
                break;
            default:
                ScheduleRetry(wait);
                break;
        }
    }

    private void ScheduleRetryQuiet(TimeSpan delay)
    {
        CancellationToken cancel;
        lock (gate)
        {
            if (!wanted) return;
            cancel = run?.Token ?? CancellationToken.None;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, cancel).ConfigureAwait(false);
            }
            catch (TaskCanceledException)
            {
                return;
            }
            Start();
        });
    }

    public void Dispose() => Stop();
}
