using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mimi.Core.Chat;
using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

/// <summary>One row of the conversation, ready to show. Equal rows are not redrawn.</summary>
public abstract record ChatItem(string Key);

public sealed record FileItem(string Name, string Mime, string Kind, string Path, string Caption, bool Gone, long Size);

public sealed record MessageItem(
    string Key,
    long Id,
    bool IsUser,
    string Who,
    string Text,
    string? Mood,
    IReadOnlyList<FileItem> Files,
    string Tools,
    string Time,
    ApprovalView? Approval,
    /// <summary>"who: text" of the message this one answers.</summary>
    string? Quote = null,
    /// <summary>"↪ ส่งต่อจาก …" when it was forwarded.</summary>
    string? Forwarded = null,
    IReadOnlyList<string>? Reactions = null,
    bool Pinned = false) : ChatItem(Key)
{
    public bool HasText => Text.Length > 0;
    public bool HasTools => Tools.Length > 0;
    public bool WaitsForApproval => Approval is { Status: "pending" };
    public bool HasQuote => Quote is not null;
    public bool HasForwarded => Forwarded is not null;
    public IReadOnlyList<string> ReactionList => Reactions ?? [];
    public bool HasMarks => ReactionList.Count > 0 || Pinned;
    public bool Loved => ReactionList.Contains(ChatViewModel.Love);
    public bool Equals(MessageItem? other) =>
        other is not null && Key == other.Key && Text == other.Text && Who == other.Who && Mood == other.Mood && Tools == other.Tools && Time == other.Time
        && Approval == other.Approval && Files.SequenceEqual(other.Files) && Quote == other.Quote && Forwarded == other.Forwarded
        && Pinned == other.Pinned && ReactionList.SequenceEqual(other.ReactionList);
    public override int GetHashCode() => HashCode.Combine(Key, Text);
}

/// <summary>A task card (feature-inventory #10): goal, status, steps, plan / receipt, and its buttons.</summary>
public sealed record TaskItem(string Key, string Id, string Goal, string StatusLabel, string Steps, string Summary, bool CanPause, bool CanResume, bool CanCancel, bool CanUndo) : ChatItem(Key)
{
    public bool HasSteps => Steps.Length > 0;
    public bool HasSummary => Summary.Length > 0;
}

/// <summary>The message the next one answers, shown above the composer.</summary>
public sealed record ReplyTarget(long Id, string Who, string Text);

public sealed record PendingItem(string Key, string Text, string Files, string? Failed) : ChatItem(Key)
{
    public bool HasFailed => Failed is not null;
}

/// <summary>A tool row in a streaming answer: name, what it was given, and ✓ / ✗ when done.</summary>
public sealed record ToolRow(string Name, string Arg, string? Risk, bool? Ok, string Output)
{
    public string Mark => Ok switch { true => "✓", false => "✗", null => "…" };
}

public sealed record LiveItem(string Key, string Who, IReadOnlyList<object> Parts, string? Helper, bool Finished, int Version) : ChatItem(Key)
{
    public bool Thinking => Parts.Count == 0 && !Finished;
}

public sealed record NoteItem(string Key, string Text, bool Bad) : ChatItem(Key);

public sealed record PermissionItem(string Key, PermissionRequest Request, string Who, string Detail) : ChatItem(Key)
{
    public bool CanGrant => !Request.NoGrant;
    public string Title => Request.Summary.Length > 0 ? Request.Summary : $"ขอใช้ {Request.Tool}";
}

/// <summary>
/// One open chat: the timeline (Chat/ChatTimeline.cs) folded from the socket's frames, turned into rows,
/// and what the person does there — send, stop, older messages, answer permission cards, approve.
/// </summary>
public sealed partial class ChatViewModel : ObservableObject
{
    public const string Love = "❤️";
    /// <summary>The quick reactions of the web's picker (feature-chat.js).</summary>
    public static readonly IReadOnlyList<string> QuickReactions = ["❤️", "👍", "😂", "😮", "😢", "🙏"];
    /// <summary>How many pages back a jump to a message may load before it gives up.</summary>
    private const int JumpPages = 10;

    private readonly MimiSession session;
    private ChatTimeline timeline = new(0);
    private int sent;
    private int liveVersion;
    private long? jumpTo;
    private int jumpPages;
    private bool jumpWaiting;
    private int pinIndex;

    public ChatViewModel(MimiSession session)
    {
        this.session = session;
        session.Frame += OnFrame;
        session.StateChanged += state =>
        {
            // Back online: catch up with what happened while the socket was gone (realtime.md 7.3).
            if (state is Net.SocketState.Online && ChatId != 0) Reopen();
            OnPropertyChanged(nameof(Online));
        };
    }

    public ObservableCollection<ChatItem> Items { get; } = [];
    public ObservableCollection<AttachmentView> Staged { get; } = [];

    [ObservableProperty]
    private long chatId;

    [ObservableProperty]
    private string title = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSend))]
    private string draft = "";

    [ObservableProperty]
    private bool busy;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status), nameof(HasStatus))]
    private bool transcribing;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status), nameof(HasStatus))]
    private bool viewing;

    [ObservableProperty]
    private bool hasMore;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSend))]
    private bool uploading;

    [ObservableProperty]
    private string error = "";

    /// <summary>A line that is not an error: "forwarded", files put back by a rewind.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasInfo))]
    private string info = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasReply), nameof(ReplyLabel))]
    private ReplyTarget? replying;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPins), nameof(ManyPins), nameof(PinLabel), nameof(PinText))]
    private IReadOnlyList<PinView> pins = [];

    [ObservableProperty]
    private bool olderSession;

    public bool HasInfo => Info.Length > 0;
    public bool HasReply => Replying is not null;
    public string ReplyLabel => Replying is { } reply ? $"ตอบกลับ {reply.Who}: {(reply.Text.Length > 0 ? MessageFormat.Preview(reply.Text, 120) : "(ไฟล์)")}" : "";
    public bool HasPins => Pins.Count > 0;
    public bool ManyPins => Pins.Count > 1;
    public string PinLabel => Pins.Count > 1 ? $"📌 ปักหมุด {Math.Min(pinIndex, Pins.Count - 1) + 1}/{Pins.Count}" : "📌 ปักหมุด";
    public string PinText => Pins.Count == 0 ? "" : PinPreview(Pins[Math.Min(pinIndex, Pins.Count - 1)]);

    public string PinPreview(PinView pin) =>
        $"{(pin.Role == "user" ? "คุณ" : session.AgentName(pin.Agent))}: {(pin.Text.Length > 0 ? MessageFormat.Preview(Speech.Parse(pin.Text).Text, 120) : "(ไฟล์)")}";

    /// <summary>The other chats a message can be forwarded to.</summary>
    public IReadOnlyList<(long Id, string Title)> ForwardTargets =>
        session.Chats.Where(chat => chat.Id != ChatId).Select(chat => (chat.Id, session.ChatTitle(chat))).ToList();

    public bool Online => session.State is Net.SocketState.Online;
    public bool CanSend => !Uploading && (Draft.Trim().Length > 0 || Staged.Count > 0);
    public string Status => Transcribing ? "กำลังถอดเสียง…" : Viewing ? "AI กำลังดูรูป…" : "";
    public bool HasStatus => Status.Length > 0;
    public ChatTimeline Timeline => timeline;

    /// <summary>"sent", "done" or "permission": the app plays its chat sounds (media.md 6).</summary>
    public event Action<string>? Sound;
    /// <summary>New rows at the bottom: the screen scrolls down.</summary>
    public event Action? Grew;
    /// <summary>The screen scrolls to this row (a pin, a search hit).</summary>
    public event Action<string>? JumpRequested;

    /// <summary>
    /// Opens a chat: its newest session, or <paramref name="sessionId"/> scrolled to <paramref name="messageId"/>
    /// (a search hit, a pin of another session).
    /// </summary>
    public void Open(long id, long? sessionId = null, long? messageId = null)
    {
        if (ChatId == id && timeline.Loaded && timeline.Latest && sessionId is null && messageId is null) return;
        Load(id, sessionId, messageId);
    }

    private void Load(long id, long? sessionId, long? messageId)
    {
        var same = ChatId == id;
        ChatId = id;
        timeline = new ChatTimeline(id, Busy: session.BusyChats.Contains(id), Pins: same ? timeline.PinList : null);
        jumpTo = messageId;
        jumpPages = 0;
        if (!same)
        {
            Staged.Clear();
            Draft = "";
            Replying = null;
            pinIndex = 0;
        }
        Error = "";
        Info = "";
        Items.Clear();
        UpdateTitle();
        session.Send(ClientFrames.ChatOpen(id, sessionId));
        Visible(true);
    }

    /// <summary>From an older session back to the newest one.</summary>
    [RelayCommand]
    public void BackToLatest()
    {
        if (ChatId != 0) Load(ChatId, null, null);
    }

    /// <summary>Leaves the chat (back to the list).</summary>
    public void Close()
    {
        Visible(false);
        ChatId = 0;
        timeline = new ChatTimeline(0);
        Items.Clear();
        Replying = null;
        Pins = [];
        OlderSession = false;
    }

    /// <summary>
    /// Whether the person looks at this chat: the core sends no notification for a chat someone is
    /// looking at, so a hidden window must say so (realtime.md 7.2).
    /// </summary>
    public void Visible(bool visible) => session.Send(ClientFrames.Presence(visible && ChatId != 0 ? ChatId : null, visible && ChatId != 0));

    private void Reopen()
    {
        var sessionId = timeline.Session?.Id;
        var last = timeline.LastMessageId;
        session.Send(session.CoreApi >= 1 && sessionId is not null && last is not null
            ? ClientFrames.ChatOpen(ChatId, sessionId, afterId: last)
            : ClientFrames.ChatOpen(ChatId));
        Visible(true);
    }

    private void UpdateTitle()
    {
        var chat = timeline.Chat ?? session.Chats.FirstOrDefault(item => item.Id == ChatId);
        Title = chat is null ? "" : session.ChatTitle(chat);
    }

    private void OnFrame(ServerFrame frame)
    {
        if (ChatId == 0) return;
        var before = timeline;
        timeline = timeline.Reduce(frame);
        if (frame is ServerFrame.ChatHistory history && history.Chat.Id == ChatId)
        {
            jumpWaiting = false;
            if (history.BeforeId is null) AskContext();
        }
        // The finished answer is read aloud when the person chose so.
        if (frame is ServerFrame.ChatEvent { Event: AgentEvent.RunFinish { Reason: "stop" } finish } finished && finished.ChatId == ChatId && AutoSpeak && finish.Text.Length > 0)
        {
            SpeakRequested?.Invoke(Speech.Parse(finish.Text).Text, finish.Speech);
        }
        if (frame is ServerFrame.Busy { Done: true } over && over.ChatId == ChatId) AskContext();
        switch (frame)
        {
            case ServerFrame.ChatChanged changed when changed.ChatId == ChatId && !timeline.Busy:
                Reopen();
                break;
            case ServerFrame.Busy { Done: true } done when done.ChatId == ChatId:
                // A core before api 1 has no chat-turn-messages: the stored answer comes with chat-open.
                if (session.CoreApi < 1) Reopen();
                if (before.Busy) Sound?.Invoke("done");
                break;
            case ServerFrame.ChatEvent { Event: AgentEvent.Permission } when timeline.PermissionList.Count > before.PermissionList.Count:
                Sound?.Invoke("permission");
                break;
            case ServerFrame.Chats or ServerFrame.Agents:
                UpdateTitle();
                break;
            case ServerFrame.Error error when error.RequestType is "chat-send" or "rewind" or "message-pin" or "message-react" && error.ClientId is null:
                Error = error.Message;
                break;
            case ServerFrame.Rewound rewound when rewound.ChatId == ChatId:
                // The message comes back into the composer to edit and send again (app.js 'rewound').
                Draft = rewound.Text;
                Replying = null;
                Info = rewound.Restored.Count > 0 ? $"ย้อนไฟล์กลับ {rewound.Restored.Count} ไฟล์: {string.Join(", ", rewound.Restored)}" : "";
                Error = rewound.Skipped.Count > 0 ? $"บางไฟล์ย้อนไม่ได้: {string.Join(", ", rewound.Skipped)}" : "";
                break;
        }
        if (!ReferenceEquals(before, timeline)) Render(before);
    }

    private static string Time(string iso) => DateTimeOffset.TryParse(iso, out var at) ? at.ToLocalTime().ToString("HH:mm") : "";

    private FileItem File(AttachmentView file) =>
        new(file.Name, file.Mime, file.Kind, MimiApi.FilePath(file.Id), file.Caption.Length > 0 ? file.Caption : file.Text, file.DeletedAt is not null, file.Size);

    private void Render(ChatTimeline before)
    {
        Busy = timeline.Busy;
        Transcribing = timeline.Transcribing;
        Viewing = timeline.Viewing;
        HasMore = timeline.HasMore;
        OlderSession = timeline.Loaded && !timeline.Latest;
        if (!ReferenceEquals(timeline.PinList, before.PinList))
        {
            pinIndex = Math.Min(pinIndex, Math.Max(0, timeline.PinList.Count - 1));
            Pins = timeline.PinList;
        }
        if (timeline.Chat is not null && !ReferenceEquals(timeline.Chat, before.Chat)) UpdateTitle();
        if (!ReferenceEquals(timeline.Live, before.Live) || !ReferenceEquals(timeline.EarlierList, before.EarlierList)) liveVersion++;
        var rows = new List<ChatItem>();
        foreach (var message in timeline.MessageList)
        {
            var user = message.Role == "user";
            var parsed = user ? new ParsedSpeech(message.Text, null) : Speech.Parse(message.Text);
            rows.Add(new MessageItem(
                $"m:{message.Id}",
                message.Id,
                user,
                Who(message),
                parsed.Text.Trim(),
                (message.Speech ?? parsed.Speech)?.Emotion,
                message.Files.Select(File).ToList(),
                string.Join(" · ", message.ToolList.Select(tool => tool.Summary.Length > 0 ? $"{tool.Name}: {tool.Summary}" : tool.Name)),
                Time(message.CreatedAt),
                message.Approval,
                message.ReplyTo is { } quote
                    ? $"{(quote.Role == "user" ? "คุณ" : session.AgentName(quote.Agent))}: {(quote.Text.Length > 0 ? MessageFormat.Preview(Speech.Parse(quote.Text).Text, 140) : "(ไฟล์)")}"
                    : null,
                message.ForwardedFrom is { } from ? $"↪ ส่งต่อจาก {from.From}{(from.Chat.Length > 0 ? $" · {from.Chat}" : "")}" : null,
                message.ReactionList,
                message.Pinned));
        }
        foreach (var pending in timeline.PendingList)
        {
            rows.Add(new PendingItem($"p:{pending.ClientId}", pending.Text, string.Join(", ", pending.AttachmentNames), pending.Failed));
        }
        var bubbles = timeline.EarlierList.Concat(timeline.Live is null ? [] : [timeline.Live]).ToList();
        for (var i = 0; i < bubbles.Count; i++)
        {
            var bubble = bubbles[i];
            var parts = bubble.Segments.Select(segment => segment switch
            {
                LiveSegment.Text text => (object)text.Shown,
                LiveSegment.Tool tool => new ToolRow(tool.Name, tool.Arg, tool.Risk, tool.Ok, tool.Output),
                LiveSegment.File file => File(file.Attachment),
                _ => "",
            }).Where(part => part is not string text || text.Length > 0).ToList();
            rows.Add(new LiveItem($"live:{i}", session.AgentName(bubble.Agent), parts, bubble.Helper, bubble.Finished, liveVersion));
        }
        for (var i = 0; i < timeline.NoteList.Count; i++) rows.Add(new NoteItem($"n:{i}", timeline.NoteList[i].Text, timeline.NoteList[i].Bad));
        foreach (var request in timeline.PermissionList)
        {
            rows.Add(new PermissionItem($"perm:{request.Id}", request, session.AgentName(request.Agent), $"{request.Tool} ({request.Risk}) {ChatTimeline.PreviewOf(request.Input)}"));
        }
        foreach (var task in timeline.TaskList) rows.Add(TaskRow(task));
        if (!ReferenceEquals(timeline.Context, before.Context) || !ReferenceEquals(timeline.Session, before.Session) || !ReferenceEquals(timeline.SessionList, before.SessionList))
        {
            OnPropertyChanged(nameof(SessionLabel));
            OnPropertyChanged(nameof(ContextLabel));
            OnPropertyChanged(nameof(SessionChoices));
        }
        Apply(rows);
        if (jumpTo is { } target && timeline.Loaded) Jump(target);
    }

    private string Who(ChatMessageView message) => message.Role == "user" ? "คุณ" : session.AgentName(message.Agent);

    private static readonly Dictionary<string, string> TaskStatus = new()
    {
        ["queued"] = "รอคิว",
        ["running"] = "กำลังทำ",
        ["awaiting_confirmation"] = "รอให้ยืนยัน",
        ["paused"] = "หยุดชั่วคราว",
        ["cancelled"] = "ยกเลิกแล้ว",
        ["completed"] = "เสร็จแล้ว ✓",
        ["failed"] = "ไม่สำเร็จ ✗",
        ["undone"] = "ย้อนแล้ว",
    };

    private static string Str(System.Text.Json.JsonElement json, string key) =>
        json.ValueKind == System.Text.Json.JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.String ? value.GetString() ?? "" : "";

    private static string Num(System.Text.Json.JsonElement json, string key) =>
        json.ValueKind == System.Text.Json.JsonValueKind.Object && json.TryGetProperty(key, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.Number ? value.GetRawText() : "0";

    private static TaskItem TaskRow(TaskCard card)
    {
        var task = card.Task;
        var status = card.Status;
        var steps = task.TryGetProperty("steps", out var list) && list.ValueKind == System.Text.Json.JsonValueKind.Array
            ? string.Join("\n", list.EnumerateArray().Select(step =>
            {
                var mark = Str(step, "status") switch { "done" => "✓", "running" => "…", "failed" => "✗", "skipped" => "–", "cancelled" => "■", _ => "○" };
                var detail = Str(step, "detail");
                return $"{mark} {Str(step, "title")}{(detail.Length > 0 ? $" — {detail}" : "")}";
            }))
            : "";
        var summary = new List<string>();
        if (task.TryGetProperty("plan", out var plan) && plan.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            summary.Add($"แผน: {Num(plan, "total")} ไฟล์ใน {Str(plan, "folder")} ({Str(plan, "policy")})");
        }
        if (task.TryGetProperty("receipt", out var receipt) && receipt.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            summary.Add($"ผล: {Str(receipt, "summary")} · ย้าย {Num(receipt, "moved")} · ข้าม {Num(receipt, "skipped")} · ล้มเหลว {Num(receipt, "failed")}");
        }
        if (task.TryGetProperty("undoReceipt", out var undone) && undone.ValueKind == System.Text.Json.JsonValueKind.Object) summary.Add($"ย้อน: {Str(undone, "summary")}");
        if (task.TryGetProperty("verification", out var check) && check.ValueKind == System.Text.Json.JsonValueKind.Object) summary.Add($"ตรวจผล: {Str(check, "summary")}");
        if (Str(task, "error") is { Length: > 0 } error) summary.Add($"ผิดพลาด: {error}");
        var undoable = status == "completed" && receipt.ValueKind == System.Text.Json.JsonValueKind.Object && receipt.TryGetProperty("undoable", out var can) && can.ValueKind == System.Text.Json.JsonValueKind.True;
        return new TaskItem($"task:{card.Id}", card.Id, Str(task, "goal"), TaskStatus.GetValueOrDefault(status, status), steps, string.Join("\n", summary),
            CanPause: status is "running" or "queued", CanResume: status == "paused", CanCancel: status is "running" or "queued" or "paused" or "awaiting_confirmation", CanUndo: undoable);
    }

    /// <summary>pause / resume / cancel of a task card.</summary>
    public void TaskControl(string taskId, string action) =>
        session.Send(ClientFrames.Json("task-control", new System.Text.Json.Nodes.JsonObject { ["taskId"] = taskId, ["action"] = action }));

    /// <summary>Puts back the files a finished task moved, from its journal.</summary>
    public void TaskUndo(string taskId) => session.Send(ClientFrames.Json("task-undo", new System.Text.Json.Nodes.JsonObject { ["taskId"] = taskId }));

    // ---------- sessions (feature-inventory #14) ----------

    public string SessionLabel => timeline.Session is { } shown
        ? $"{(shown.Title.Length > 0 ? shown.Title : timeline.SessionList.FirstOrDefault(entry => entry.Id == shown.Id)?.Title is { Length: > 0 } listed ? listed : $"Session #{shown.Id}")}{(timeline.Latest ? "" : " (เก่า)")}"
        : "";

    /// <summary>"Context 23% · cache 80% · $0.012" for the header meter.</summary>
    public string ContextLabel => timeline.Context is { } context && context.WindowTokens > 0
        ? $"context {Math.Round(100.0 * context.UsedTokens / context.WindowTokens)}%{(context.CacheHitPct is { } cache ? $" · cache {Math.Round(cache)}%" : "")} · ${context.CostUsd:0.###}"
        : "";

    /// <summary>The chat's sessions for the session menu: (id, "title · date").</summary>
    public IReadOnlyList<(long Id, string Label, bool Current)> SessionChoices => timeline.SessionList
        .Select(entry => (entry.Id, $"{(entry.Title.Length > 0 ? entry.Title : $"Session #{entry.Id}")} · {ChatListViewModel.When(entry.LastMessageAt.Length > 0 ? entry.LastMessageAt : entry.CreatedAt, DateTimeOffset.Now)}{(entry.Unread ? " · ใหม่" : "")}",
            entry.Id == timeline.Session?.Id))
        .ToList();

    /// <summary>Starts a new session by hand; the next message goes there.</summary>
    [RelayCommand]
    public void NewSession()
    {
        if (ChatId == 0) return;
        if (!timeline.Latest) Load(ChatId, null, null);
        session.Send(ClientFrames.Json("session-new", new System.Text.Json.Nodes.JsonObject { ["chatId"] = ChatId }));
    }

    public void OpenSession(long sessionId)
    {
        if (ChatId == 0) return;
        if (timeline.SessionList.Count > 0 && timeline.SessionList[0].Id == sessionId) Load(ChatId, null, null);
        else Load(ChatId, sessionId, null);
    }

    private void AskContext()
    {
        if (ChatId == 0) return;
        var json = new System.Text.Json.Nodes.JsonObject { ["chatId"] = ChatId };
        if (timeline.Session is { } shown) json["sessionId"] = shown.Id;
        session.Send(ClientFrames.Json("session-context", json));
    }

    // ---------- the chat itself: rename, members, delete, export ----------

    public ChatView? Chat => timeline.Chat ?? session.Chats.FirstOrDefault(item => item.Id == ChatId);

    /// <summary>Every agent, for the members of a group: (name, shown name).</summary>
    public IReadOnlyList<(string Name, string Shown)> AllAgents => session.Agents.Values.OrderBy(agent => agent.ShownName).Select(agent => (agent.Name, agent.ShownName)).ToList();

    /// <summary>In a group, the members to offer for the "@…" the caret is in (app.js renderMention); empty elsewhere.</summary>
    public IReadOnlyList<(string Name, string Shown)> MentionOptions(string text, int caret)
    {
        if (Chat is not { Kind: "group" } group || Mentions.At(text, caret) is not { } typing) return [];
        var members = group.AgentNames.Select(name => (name, session.Agents.TryGetValue(name, out var agent) ? agent.ShownName : name));
        return Mentions.Options(members, typing.Typed);
    }

    public void UpdateChat(string? title, IReadOnlyList<string>? agents)
    {
        var json = new System.Text.Json.Nodes.JsonObject { ["chatId"] = ChatId };
        if (title is not null) json["title"] = title;
        if (agents is not null) json["agents"] = new System.Text.Json.Nodes.JsonArray(agents.Select(agent => (System.Text.Json.Nodes.JsonNode?)agent).ToArray());
        session.Send(ClientFrames.Json("chat-update", json));
    }

    public void DeleteChat()
    {
        if (ChatId == 0) return;
        session.Send(ClientFrames.Json("chat-delete", new System.Text.Json.Nodes.JsonObject { ["chatId"] = ChatId }));
    }

    // ---------- reading aloud (feature-inventory #20) ----------

    /// <summary>An answer to read aloud: (text, how it should sound). The app's speaker does it.</summary>
    public event Action<string, SpeechStyle?>? SpeakRequested;

    /// <summary>Read every new answer aloud (the web's 🔊 auto, <c>mimi.autoSpeak</c> shared by the devices).</summary>
    public bool AutoSpeak
    {
        get => session.UiValue("mimi.autoSpeak") == "1";
        set
        {
            session.SetUi("mimi.autoSpeak", value ? "1" : null);
            OnPropertyChanged();
        }
    }

    public void Speak(long id)
    {
        if (Message(id) is { } message) SpeakRequested?.Invoke(TextOf(id), message.Speech ?? Speech.Parse(message.Text).Speech);
    }

    /// <summary>Scrolls to a message once it is on the page, loading older pages for it (up to <see cref="JumpPages"/>).</summary>
    private void Jump(long messageId)
    {
        if (timeline.MessageList.Any(message => message.Id == messageId))
        {
            jumpTo = null;
            JumpRequested?.Invoke($"m:{messageId}");
        }
        else if (jumpWaiting)
        {
            // the older page asked for is on its way
        }
        else if (timeline.HasMore && jumpPages < JumpPages)
        {
            jumpPages++;
            jumpWaiting = true;
            LoadOlder();
        }
        else
        {
            jumpTo = null;
        }
    }

    /// <summary>Puts the new rows in the list, touching only the rows that changed.</summary>
    private void Apply(List<ChatItem> rows)
    {
        var grew = rows.Count > Items.Count || (rows.Count > 0 && Items.Count > 0 && rows[^1].Key != Items[^1].Key);
        var keys = rows.Select(row => row.Key).ToHashSet();
        for (var i = Items.Count - 1; i >= 0; i--)
        {
            if (!keys.Contains(Items[i].Key)) Items.RemoveAt(i);
        }
        for (var i = 0; i < rows.Count; i++)
        {
            if (i < Items.Count && Items[i].Key == rows[i].Key)
            {
                if (!Items[i].Equals(rows[i])) Items[i] = rows[i];
                continue;
            }
            var found = -1;
            for (var j = i + 1; j < Items.Count; j++)
            {
                if (Items[j].Key == rows[i].Key)
                {
                    found = j;
                    break;
                }
            }
            if (found >= 0)
            {
                Items.Move(found, i);
                if (!Items[i].Equals(rows[i])) Items[i] = rows[i];
            }
            else
            {
                Items.Insert(i, rows[i]);
            }
        }
        while (Items.Count > rows.Count) Items.RemoveAt(Items.Count - 1);
        if (grew || timeline.Live is not null) Grew?.Invoke();
    }

    [RelayCommand]
    public void Send()
    {
        var text = Draft.Trim();
        if ((text.Length == 0 && Staged.Count == 0) || ChatId == 0 || Uploading) return;
        var clientId = $"w-{Environment.TickCount64:x}-{++sent}";
        var files = Staged.ToList();
        if (!timeline.Latest)
        {
            // The message goes into the newest session: show that one, then send.
            Load(ChatId, null, null);
        }
        var before = timeline;
        timeline = timeline.AddPending(new PendingMessage(clientId, text, files.Select(file => file.Name).ToList()));
        session.Send(ClientFrames.ChatSend(ChatId, text, files.Select(file => file.Id).ToList(), clientId, Replying?.Id));
        Draft = "";
        Replying = null;
        Staged.Clear();
        OnPropertyChanged(nameof(CanSend));
        Sound?.Invoke("sent");
        Render(before);
    }

    [RelayCommand]
    public void Stop()
    {
        if (ChatId != 0) session.Send(ClientFrames.Abort(ChatId));
    }

    [RelayCommand]
    public void LoadOlder()
    {
        if (timeline.MessageList.Count == 0) return;
        session.Send(ClientFrames.ChatOpen(ChatId, timeline.Session?.Id, beforeId: timeline.MessageList[0].Id));
    }

    /// <summary>The answer to a permission card: scope once | task | session | always.</summary>
    public void Answer(string requestId, bool allow, string scope = "once") => session.Send(ClientFrames.PermissionResponse(requestId, allow, scope));

    public void Approve(long approvalId, bool approved) => session.Send(ClientFrames.ApprovalDecide(approvalId, approved));

    // ---------- reply, forward, react, pin, rewind (feature-chat.js, app.js rewind) ----------

    private ChatMessageView? Message(long id) => timeline.MessageList.FirstOrDefault(message => message.Id == id);

    /// <summary>The text a message shows (without the agent's voice direction line), for copying.</summary>
    public string TextOf(long id) => Message(id) is { } message ? (message.Role == "user" ? message.Text : Speech.Parse(message.Text).Text).Trim() : "";

    public void ReplyTo(long id)
    {
        if (Message(id) is { } message) Replying = new ReplyTarget(id, Who(message), TextOf(id));
    }

    [RelayCommand]
    public void CancelReply() => Replying = null;

    /// <summary>Adds the emoji, or takes it back when the message has it already (the core toggles).</summary>
    public void React(long id, string emoji) => session.Send(ClientFrames.MessageReact(id, emoji));

    public void TogglePin(long id)
    {
        if (Message(id) is { } message) session.Send(ClientFrames.MessagePin(id, !message.Pinned));
    }

    public void Unpin(long id) => session.Send(ClientFrames.MessagePin(id, false));

    /// <summary>Sends a copy of the message (text and files) to another chat, marked as forwarded.</summary>
    public void Forward(long id, long toChat)
    {
        if (Message(id) is not { } message) return;
        var target = session.Chats.FirstOrDefault(chat => chat.Id == toChat);
        session.Send(ClientFrames.ChatSend(toChat, TextOf(id), message.Files.Select(file => file.Id).ToList(), null,
            forward: new ForwardedFrom(Who(message), Title)));
        Info = $"ส่งต่อไปที่ {(target is null ? "แชตนั้น" : session.ChatTitle(target))} แล้ว";
    }

    /// <summary>Why a message cannot be taken back now, or null when it can (the caller confirms first).</summary>
    public string? RewindProblem(long id)
    {
        if (Message(id) is not { Role: "user" }) return "ย้อนกลับได้เฉพาะข้อความของคุณ";
        if (!timeline.Latest) return "ย้อนกลับได้เฉพาะใน session ล่าสุด";
        if (Busy) return "รอให้ตอบเสร็จก่อน หรือกดหยุด แล้วค่อยย้อนกลับ";
        if (timeline.Session is null) return "ยังโหลดแชตไม่เสร็จ";
        return null;
    }

    /// <summary>
    /// Takes the conversation back to just before this message of the user: the core hides it and what came after,
    /// puts back files the agents changed, and the text returns to the composer (<c>rewound</c>).
    /// </summary>
    public void Rewind(long id)
    {
        if (RewindProblem(id) is { } problem)
        {
            Error = problem;
            return;
        }
        Error = "";
        session.Send(ClientFrames.Rewind(timeline.Session!.Id, id));
    }

    /// <summary>The pin bar was clicked: go to the pin it shows, and show the next one.</summary>
    [RelayCommand]
    public void NextPin()
    {
        if (Pins.Count == 0) return;
        var pin = Pins[Math.Min(pinIndex, Pins.Count - 1)];
        pinIndex = (pinIndex + 1) % Pins.Count;
        OnPropertyChanged(nameof(PinLabel));
        OnPropertyChanged(nameof(PinText));
        GoTo(pin);
    }

    /// <summary>Scrolls to a pinned message, opening its session when it is another one.</summary>
    public void GoTo(PinView pin)
    {
        if (Message(pin.Id) is not null) JumpRequested?.Invoke($"m:{pin.Id}");
        else Open(ChatId, pin.SessionId, pin.Id);
    }

    /// <summary>Uploads a file to send with the next message (api-contract.md A.3, ≤ 25 MB), a picture with its caption.</summary>
    public async Task Attach(Stream content, string name, string mime, string? caption = null)
    {
        Error = "";
        Uploading = true;
        try
        {
            var file = await session.Api.Upload(content, name, mime, string.IsNullOrWhiteSpace(caption) ? null : caption.Trim());
            Staged.Add(file);
        }
        catch (Exception problem) when (problem is MimiHttpException or HttpRequestException or TaskCanceledException)
        {
            Error = $"ส่งไฟล์ {name} ไม่ได้: {problem.Message}";
        }
        finally
        {
            Uploading = false;
            OnPropertyChanged(nameof(CanSend));
        }
    }

    [RelayCommand]
    public void Unstage(AttachmentView file)
    {
        Staged.Remove(file);
        OnPropertyChanged(nameof(CanSend));
    }
}
