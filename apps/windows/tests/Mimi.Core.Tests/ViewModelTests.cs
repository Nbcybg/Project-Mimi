using System.Net;
using System.Text;
using System.Threading.Channels;
using Mimi.Core.Net;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;

namespace Mimi.Core.Tests;

/// <summary>A socket the test plays the core's part on.</summary>
public sealed class FakeSocket : IWebSocketConnection
{
    private readonly Channel<(string? Text, int? Code)> incoming = Channel.CreateUnbounded<(string?, int?)>();
    public List<string> Sent { get; } = [];
    public Uri? Url { get; private set; }

    public Task ConnectAsync(Uri url, CancellationToken cancel)
    {
        Url = url;
        return Task.CompletedTask;
    }

    public Task SendAsync(string text, CancellationToken cancel)
    {
        lock (Sent) Sent.Add(text);
        return Task.CompletedTask;
    }

    public async Task<(string? Text, int? CloseCode)> ReceiveAsync(CancellationToken cancel) => await incoming.Reader.ReadAsync(cancel);

    public void Push(string json) => incoming.Writer.TryWrite((json, null));
    public void Close(int code) => incoming.Writer.TryWrite((null, code));
    public void Abort() => incoming.Writer.TryWrite((null, 1006));
    public void Dispose() { }

    public string[] SentTypes()
    {
        lock (Sent) return Sent.Select(text => System.Text.Json.JsonDocument.Parse(text).RootElement.GetProperty("type").GetString()!).ToArray();
    }
}

public static class Wait
{
    // Frames arrive on the socket's thread in these tests (InlineDispatcher): a list may change while it is read.
    private static bool Safe(Func<bool> condition)
    {
        try
        {
            return condition();
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    public static async Task Until(Func<bool> condition, int ms = 3000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!Safe(condition))
        {
            if (DateTime.UtcNow > end) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }
}

public class SocketTests
{
    private const string Welcome = """{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"ui":{},"api":1,"minClientApi":1}""";

    [Fact]
    public async Task Hello_first_then_frames_that_waited_and_a_retry_after_a_drop()
    {
        var sockets = new List<FakeSocket>();
        var socket = new MimiSocket(() =>
        {
            var fake = new FakeSocket();
            lock (sockets) sockets.Add(fake);
            return fake;
        }, () => ("http://localhost:8787", "tok"), "1.0");
        socket.Send(ClientFrames.Simple("chats-list")); // before welcome: waits
        socket.Start();
        await Wait.Until(() => sockets.Count == 1 && sockets[0].Sent.Count == 1);
        Assert.Equal("ws://localhost:8787/ws", sockets[0].Url!.ToString());
        Assert.Equal(["hello"], sockets[0].SentTypes());
        sockets[0].Push(Welcome);
        await Wait.Until(() => socket.IsOnline && sockets[0].Sent.Count == 2);
        Assert.Equal(["hello", "chats-list"], sockets[0].SentTypes());

        sockets[0].Close(1006); // dropped: a new socket after the first backoff step (1 s)
        await Wait.Until(() => sockets.Count == 2, 4000);
        socket.Stop();
    }

    [Fact]
    public async Task A_dead_token_is_never_retried()
    {
        var made = 0;
        FakeSocket? last = null;
        var socket = new MimiSocket(() =>
        {
            made++;
            return last = new FakeSocket();
        }, () => ("https://mimi.example.com", "bad"), "1.0");
        var states = new List<SocketState>();
        socket.StateChanged += state =>
        {
            lock (states) states.Add(state);
        };
        socket.Start();
        await Wait.Until(() => last is not null);
        last!.Close(CloseCodes.InvalidToken);
        await Wait.Until(() => socket.State is SocketState.SignedOut);
        await Task.Delay(1500);
        Assert.Equal(1, made);
        socket.Wake(); // even waking up does not try a dead token again
        await Task.Delay(200);
        Assert.Equal(1, made);
    }

    [Fact]
    public async Task No_answer_to_pings_means_a_new_socket()
    {
        var sockets = new List<FakeSocket>();
        var socket = new MimiSocket(() =>
        {
            var fake = new FakeSocket();
            lock (sockets) sockets.Add(fake);
            return fake;
        }, () => ("http://localhost:8787", "tok"), "1.0", pingEvery: TimeSpan.FromMilliseconds(150));
        socket.Start();
        await Wait.Until(() => sockets.Count == 1);
        sockets[0].Push(Welcome);
        await Wait.Until(() => sockets[0].SentTypes().Contains("ping"), 2000);
        // Silence for longer than a ping + 5 s grace would take too long; a closed socket shows the same path.
        sockets[0].Close(1006);
        await Wait.Until(() => sockets.Count == 2, 4000);
        socket.Stop();
    }
}

/// <summary>
/// The UI thread of a test: what the socket posts waits in a queue until the test thread pumps it, so the
/// view models only ever run on one thread (as on WinUI's dispatcher). Keeps what a handler threw.
/// </summary>
public sealed class QueueDispatcher : IUiDispatcher
{
    private readonly System.Collections.Concurrent.ConcurrentQueue<Action> queue = new();
    public List<Exception> Errors { get; } = [];

    public void Post(Action action) => queue.Enqueue(action);

    public void Pump()
    {
        while (queue.TryDequeue(out var action))
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                Errors.Add(error);
            }
        }
    }
}

public class ChatViewModelTests
{
    private readonly QueueDispatcher ui = new();

    private Task Until(Func<bool> condition) => Wait.Until(() =>
    {
        ui.Pump();
        return condition();
    });

    private async Task<(MimiSession Session, FakeSocket Socket)> Online()
    {
        FakeSocket? fake = null;
        var session = new MimiSession(new HttpClient(), ui, "1.0", () => fake = new FakeSocket());
        session.Begin("http://localhost:8787", "tok", "", gateway: false, coreApi: 1);
        await Wait.Until(() => fake is not null);
        fake!.Push("""{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"ui":{},"api":1,"minClientApi":1}""");
        await Until(() => session.State is SocketState.Online);
        return (session, fake);
    }

    [Fact]
    public async Task Sending_shows_a_pending_bubble_then_the_streamed_answer_then_the_stored_one()
    {
        var (session, socket) = await Online();
        var list = new ChatListViewModel(session);
        var chat = new ChatViewModel(session);
        socket.Push("""{"type":"chats","chats":[{"id":1,"kind":"direct","title":"","agents":["mimi"],"lastMessageAt":"2026-11-02T11:00:32.174Z","preview":"**สวัสดี**","unread":true}]}""");
        await Until(() => list.Rows.Count == 1);
        Assert.Equal("มิมิ", list.Rows[0].Title);
        Assert.Equal("สวัสดี", list.Rows[0].Preview);
        Assert.True(list.Rows[0].Unread);

        chat.Open(1);
        Assert.Contains("chat-open", socket.SentTypes());
        Assert.Contains("presence", socket.SentTypes());
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":1},"sessions":[],"messages":[],"hasMore":false,"live":null}""");
        await Until(() => chat.Timeline.Loaded);
        Assert.Equal("มิมิ", chat.Title);

        var sounds = new List<string>();
        chat.Sound += sounds.Add;
        chat.Draft = "  สวัสดี  ";
        Assert.True(chat.CanSend);
        chat.Send();
        Assert.Equal("", chat.Draft);
        var pending = Assert.IsType<PendingItem>(Assert.Single(chat.Items));
        Assert.Equal("สวัสดี", pending.Text);
        var sent = socket.Sent.Last(text => text.Contains("chat-send"));
        var clientId = System.Text.Json.JsonDocument.Parse(sent).RootElement.GetProperty("clientId").GetString();

        socket.Push("""{"type":"busy","chatId":1}""");
        socket.Push($$$"""{"type":"chat-message","chatId":1,"sessionId":1,"message":{"id":1,"role":"user","agent":"","text":"สวัสดี","createdAt":"2026-11-02T11:00:31Z","clientId":"{{{clientId}}}"}}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-start","agent":"mimi","model":"m"}}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"สวัสดี"}}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"ค่ะ"}}""");
        await Until(() => ui.Errors.Count > 0 || chat.Items.OfType<LiveItem>().Any(item => item.Parts.OfType<string>().Any(text => text == "สวัสดีค่ะ")));
        ui.Pump();
        Assert.True(ui.Errors.Count == 0, string.Join("\n---\n", ui.Errors));
        Assert.True(chat.Busy);
        Assert.IsType<MessageItem>(chat.Items[0]);
        Assert.Equal("มิมิ", chat.Items.OfType<LiveItem>().Single().Who);

        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-finish","reason":"stop","text":"สวัสดีค่ะ","speech":{"emotion":"ยินดี"}}}""");
        socket.Push("""{"type":"chat-turn-messages","chatId":1,"sessionId":1,"afterId":1,"messages":[{"id":2,"role":"assistant","agent":"mimi","text":"สวัสดีค่ะ","speech":{"emotion":"ยินดี"},"createdAt":"2026-11-02T11:00:32Z"}]}""");
        socket.Push("""{"type":"busy","chatId":1,"done":true}""");
        await Until(() => !chat.Busy);
        Assert.Equal(["m:1", "m:2"], chat.Items.Select(item => item.Key));
        var answer = Assert.IsType<MessageItem>(chat.Items[1]);
        Assert.Equal("สวัสดีค่ะ", answer.Text);
        Assert.Equal("ยินดี", answer.Mood);
        Assert.Equal(["sent", "done"], sounds);
        session.End();
    }

    [Fact]
    public async Task A_permission_card_is_answered_over_the_socket()
    {
        var (session, socket) = await Online();
        var chat = new ChatViewModel(session);
        chat.Open(1);
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":1},"sessions":[],"messages":[],"hasMore":false}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"permission-request","request":{"id":"p1","agent":"mimi","tool":"write_file","risk":"write","input":{"path":"a.txt"},"summary":"เขียนไฟล์ a.txt","timeoutMs":900000,"noGrant":true}}}""");
        await Until(() => chat.Items.OfType<PermissionItem>().Any());
        var card = chat.Items.OfType<PermissionItem>().Single();
        Assert.False(card.CanGrant);
        Assert.Contains("a.txt", card.Detail);
        chat.Answer("p1", true);
        Assert.Contains(socket.Sent, text => text == """{"type":"permission-response","requestId":"p1","allow":true,"scope":"once"}""");
        socket.Push("""{"type":"permission-resolved","requestId":"p1","decision":{"allow":true}}""");
        await Until(() => !chat.Items.OfType<PermissionItem>().Any());
        session.End();
    }

    [Fact]
    public async Task A_new_chat_with_an_agent_opens_once_the_core_made_it()
    {
        var (session, socket) = await Online();
        var list = new ChatListViewModel(session);
        long? opened = null;
        list.OpenRequested += id => opened = id;
        socket.Push("""{"type":"agents","agents":[{"name":"mimi","displayName":"มิมิ","description":"เลขา"}]}""");
        await Until(() => list.Agents.Count == 1);
        list.NewChat("mimi");
        Assert.Contains(socket.Sent, text => text == """{"type":"chat-create","kind":"direct","agents":["mimi"]}""");
        socket.Push("""{"type":"chat-history","chat":{"id":7,"kind":"direct","agents":["mimi"]},"session":null,"sessions":[],"messages":[],"hasMore":false}""");
        await Until(() => opened == 7);
        session.End();
    }
}

public class ConnectViewModelTests
{
    [Fact]
    public async Task A_single_core_asks_for_its_token_and_checks_it()
    {
        using var server = new LocalServer
        {
            Handle = async context =>
            {
                var path = context.Request.Url!.AbsolutePath;
                if (path == "/health")
                {
                    await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"ok":true,"version":"0.8.1","api":1,"minClientApi":1}"""));
                    return;
                }
                var ok = context.Request.Headers["Authorization"] == "Bearer right-token";
                context.Response.StatusCode = ok ? 200 : 401;
                await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(ok ? """{"chats":[]}""" : """{"error":"Missing or wrong token."}"""));
            },
        };
        using var http = new HttpClient();
        var connect = new ConnectViewModel(new MimiApi(http, () => null, () => null)) { ServerText = server.Url };
        SignedIn? done = null;
        connect.Done += value => done = value;
        await connect.Check();
        Assert.Equal(ConnectStep.Token, connect.Step);
        connect.Token = "wrong";
        await connect.SignIn();
        Assert.Null(done);
        Assert.Contains("ไม่ถูกต้อง", connect.Error);
        connect.Token = "right-token";
        connect.NotMyDevice = true;
        await connect.SignIn();
        Assert.NotNull(done);
        Assert.Equal("right-token", done!.Token);
        Assert.False(done.Gateway);
        Assert.False(done.Remember);
        Assert.Equal("", connect.Token); // not kept in the screen
    }

    [Fact]
    public async Task The_gateway_asks_for_the_code_when_the_account_has_two_factor()
    {
        using var server = new LocalServer
        {
            Handle = async context =>
            {
                var path = context.Request.Url!.AbsolutePath;
                if (path == "/health")
                {
                    await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"ok":true,"version":"0.8.1","api":1,"minClientApi":1,"accounts":true}"""));
                    return;
                }
                Assert.Equal("application/json; charset=utf-8", context.Request.ContentType);
                var body = await new StreamReader(context.Request.InputStream).ReadToEndAsync();
                if (!body.Contains("\"code\""))
                {
                    context.Response.StatusCode = 401;
                    await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"error":"Enter the code from your authenticator app.","twoFactor":true}"""));
                    return;
                }
                await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"token":"session-token","username":"tester","expiresAt":"x","webhookBase":"/h/x"}"""));
            },
        };
        using var http = new HttpClient();
        var connect = new ConnectViewModel(new MimiApi(http, () => null, () => null)) { ServerText = server.Url };
        SignedIn? done = null;
        connect.Done += value => done = value;
        await connect.Check();
        Assert.Equal(ConnectStep.Credentials, connect.Step);
        connect.Username = "Tester";
        connect.Password = "a long password";
        await connect.SignIn();
        Assert.True(connect.NeedsCode);
        Assert.Null(done);
        connect.Code = "123456";
        await connect.SignIn();
        Assert.Equal("session-token", done?.Token);
        Assert.True(done!.Gateway);
        Assert.Equal("", connect.Password); // the password is not kept
    }

    [Fact]
    public async Task A_core_that_needs_a_newer_app_says_so()
    {
        using var server = new LocalServer
        {
            Handle = async context => await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"ok":true,"version":"9.0.0","api":5,"minClientApi":4}""")),
        };
        using var http = new HttpClient();
        var connect = new ConnectViewModel(new MimiApi(http, () => null, () => null)) { ServerText = server.Url };
        await connect.Check();
        Assert.Equal(ConnectStep.Server, connect.Step);
        Assert.Contains("อัปเดต", connect.Error);
    }
}
