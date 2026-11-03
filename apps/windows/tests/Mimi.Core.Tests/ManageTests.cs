using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Hub;
using Mimi.Core.Net;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;

namespace Mimi.Core.Tests;

/// <summary>Phase 6 (Windows), the rest of the web client: the generic management lists and the chat extras.</summary>
public class ManageTests
{
    private const string Welcome = """{"type":"welcome","agents":[{"name":"mimi","displayName":"มิมิ"}],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"ui":{"mimi.autoSpeak":"1"},"api":1,"minClientApi":1}""";

    private readonly QueueDispatcher ui = new();

    private Task Until(Func<bool> condition) => Wait.Until(() =>
    {
        ui.Pump();
        return condition();
    });

    private async Task<(MimiSession Session, FakeSocket Socket)> Connect()
    {
        FakeSocket? fake = null;
        var session = new MimiSession(new HttpClient(), ui, "1.0", () => fake = new FakeSocket());
        session.Begin("http://localhost:8787", "tok", "", gateway: false, coreApi: 1);
        await Wait.Until(() => fake is not null);
        fake!.Push(Welcome);
        await Until(() => session.State is SocketState.Online);
        return (session, fake);
    }

    private static JsonElement Parse(string frame) => JsonDocument.Parse(frame).RootElement;

    private static JsonElement Element(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Fact]
    public async Task A_list_shows_its_reply_saves_with_the_old_name_deletes_and_shows_its_errors()
    {
        var (session, socket) = await Connect();
        var list = new EntityList(session, Catalog.Skills);
        list.Refresh();
        Assert.Equal("""{"type":"skills-list"}""", socket.Sent.Last());
        socket.Push("""{"type":"skills","skills":[{"name":"song","description":"เขียนเพลง","model":"","tools":[],"body":"#"},{"name":"workflow-builder","description":"x","model":"","tools":[],"body":"","builtin":true}]}""");
        await Until(() => list.Rows.Count == 2);
        Assert.Equal("workflow-builder (มากับแอป)", list.Rows[1].Title);
        Assert.Equal("เขียนเพลง", list.Rows[0].Subtitle);

        var edited = list.Rows[1].Item.Obj();
        edited["description"] = "แก้";
        list.Save(edited, list.Rows[1].Id);
        var save = Parse(socket.Sent.Last());
        Assert.Equal("skill-save", save.GetProperty("type").GetString());
        Assert.Equal("workflow-builder", save.GetProperty("renameFrom").GetString());
        Assert.False(save.GetProperty("skill").TryGetProperty("builtin", out _));
        list.Save(J.O(("name", JsonValue.Create("new")), ("body", JsonValue.Create(""))), null);
        Assert.False(Parse(socket.Sent.Last()).TryGetProperty("renameFrom", out _));

        list.Delete(list.Rows[0]);
        Assert.Equal("""{"type":"skill-delete","name":"song"}""", socket.Sent.Last());
        socket.Push("""{"type":"error","message":"A skill named \"new\" already exists.","requestType":"skill-save"}""");
        await Until(() => list.Error.Length > 0);
        Assert.Contains("already exists", list.Error);
        socket.Push("""{"type":"skills","skills":[],"saved":"new"}""");
        await Until(() => list.Empty);
        Assert.Equal("บันทึกแล้ว", list.Note);
        Assert.Equal("", list.Error);
        session.End();
    }

    [Fact]
    public void Catalog_frames_match_the_protocol()
    {
        // Triggers: a new one is created whole, an edit sends a patch of what can change.
        var trigger = J.O(("kind", JsonValue.Create("reminder")), ("title", JsonValue.Create("กินยา")), ("text", JsonValue.Create("ได้เวลา")), ("cron", JsonValue.Create("0 9 * * *")), ("fireAt", JsonValue.Create("")), ("repeat", true));
        var create = Parse(Catalog.Triggers.Save!(trigger, null));
        Assert.Equal("trigger-create", create.GetProperty("type").GetString());
        Assert.False(create.GetProperty("trigger").TryGetProperty("fireAt", out _));
        var update = Parse(Catalog.Triggers.Save!(trigger, "7"));
        Assert.Equal(7, update.GetProperty("id").GetInt64());
        Assert.False(update.GetProperty("patch").TryGetProperty("kind", out _));
        Assert.Equal("""{"type":"trigger-delete","id":7}""", Catalog.Triggers.Delete!(Element("""{"id":7}""")));

        // Secrets: names only; an empty value removes one.
        Assert.Equal("""{"type":"secrets-save","values":{"SLACK":"xoxb"}}""", Catalog.Secrets.Save!(J.O(("name", JsonValue.Create("SLACK")), ("value", JsonValue.Create("xoxb"))), null));
        Assert.Equal("""{"type":"secrets-save","values":{"SLACK":""}}""", Catalog.Secrets.Delete!(Element("\"SLACK\"")));

        // Workflows are named agent/name in the list; renameFrom is the bare name.
        var flow = Parse(Catalog.Workflows.Save!(J.O(("name", JsonValue.Create("daily")), ("agent", JsonValue.Create("mimi")), ("webhook", JsonValue.Create("/h"))), "mimi/daily"));
        Assert.Equal("daily", flow.GetProperty("renameFrom").GetString());
        Assert.False(flow.GetProperty("workflow").TryGetProperty("webhook", out _));

        // Providers: a key means connect (the core lists the models), no key means update.
        var connect = Parse(Catalog.Providers.Save!(J.O(("id", JsonValue.Create("DeepSeek")), ("apiKey", JsonValue.Create("sk"))), "deepseek"));
        Assert.Equal("provider-connect", connect.GetProperty("type").GetString());
        Assert.Equal("deepseek", connect.GetProperty("id").GetString());
        Assert.Equal("provider-update", Parse(Catalog.Providers.Save!(J.O(("id", JsonValue.Create("deepseek")), ("name", JsonValue.Create("DS"))), "deepseek")).GetProperty("type").GetString());

        // Mail: passwords travel beside the account, never in it.
        var mail = Parse(Catalog.MailAccounts.Save!(J.O(("id", JsonValue.Create("home")), ("kind", JsonValue.Create("imap")), ("password", JsonValue.Create("pw")), ("connected", true)), "home"));
        Assert.Equal("pw", mail.GetProperty("password").GetString());
        Assert.False(mail.GetProperty("account").TryGetProperty("password", out _));
        Assert.False(mail.GetProperty("account").TryGetProperty("connected", out _));

        // Agents: what the editor only reads stays out of agent-save.
        var agent = Parse(Catalog.Agents.Save!(J.O(("name", JsonValue.Create("mimi")), ("avatar", JsonValue.Create("v1")), ("status", new JsonObject())), "mimi"));
        Assert.False(agent.GetProperty("agent").TryGetProperty("avatar", out _));
        Assert.Equal("mimi", agent.GetProperty("renameFrom").GetString());
    }

    [Fact]
    public void Settings_lists_read_the_settings_view_and_save_what_settings_save_takes()
    {
        var reply = Element("""
            {"type":"settings","settings":{"providers":[{"id":"openai","name":"OpenAI","baseURL":null,"connected":true,"custom":false,"models":3,"modelIds":[]}],
             "catalog":[],"models":[],"defaults":{"model":"openai/gpt"},"presets":[{"name":"fast","model":"openai/gpt","temperature":0.2}],
             "timezone":"Asia/Bangkok","sessionIdleMinutes":180,"sessionMaxTokens":0,"allowedDirs":["C:\\work"],"projectRoots":[],
             "storage":{"media":{"usedBytes":1048576,"quotaBytes":524288000,"files":1},"userMedia":{"usedBytes":0,"quotaBytes":0},"chat":{"usedBytes":0,"quotaBytes":0,"messages":0},"retentionDays":7},
             "spentTodayUsd":0.5,"preferences":{"dailyBudgetUsd":2},"permissionAgentGrants":{"*":["run_shell"],"mimi":["write_file"]},
             "toolKeys":{"serper":true,"openweather":false},"tunnel":{"state":"off"}}}
            """);
        Assert.Equal("fast", Catalog.Presets.Items(reply).Single().S("name"));
        Assert.Equal("OpenAI", Catalog.Providers.Title(Catalog.Providers.Items(reply).Single()));
        var general = Catalog.General.Items(reply).Single();
        Assert.Equal(180, general.At("session.idleMinutes").GetInt32());
        Assert.Equal(500, general.At("storage.mediaQuotaMb").GetInt64());
        var save = Parse(Catalog.General.Save!(general.Obj(), "general"));
        Assert.Equal("Asia/Bangkok", save.GetProperty("timezone").GetString());
        Assert.False(save.TryGetProperty("used", out _));
        var grants = Catalog.Grants.Items(reply).ToList();
        Assert.Equal(2, grants.Count);
        Assert.Equal("""{"type":"permission-revoke","tool":"run_shell"}""", Catalog.Grants.Delete!(grants[0]));
        Assert.Equal("""{"type":"permission-revoke","tool":"write_file","agent":"mimi"}""", Catalog.Grants.Delete!(grants[1]));
        Assert.Equal("Serper ✓ · OpenWeather —", Catalog.ToolKeys.Subtitle!(Catalog.ToolKeys.Items(reply).Single()));
        Assert.Equal("""{"type":"preferences-save","preferences":{"dailyBudgetUsd":3}}""", Catalog.Preferences.Save!(J.O(("dailyBudgetUsd", 3)), "preferences"));
    }

    [Fact]
    public async Task Ask_waits_for_the_reply_and_an_error_about_the_request_throws()
    {
        var (session, socket) = await Connect();
        var asked = session.Ask(ClientFrames.Simple("overseer-get"), "overseer", "overseer-get");
        await Until(() => socket.SentTypes().Contains("overseer-get"));
        socket.Push("""{"type":"overseer","overseer":{"name":"overseer","displayName":"AI Overseer","configured":true,"model":"x","providerConnected":true}}""");
        await Until(() => asked.IsCompleted);
        Assert.True((await asked).GetProperty("overseer").GetProperty("configured").GetBoolean());

        var failing = session.Ask(ClientFrames.Json("pack-install", J.O(("id", JsonValue.Create("x")))), "pack-report", "pack-install");
        socket.Push("""{"type":"error","message":"No pack x","requestType":"pack-install"}""");
        await Until(() => failing.IsCompleted);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => failing);
        Assert.Equal("No pack x", error.Message);
        session.End();
    }

    [Fact]
    public async Task Lookups_offer_models_presets_agents_and_tools()
    {
        var (session, socket) = await Connect();
        var lookups = new Lookups(session);
        socket.Push("""{"type":"settings","settings":{"models":[{"ref":"openai/gpt","label":"GPT"}],"presets":[{"name":"fast","model":"openai/gpt"}],"catalog":[{"id":"openai","name":"OpenAI"}]}}""");
        socket.Push("""{"type":"tools","tools":[{"name":"web_search","risk":"network"}],"presets":[],"custom":[],"secretKeys":{},"connectors":[{"key":"slack","label":"Slack"}]}""");
        socket.Push("""{"type":"agents","agents":[{"name":"mimi","displayName":"มิมิ"}],"tools":[],"defaultAgent":"mimi"}""");
        await Until(() => lookups.Get("agents").Count == 1 && lookups.Get("tools").Count == 1);
        Assert.Equal([("fast", "🎛 fast → openai/gpt"), ("openai/gpt", "GPT (openai/gpt)")], lookups.Get("models"));
        Assert.Equal([("openai/gpt", "GPT (openai/gpt)")], lookups.Get("models-only"));
        Assert.Equal("slack", lookups.Get("connectors").Single().Value);
        Assert.Equal("มิมิ (mimi)", lookups.Get("agents").Single().Label);
        session.End();
    }

    [Fact]
    public async Task Task_cards_follow_the_task_events_and_send_their_controls()
    {
        var (session, socket) = await Connect();
        var chat = new ChatViewModel(session);
        chat.Open(1);
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":5,"chatId":1},"sessions":[{"id":5,"chatId":1,"title":"วันนี้"},{"id":4,"chatId":1}],"messages":[],"hasMore":false}""");
        await Until(() => chat.Timeline.Loaded);
        Assert.Contains(socket.Sent, text => text == """{"type":"session-context","chatId":1,"sessionId":5}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":5,"agent":"mimi","event":{"type":"task-start","task":{"id":"t1","goal":"จัดไฟล์ Downloads","status":"running","steps":[{"id":"s1","title":"สำรวจ","status":"running"}]}}}""");
        await Until(() => chat.Items.OfType<TaskItem>().Any());
        var card = chat.Items.OfType<TaskItem>().Single();
        Assert.Equal("กำลังทำ", card.StatusLabel);
        Assert.True(card.CanPause);
        Assert.Equal("… สำรวจ", card.Steps);
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":5,"agent":"mimi","event":{"type":"task-step","taskId":"t1","step":{"id":"s1","title":"สำรวจ","status":"done","detail":"12 ไฟล์"}}}""");
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":5,"agent":"mimi","event":{"type":"task-finish","taskId":"t1","status":"completed","receipt":{"summary":"ย้าย 12 ไฟล์","moved":12,"skipped":0,"failed":0,"examples":[],"undoable":true}}}""");
        await Until(() => chat.Items.OfType<TaskItem>().Single().CanUndo);
        card = chat.Items.OfType<TaskItem>().Single();
        Assert.Equal("✓ สำรวจ — 12 ไฟล์", card.Steps);
        Assert.Contains("ย้าย 12 ไฟล์", card.Summary);
        Assert.False(card.CanCancel);
        chat.TaskUndo("t1");
        Assert.Equal("""{"type":"task-undo","taskId":"t1"}""", socket.Sent.Last());
        chat.TaskControl("t1", "pause");
        Assert.Equal("""{"type":"task-control","taskId":"t1","action":"pause"}""", socket.Sent.Last());

        // The session meter and menu.
        socket.Push("""{"type":"session-context","chatId":1,"sessionId":5,"context":{"usedTokens":2500,"windowTokens":10000,"cacheHitPct":80,"costUsd":0.0123,"conversationTokens":100,"maxTokens":0}}""");
        await Until(() => chat.ContextLabel.Length > 0);
        Assert.Equal("context 25% · cache 80% · $0.012", chat.ContextLabel);
        Assert.Equal("วันนี้", chat.SessionLabel);
        Assert.Equal(2, chat.SessionChoices.Count);
        Assert.True(chat.SessionChoices[0].Current);
        chat.OpenSession(4);
        Assert.Contains(socket.Sent, text => text == """{"type":"chat-open","chatId":1,"sessionId":4}""");
        chat.NewSession();
        Assert.Equal("""{"type":"session-new","chatId":1}""", socket.Sent.Last());
        session.End();
    }

    [Fact]
    public async Task Shared_ui_settings_turn_reading_aloud_on_and_chats_can_be_grouped_renamed_and_deleted()
    {
        var (session, socket) = await Connect();
        var chat = new ChatViewModel(session);
        var spoken = new List<string>();
        chat.SpeakRequested += (text, _) => spoken.Add(text);
        chat.Open(1);
        socket.Push("""{"type":"chat-history","chat":{"id":1,"kind":"group","agents":["mimi","bob"]},"session":{"id":5,"chatId":1},"sessions":[],"messages":[],"hasMore":false}""");
        await Until(() => chat.Timeline.Loaded);
        Assert.True(chat.AutoSpeak); // welcome.ui says so
        socket.Push("""{"type":"chat-event","chatId":1,"sessionId":5,"agent":"mimi","event":{"type":"run-finish","reason":"stop","text":"[emotion: happy]\nสวัสดีค่ะ","rounds":1}}""");
        await Until(() => spoken.Count == 1);
        Assert.Equal("สวัสดีค่ะ", spoken[0]);
        chat.AutoSpeak = false;
        Assert.Equal("""{"type":"ui-set","values":{"mimi.autoSpeak":null}}""", socket.Sent.Last());
        Assert.False(chat.AutoSpeak);
        socket.Push("""{"type":"ui","values":{"mimi.autoSpeak":"1"}}""");
        await Until(() => chat.AutoSpeak);

        chat.UpdateChat("ทีม", ["bob", "mimi"]);
        Assert.Equal("""{"type":"chat-update","chatId":1,"title":"ทีม","agents":["bob","mimi"]}""", socket.Sent.Last());
        chat.DeleteChat();
        Assert.Equal("""{"type":"chat-delete","chatId":1}""", socket.Sent.Last());

        var list = new ChatListViewModel(session);
        long? opened = null;
        list.OpenRequested += id => opened = id;
        Assert.Equal("กลุ่มต้องมี agent อย่างน้อย 2 ตัว", list.NewGroup("x", ["mimi"]));
        Assert.Null(list.NewGroup(" ทีม ", ["mimi", "bob"]));
        Assert.Equal("""{"type":"chat-create","kind":"group","agents":["mimi","bob"],"title":"ทีม"}""", socket.Sent.Last());
        socket.Push("""{"type":"chat-history","chat":{"id":9,"kind":"group","title":"ทีม","agents":["mimi","bob"]},"session":null,"sessions":[],"messages":[],"hasMore":false}""");
        await Until(() => opened == 9);
        Assert.False(list.ShowingDirect);
        session.End();
    }
}
