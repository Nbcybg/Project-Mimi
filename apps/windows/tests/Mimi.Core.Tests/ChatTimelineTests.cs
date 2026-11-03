using Mimi.Core.Chat;
using Mimi.Core.Protocol;

namespace Mimi.Core.Tests;

/// <summary>Frames as a core sent them (recorded from a local core, docs/native/realtime.md 4.2) — the Android app's cases.</summary>
public class ChatTimelineTests
{
    private static readonly string[] Turn =
    [
        """{"type":"busy","chatId":1}""",
        """{"type":"chat-session","chatId":1,"session":{"id":1,"chatId":1,"title":"","summary":"","auto":true,"createdAt":"x","lastMessageAt":"x","readAt":"x","unread":false},"started":true}""",
        """{"type":"chat-message","chatId":1,"sessionId":1,"message":{"id":1,"role":"user","agent":"","text":"สวัสดี","createdAt":"x","attachments":[],"tools":[],"replyTo":null,"forwardedFrom":null,"clientId":"c-1"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-start","traceId":"t","agent":"mimi","model":"mock/m1","userMessageId":1}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"สวัสดี"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"ค่ะ "}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-call","call":{"id":"k1","name":"web_search","input":{"q":"x"}},"risk":"read"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-result","result":{"callId":"k1","name":"web_search","ok":true,"output":"found"}}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"**ทดสอบ**"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"usage","round":1,"usage":{"inputTokens":1,"outputTokens":1,"cachedTokens":0,"costUsd":0}}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-finish","traceId":"t","reason":"stop","rounds":1,"usage":{},"contextTokens":1,"text":"**ทดสอบ**","speech":{"emotion":"ยินดี"}}}""",
    ];

    private static ChatTimeline Fold(ChatTimeline state, IEnumerable<string> frames) =>
        frames.Aggregate(state, (current, json) => current.Reduce(FrameParser.Parse(json)));

    [Fact]
    public void A_streamed_turn_becomes_a_bubble_with_tools_then_the_stored_messages_replace_it()
    {
        var state = Fold(new ChatTimeline(1).AddPending(new PendingMessage("c-1", "สวัสดี", [])), Turn);
        Assert.True(state.Busy);
        Assert.Empty(state.PendingList);
        Assert.Equal([1L], state.MessageList.Select(message => message.Id));
        var live = state.Live!;
        Assert.Equal("mimi", live.Agent);
        Assert.True(live.Finished);
        Assert.Equal("ยินดี", live.Speech?.Emotion);
        Assert.Collection(live.Segments,
            segment => Assert.Equal("สวัสดีค่ะ ", Assert.IsType<LiveSegment.Text>(segment).Raw),
            segment => Assert.True(Assert.IsType<LiveSegment.Tool>(segment).Ok),
            segment => Assert.Equal("**ทดสอบ**", Assert.IsType<LiveSegment.Text>(segment).Raw));

        state = Fold(state,
        [
            """{"type":"chat-turn-messages","chatId":1,"sessionId":1,"afterId":1,"messages":[{"id":2,"role":"assistant","agent":"mimi","text":"**ทดสอบ**","speech":{"emotion":"ยินดี"},"createdAt":"x","attachments":[],"tools":[{"name":"web_search","summary":"x"}]}]}""",
            """{"type":"busy","chatId":1,"done":true}""",
        ]);
        Assert.Null(state.Live);
        Assert.Equal([1L, 2L], state.MessageList.Select(message => message.Id));
        Assert.False(state.Busy);
    }

    [Fact]
    public void Frames_of_another_chat_or_an_older_session_change_nothing()
    {
        var start = new ChatTimeline(1, Session: new SessionView(5, 1));
        Assert.Same(start, start.Reduce(FrameParser.Parse("""{"type":"chat-event","chatId":2,"sessionId":9,"agent":"a","event":{"type":"text-delta","text":"x"}}""")));
        Assert.Same(start, start.Reduce(FrameParser.Parse("""{"type":"chat-event","chatId":1,"sessionId":4,"agent":"a","event":{"type":"text-delta","text":"x"}}""")));
    }

    [Fact]
    public void A_failed_send_marks_the_pending_bubble_and_a_turn_error_becomes_a_note()
    {
        var state = new ChatTimeline(1).AddPending(new PendingMessage("c-9", "x", []));
        state = state.Reduce(FrameParser.Parse("""{"type":"error","message":"Chat #1 does not exist.","code":"E-CONFIG","clientId":"c-9","requestType":"chat-send"}"""));
        Assert.Equal("Chat #1 does not exist.", Assert.Single(state.PendingList).Failed);
        state = state.Reduce(FrameParser.Parse("""{"type":"error","message":"rate","code":"E-RATE-429","chatId":1}"""));
        Assert.Equal("[E-RATE-429] rate", Assert.Single(state.NoteList).Text);
    }

    [Fact]
    public void AfterId_adds_only_newer_messages_and_an_older_page_goes_in_front()
    {
        var state = new ChatTimeline(1).Reduce(FrameParser.Parse("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":5,"role":"user","text":"a"},{"id":6,"role":"assistant","text":"b"}],"hasMore":true}"""));
        state = state.Reduce(FrameParser.Parse("""{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":7,"role":"user","text":"c"}],"hasMore":false,"afterId":6}"""));
        Assert.Equal([5L, 6L, 7L], state.MessageList.Select(message => message.Id));
        state = state.Reduce(FrameParser.Parse("""{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":3,"role":"user","text":"z"}],"hasMore":false,"beforeId":5}"""));
        Assert.Equal([3L, 5L, 6L, 7L], state.MessageList.Select(message => message.Id));
        Assert.False(state.HasMore);
    }

    [Fact]
    public void A_handoff_keeps_the_first_answer_until_the_turns_messages_come()
    {
        var state = Fold(new ChatTimeline(1, Session: new SessionView(1, 1)),
        [
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-start","agent":"a","model":"m"}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"text-delta","text":"ส่งต่อนะ"}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-finish","reason":"handoff","text":"ส่งต่อนะ","handoff":{"messageId":3,"to":"b"}}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"b","event":{"type":"run-start","agent":"b","model":"m"}}""",
        ]);
        Assert.Equal(["a"], state.EarlierList.Select(bubble => bubble.Agent));
        Assert.Equal("b", state.Live?.Agent);
        Assert.Equal("↪ ส่งต่อให้ b", Assert.Single(state.NoteList).Text);
    }

    [Fact]
    public void Permission_requests_also_from_a_sub_agent_wait_until_resolved()
    {
        var state = new ChatTimeline(1).Reduce(FrameParser.Parse("""{"type":"chat-event","chatId":1,"sessionId":0,"agent":"a","event":{"type":"agent-activity","agent":"helper","messageId":1,"event":{"type":"permission-request","request":{"id":"p1","traceId":"t","agent":"helper","tool":"write_file","risk":"write","input":{"path":"x"},"summary":"เขียนไฟล์","timeoutMs":900000,"createdAt":"x"}}}}"""));
        Assert.Equal("write_file", Assert.Single(state.PermissionList).Tool);
        state = state.Reduce(FrameParser.Parse("""{"type":"permission-resolved","requestId":"p1","decision":{"allow":true,"via":"user"}}"""));
        Assert.Empty(state.PermissionList);
    }

    [Fact]
    public void Unknown_or_broken_frames_never_throw()
    {
        Assert.IsType<ServerFrame.Unknown>(FrameParser.Parse("not json"));
        Assert.Equal("future-thing", Assert.IsType<ServerFrame.Unknown>(FrameParser.Parse("""{"type":"future-thing","x":1}""")).Type);
        Assert.IsType<ServerFrame.Unknown>(FrameParser.Parse("""{"type":"chat-message","chatId":1}"""));
        var welcome = Assert.IsType<ServerFrame.Welcome>(FrameParser.Parse("""{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[3],"pendingPermissions":[],"ui":{},"api":1,"minClientApi":1,"version":"0.8.1"}"""));
        Assert.Equal(1, welcome.Api);
        Assert.Equal([3L], welcome.BusyChats);
    }

    [Fact]
    public void Client_frames_have_the_shape_the_core_expects()
    {
        Assert.Equal("""{"type":"hello","role":"client","token":"t","name":"windows","client":{"platform":"windows","version":"1.0","api":1}}""", ClientFrames.Hello("t", "1.0"));
        Assert.Equal("""{"type":"presence","chatId":null,"visible":false}""", ClientFrames.Presence(null, false));
        Assert.Equal("""{"type":"chat-send","chatId":2,"text":"ไฟล์","attachments":["a"],"clientId":"c"}""", ClientFrames.ChatSend(2, "ไฟล์", ["a"], "c"));
        Assert.Equal("""{"type":"permission-response","requestId":"p","allow":false}""", ClientFrames.PermissionResponse("p", false));
        Assert.Equal("""{"type":"chat-open","chatId":4,"sessionId":2,"afterId":9}""", ClientFrames.ChatOpen(4, 2, afterId: 9));
    }
}
