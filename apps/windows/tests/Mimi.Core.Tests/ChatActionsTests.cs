using System.Text.Json;
using Mimi.Core.Net;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;

namespace Mimi.Core.Tests;

/// <summary>Phase 6 chat set: reply, forward, react, pin, rewind, search, notification inbox (feature-inventory #12, 13, 15, 17).</summary>
public class ChatActionsTests
{
    private const string Welcome = """{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"ui":{},"api":1,"minClientApi":1}""";
    private const string Chats = """{"type":"chats","chats":[{"id":1,"kind":"direct","title":"","agents":["mimi"],"preview":""},{"id":2,"kind":"direct","title":"งาน","agents":["mimi"],"preview":""}]}""";

    private readonly QueueDispatcher ui = new();

    private Task Until(Func<bool> condition) => Wait.Until(() =>
    {
        ui.Pump();
        return condition();
    });

    private async Task<(MimiSession Session, FakeSocket Socket)> Connect(Action<MimiSession>? before = null)
    {
        FakeSocket? fake = null;
        var session = new MimiSession(new HttpClient(), ui, "1.0", () => fake = new FakeSocket());
        before?.Invoke(session);
        session.Begin("http://localhost:8787", "tok", "", gateway: false, coreApi: 1);
        await Wait.Until(() => fake is not null);
        fake!.Push(Welcome);
        await Until(() => session.State is SocketState.Online);
        fake.Push(Chats);
        await Until(() => session.Chats.Count == 2);
        return (session, fake);
    }

    private static JsonElement Last(FakeSocket socket, string type)
    {
        lock (socket.Sent) return JsonDocument.Parse(socket.Sent.Last(text => JsonDocument.Parse(text).RootElement.GetProperty("type").GetString() == type)).RootElement;
    }

    private const string History = """
        {"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":5,"chatId":1},"sessions":[{"id":5,"chatId":1},{"id":4,"chatId":1}],
         "messages":[
           {"id":10,"role":"user","text":"สวัสดี","createdAt":"2026-11-03T01:00:00Z","attachments":[],"tools":[]},
           {"id":11,"role":"assistant","agent":"mimi","text":"[emotion: happy]\nหวัดดีค่ะ","createdAt":"2026-11-03T01:00:05Z","attachments":[],"tools":[],
            "replyTo":{"id":10,"role":"user","agent":"","text":"สวัสดี"},"reactions":["❤️"],"pinned":true},
           {"id":12,"role":"user","text":"ต่อเลย","createdAt":"2026-11-03T01:01:00Z","attachments":[{"id":"f1","kind":"file","name":"a.txt","mime":"text/plain"}],"tools":[],
            "forwardedFrom":{"from":"มิมิ","chat":"งาน"}}],
         "hasMore":false,"live":null,
         "pins":[{"id":11,"sessionId":5,"role":"assistant","agent":"mimi","text":"หวัดดีค่ะ","createdAt":"2026-11-03T01:00:05Z"},
                 {"id":3,"sessionId":4,"role":"user","text":"ของเก่า","createdAt":"2026-11-01T01:00:00Z"}]}
        """;

    [Fact]
    public void New_frames_parse_and_the_client_frames_match_the_protocol()
    {
        var marks = Assert.IsType<ServerFrame.MessageMarks>(FrameParser.Parse("""{"type":"message-marks","chatId":1,"sessionId":5,"messageId":11,"pinned":false,"reactions":["👍"],"pins":[]}"""));
        Assert.Equal(11, marks.MessageId);
        Assert.Equal(["👍"], marks.Reactions);
        var rewound = Assert.IsType<ServerFrame.Rewound>(FrameParser.Parse("""{"type":"rewound","chatId":1,"sessionId":5,"text":"แก้ใหม่","restored":["a.txt"]}"""));
        Assert.Equal("แก้ใหม่", rewound.Text);
        Assert.Equal(["a.txt"], rewound.Restored);
        Assert.Empty(rewound.Skipped);
        var found = Assert.IsType<ServerFrame.SearchResults>(FrameParser.Parse("""{"type":"search-results","query":"แมว","hits":[{"messageId":3,"chatId":1,"sessionId":4,"chatTitle":"","sessionTitle":"","role":"user","agent":"","snippet":"มีแมว","createdAt":""}]}"""));
        Assert.Equal(4, Assert.Single(found.Hits).SessionId);
        var inbox = Assert.IsType<ServerFrame.Notifications>(FrameParser.Parse("""{"type":"notifications","items":[{"id":7,"kind":"reminder","title":"เตือน","body":"กินยา","createdAt":"2026-11-03T01:00:00Z","read":false}],"unread":1}"""));
        Assert.Equal(1, inbox.Unread);
        Assert.Equal("reminder", Assert.Single(inbox.Items).Kind);
        var history = Assert.IsType<ServerFrame.ChatHistory>(FrameParser.Parse(History));
        Assert.Equal(2, history.Pins!.Count);
        Assert.Equal(new ForwardedFrom("มิมิ", "งาน"), history.Messages[2].ForwardedFrom);

        Assert.Equal("""{"type":"message-pin","messageId":11,"pinned":true}""", ClientFrames.MessagePin(11, true));
        Assert.Equal("👍", JsonDocument.Parse(ClientFrames.MessageReact(11, "👍")).RootElement.GetProperty("emoji").GetString());
        Assert.Equal("""{"type":"rewind","sessionId":5,"messageId":10}""", ClientFrames.Rewind(5, 10));
        Assert.Equal("""{"type":"search","query":"แมว"}""", ClientFrames.Search("แมว"));
        Assert.Equal("""{"type":"notifications-read"}""", ClientFrames.NotificationsRead());
        Assert.Equal("""{"type":"notifications-read","ids":[7]}""", ClientFrames.NotificationsRead([7]));
        Assert.Equal("""{"type":"chat-send","chatId":2,"text":"x","forward":{"from":"คุณ","chat":"แชต"}}""", ClientFrames.ChatSend(2, "x", [], null, forward: new ForwardedFrom("คุณ", "แชต")));
    }

    [Fact]
    public void Highlight_marks_every_query_word_case_insensitively()
    {
        var parts = MessageFormat.Highlight("Cat และ แมว และ cat", "cat แมว");
        Assert.Equal([("Cat", true), (" และ ", false), ("แมว", true), (" และ ", false), ("cat", true)], parts);
        Assert.Equal([("ไม่มี", false)], MessageFormat.Highlight("ไม่มี", "xyz"));
    }

    [Fact]
    public async Task Marks_quotes_and_pins_show_and_actions_send_the_right_frames()
    {
        var (session, socket) = await Connect();
        var chat = new ChatViewModel(session);
        chat.Open(1);
        socket.Push(History);
        await Until(() => chat.Items.Count == 3);

        var answer = (MessageItem)chat.Items[1];
        Assert.Equal("คุณ: สวัสดี", answer.Quote);
        Assert.True(answer.Loved);
        Assert.True(answer.Pinned);
        Assert.Equal("↪ ส่งต่อจาก มิมิ · งาน", ((MessageItem)chat.Items[2]).Forwarded);
        Assert.True(chat.HasPins);
        Assert.True(chat.ManyPins);
        Assert.Equal("📌 ปักหมุด 1/2", chat.PinLabel);
        Assert.Equal("มิมิ: หวัดดีค่ะ", chat.PinText);
        Assert.Equal("หวัดดีค่ะ", chat.TextOf(11)); // the voice direction line is not copied

        chat.React(11, ChatViewModel.Love);
        Assert.Equal(ChatViewModel.Love, Last(socket, "message-react").GetProperty("emoji").GetString());
        chat.TogglePin(11);
        Assert.Equal("""{"type":"message-pin","messageId":11,"pinned":false}""", socket.Sent.Last());
        socket.Push("""{"type":"message-marks","chatId":1,"sessionId":5,"messageId":11,"pinned":false,"reactions":[],"pins":[{"id":3,"sessionId":4,"role":"user","text":"ของเก่า","createdAt":""}]}""");
        await Until(() => !((MessageItem)chat.Items[1]).Pinned);
        Assert.False(((MessageItem)chat.Items[1]).Loved);
        Assert.False(chat.ManyPins);
        Assert.Equal("คุณ: ของเก่า", chat.PinText);

        // Reply: the next message answers this one, and the bar goes away.
        chat.ReplyTo(11);
        Assert.Equal("ตอบกลับ มิมิ: หวัดดีค่ะ", chat.ReplyLabel);
        chat.Draft = "ตอบนะ";
        chat.Send();
        var sent = Last(socket, "chat-send");
        Assert.Equal(11, sent.GetProperty("replyTo").GetInt64());
        Assert.False(chat.HasReply);

        // Forward the user's message with its file to the other chat.
        chat.Forward(12, 2);
        var forwarded = Last(socket, "chat-send");
        Assert.Equal(2, forwarded.GetProperty("chatId").GetInt64());
        Assert.Equal("f1", forwarded.GetProperty("attachments")[0].GetString());
        Assert.Equal("คุณ", forwarded.GetProperty("forward").GetProperty("from").GetString());
        Assert.Equal("มิมิ", forwarded.GetProperty("forward").GetProperty("chat").GetString());
        Assert.False(forwarded.TryGetProperty("clientId", out _));
        Assert.Equal("ส่งต่อไปที่ งาน แล้ว", chat.Info);
        Assert.Equal([(2L, "งาน")], chat.ForwardTargets);

        // The pin of an older session opens that session at the message.
        chat.NextPin();
        var open = Last(socket, "chat-open");
        Assert.Equal(4, open.GetProperty("sessionId").GetInt64());
        session.End();
    }

    [Fact]
    public async Task Rewind_waits_for_the_turn_and_brings_the_text_back()
    {
        var (session, socket) = await Connect();
        var chat = new ChatViewModel(session);
        chat.Open(1);
        socket.Push(History);
        await Until(() => chat.Items.Count == 3);

        Assert.Equal("ย้อนกลับได้เฉพาะข้อความของคุณ", chat.RewindProblem(11));
        socket.Push("""{"type":"busy","chatId":1}""");
        await Until(() => chat.Busy);
        Assert.Equal("รอให้ตอบเสร็จก่อน หรือกดหยุด แล้วค่อยย้อนกลับ", chat.RewindProblem(10));
        chat.Rewind(10);
        Assert.DoesNotContain("rewind", socket.SentTypes());
        socket.Push("""{"type":"busy","chatId":1,"done":true}""");
        await Until(() => !chat.Busy);

        Assert.Null(chat.RewindProblem(10));
        chat.Rewind(10);
        Assert.Equal("""{"type":"rewind","sessionId":5,"messageId":10}""", socket.Sent.Last());
        socket.Push("""{"type":"rewound","chatId":1,"sessionId":5,"text":"สวัสดี","restored":["notes.md"],"skipped":[]}""");
        await Until(() => chat.Draft == "สวัสดี");
        Assert.Equal("ย้อนไฟล์กลับ 1 ไฟล์: notes.md", chat.Info);
        Assert.Equal("", chat.Error);
        session.End();
    }

    [Fact]
    public async Task A_search_hit_in_an_older_session_loads_back_to_the_message_and_sending_returns_to_the_newest()
    {
        var (session, socket) = await Connect();
        var chat = new ChatViewModel(session);
        var jumped = new List<string>();
        chat.JumpRequested += jumped.Add;
        chat.Open(1, sessionId: 4, messageId: 2);
        var open = Last(socket, "chat-open");
        Assert.Equal(4, open.GetProperty("sessionId").GetInt64());

        // Message 2 is on an older page: one chat-open with beforeId, not one per frame.
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":4,"chatId":1},"sessions":[{"id":5,"chatId":1},{"id":4,"chatId":1}],"messages":[{"id":3,"role":"user","text":"ของเก่า","attachments":[],"tools":[]}],"hasMore":true,"pins":[]}""");
        await Until(() => chat.OlderSession);
        socket.Push("""{"type":"chat-transcribing","chatId":1,"on":true}""");
        await Until(() => chat.Transcribing);
        Assert.Single(socket.Sent, text => text.Contains("\"beforeId\":3"));
        Assert.Empty(jumped);
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":4,"chatId":1},"sessions":[],"messages":[{"id":2,"role":"user","text":"แมว","attachments":[],"tools":[]}],"hasMore":false,"beforeId":3,"pins":[]}""");
        await Until(() => jumped.Count == 1);
        Assert.Equal("m:2", jumped[0]);

        // A turn of the newest session does not replace the old one on screen.
        socket.Push("""{"type":"chat-session","chatId":1,"session":{"id":5,"chatId":1},"started":false}""");
        socket.Push("""{"type":"chat-transcribing","chatId":1,"on":false}""");
        await Until(() => !chat.Transcribing);
        Assert.Equal(4, chat.Timeline.Session!.Id);
        Assert.Equal("ย้อนกลับได้เฉพาะใน session ล่าสุด", chat.RewindProblem(2));

        // Sending goes to the newest session, which comes on screen first.
        chat.Draft = "ใหม่";
        chat.Send();
        string[] types;
        lock (socket.Sent) types = socket.SentTypes()[^3..];
        Assert.Equal(["chat-open", "presence", "chat-send"], types);
        Assert.False(Last(socket, "chat-open").TryGetProperty("sessionId", out _));
        session.End();
    }

    [Fact]
    public async Task Search_shows_only_the_answer_to_the_latest_query()
    {
        var (session, socket) = await Connect();
        var search = new SearchViewModel(session);
        (long, long, long)? opened = null;
        search.OpenRequested += (chat, sessionId, message) => opened = (chat, sessionId, message);
        search.Query = "แม";
        search.Run();
        search.Query = "แมว";
        search.Run();
        Assert.Equal("""{"type":"search","query":"แมว"}""", socket.Sent.Last());
        socket.Push("""{"type":"search-results","query":"แม","hits":[{"messageId":1,"chatId":1,"sessionId":4,"role":"user","snippet":"แม่","createdAt":""}]}""");
        socket.Push("""{"type":"search-results","query":"แมว","hits":[{"messageId":3,"chatId":2,"sessionId":4,"role":"assistant","agent":"mimi","snippet":"มีแมวสองตัว","createdAt":""}]}""");
        await Until(() => search.Results.Count == 1 && search.Results[0].MessageId == 3);
        var row = search.Results[0];
        Assert.Equal("งาน · มิมิ", row.Where);
        Assert.Contains(("แมว", true), row.Parts);
        Assert.Equal("พบ 1 ข้อความ", search.Status);
        search.Open(row);
        Assert.Equal((2L, 4L, 3L), opened);
        search.Clear();
        Assert.Empty(search.Results);
        session.End();
    }

    [Fact]
    public async Task The_inbox_loads_on_connect_counts_new_ones_and_skips_the_chat_on_screen()
    {
        InboxViewModel? inbox = null;
        long? looking = null;
        var (session, socket) = await Connect(made => inbox = new InboxViewModel(made, () => looking));
        Assert.Contains("notifications-list", socket.SentTypes());
        socket.Push("""{"type":"notifications","items":[{"id":7,"kind":"reminder","title":"เตือน","body":"กินยา","chatId":1,"createdAt":"2026-11-03T01:00:00Z","read":false},{"id":6,"kind":"info","title":"i","body":"","createdAt":"2026-11-02T01:00:00Z","read":true}],"unread":1}""");
        await Until(() => inbox!.Rows.Count == 2);
        Assert.Equal("⏰", inbox!.Rows[0].Icon);
        Assert.Equal("การแจ้งเตือน (1 ใหม่)", inbox.Heading);

        socket.Push("""{"type":"notification","notification":{"id":8,"kind":"message","title":"มิมิ","body":"ว่าไง","chatId":2}}""");
        await Until(() => inbox.Rows.Count == 3);
        Assert.Equal(2, inbox.Unread);
        Assert.Equal("💬", inbox.Rows[0].Icon);

        looking = 1;
        socket.Push("""{"type":"notification","notification":{"id":9,"kind":"approval","title":"ขออนุมัติ","body":"","chatId":1}}""");
        await Until(() => socket.Sent.Last() == """{"type":"notifications-read","ids":[9]}""");
        Assert.Equal(3, inbox.Rows.Count);

        long? opened = null;
        inbox.OpenRequested += id => opened = id;
        inbox.Open(inbox.Rows[0]);
        Assert.Equal("""{"type":"notifications-read","ids":[8]}""", socket.Sent.Last());
        Assert.Equal(2, opened);
        inbox.ReadAll();
        Assert.Equal("""{"type":"notifications-read"}""", socket.Sent.Last());
        inbox.Clear();
        Assert.True(inbox.Empty);
        Assert.False(inbox.HasUnread);
        session.End();
    }
}
