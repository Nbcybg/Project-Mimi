using System.Text.Json;
using Mimi.Core.Chat;
using Mimi.Core.Desktop;
using Mimi.Core.Protocol;

namespace Mimi.Core.Tests;

/// <summary>Questions waiting for the user are shown in every chat, and the PC agent's questions at its own screen reach the phone.</summary>
public sealed class AttentionTests
{
    private static ServerFrame Frame(string json) => FrameParser.Parse(json);

    private static ServerFrame.Welcome Welcome(string pending = "[]", string consents = "[]") => (ServerFrame.Welcome)Frame(
        $$"""{"type":"welcome","agents":[],"defaultAgent":"mimi","pcOnline":true,"busy":false,"pendingPermissions":{{pending}},"pcConsents":{{consents}},"api":2,"minClientApi":1}""");

    [Fact]
    public void A_permission_question_of_any_chat_is_listed_with_its_chat_until_it_is_decided()
    {
        var board = new AttentionBoard();
        Assert.True(board.Apply(Welcome("""[{"id":"p1","tool":"write_file","agent":"mimi","summary":"เขียน a.txt","chatId":7}]""")));
        var item = Assert.Single(board.Items);
        Assert.Equal(("p1", false, "mimi", 7L, "เขียน a.txt"), (item.Id, item.AtPc, item.Agent, item.ChatId, item.Summary));

        // A question that arrives live in another chat joins the list; a decision removes it.
        Assert.True(board.Apply(Frame("""{"type":"chat-event","chatId":9,"sessionId":1,"agent":"milo","event":{"type":"permission-request","request":{"id":"p2","tool":"run_shell","agent":"milo","summary":""}}}""")));
        Assert.Equal([7L, 9L], board.Items.Select(entry => entry.ChatId!.Value));
        Assert.Equal("run_shell", board.Items[1].Summary);
        Assert.True(board.Apply(Frame("""{"type":"permission-resolved","requestId":"p1","decision":{"allow":true}}""")));
        Assert.Equal(["p2"], board.Items.Select(entry => entry.Id));
        Assert.True(board.Apply(Frame("""{"type":"chat-event","chatId":9,"sessionId":1,"agent":"milo","event":{"type":"permission-decision","requestId":"p2","decision":{"allow":false}}}""")));
        Assert.False(board.Any);
    }

    [Fact]
    public void A_question_inside_a_sub_agents_activity_is_found_too()
    {
        var board = new AttentionBoard();
        board.Apply(Frame("""{"type":"chat-event","chatId":3,"sessionId":1,"agent":"mimi","event":{"type":"agent-activity","agent":"helper","event":{"type":"permission-request","request":{"id":"s1","tool":"read_file","agent":"helper"}}}}"""));
        Assert.Equal(("s1", 3L), (board.Items[0].Id, board.Items[0].ChatId));
    }

    [Fact]
    public void A_question_at_the_PCs_screen_comes_first_and_ends_with_the_answer_the_timeout_or_the_PC_leaving()
    {
        var board = new AttentionBoard();
        board.Apply(Welcome("""[{"id":"p1","tool":"x","agent":"mimi","chatId":1}]"""));
        var sent = Frame("""{"type":"pc-consent","request":{"id":"c1","tool":"write_file","risk":"write","summary":"เขียนไฟล์","agent":"mimi","chatId":1,"pcName":"me@PC","askedAt":"2026-11-16T10:00:00.000Z","expiresAt":"2026-11-16T10:05:00.000Z"}}""");
        Assert.True(board.Apply(sent));
        Assert.Equal(["c1", "p1"], board.Items.Select(entry => entry.Id));
        var pc = board.Items[0];
        Assert.True(pc.AtPc);
        Assert.Equal("me@PC", pc.PcName);
        Assert.Equal(DateTimeOffset.Parse("2026-11-16T10:05:00Z"), pc.ExpiresAt);

        Assert.True(board.Apply(Frame("""{"type":"pc-consent-done","id":"c1","outcome":"timeout"}""")));
        Assert.Equal(["p1"], board.Items.Select(entry => entry.Id));
        Assert.False(board.Apply(Frame("""{"type":"pc-consent-done","id":"c1","outcome":"timeout"}""")), "a second end changes nothing");

        board.Apply(sent);
        Assert.True(board.Apply(Frame("""{"type":"pc-status","online":false}""")));
        Assert.Equal(["p1"], board.Items.Select(entry => entry.Id));
    }

    [Fact]
    public void A_reconnect_starts_from_what_the_core_says_is_still_open()
    {
        var board = new AttentionBoard();
        board.Apply(Welcome(consents: """[{"id":"c1","tool":"t","summary":"s","agent":"a","askedAt":"","expiresAt":""}]"""));
        Assert.Single(board.Items);
        Assert.True(board.Apply(Welcome()));
        Assert.False(board.Any);
    }

    [Fact]
    public void The_agents_consent_lines_carry_who_asked_and_a_cancel_line_names_the_question()
    {
        var request = PcAgentHost.ParseConsent("""@@mimi-consent@@{"id":"c1","tool":"write_file","risk":"write","summary":"เขียนไฟล์ a.txt","agent":"mimi","thread":"s-1"}""");
        Assert.Equal(new ConsentRequest("c1", "write_file", "write", "เขียนไฟล์ a.txt", "mimi"), request);
        Assert.Equal("c1", PcAgentHost.ParseCancel("""@@mimi-consent-cancel@@{"id":"c1"}"""));
        Assert.Null(PcAgentHost.ParseCancel("@@mimi-consent-cancel@@{broken"));
        Assert.Null(PcAgentHost.ParseCancel("""@@mimi-consent@@{"id":"c1"}"""));
        Assert.Null(PcAgentHost.ParseConsent("""@@mimi-consent-cancel@@{"id":"c1"}"""));
    }
}
