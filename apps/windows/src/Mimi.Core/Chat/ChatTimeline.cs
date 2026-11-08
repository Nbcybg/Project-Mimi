using System.Text.Json;
using System.Text.RegularExpressions;
using Mimi.Core.Protocol;

namespace Mimi.Core.Chat;

public sealed record PendingMessage(string ClientId, string Text, IReadOnlyList<string> AttachmentNames, string? Failed = null, IReadOnlyList<string>? AttachmentKinds = null);

public sealed record Note(string Text, bool Bad);

/// <summary>A task of this chat as its card shows it (the TaskView JSON, updated by the task events).</summary>
public sealed record TaskCard(string Id, JsonElement Task)
{
    public string Status => Task.TryGetProperty("status", out var status) ? status.GetString() ?? "" : "";
}

public abstract record LiveSegment
{
    public sealed record Text(string Raw) : LiveSegment
    {
        /// <summary>The text without a direction line that is still arriving.</summary>
        public string Shown => Speech.Parse(Raw, live: true).Text;
    }

    public sealed record Tool(string Id, string Name, string Arg, string? Risk, bool? Ok = null, string Output = "") : LiveSegment;

    public sealed record File(AttachmentView Attachment) : LiveSegment;
}

public sealed record LiveBubble(
    string Agent,
    IReadOnlyList<LiveSegment> Segments,
    SpeechStyle? Speech = null,
    /// <summary>A sub-agent working for this one, shown as a small line.</summary>
    string? Helper = null,
    bool Finished = false)
{
    public LiveBubble(string agent) : this(agent, []) { }
}

/// <summary>
/// What one open chat looks like, folded from the frames of <c>/ws</c> (docs/native/realtime.md 4).
/// Pure data and a pure reducer, so the streaming rules are tested without a window — the same rules
/// as the Android app's ChatTimeline.kt.
/// </summary>
public sealed record ChatTimeline(
    long ChatId,
    ChatView? Chat = null,
    SessionView? Session = null,
    IReadOnlyList<ChatMessageView>? Messages = null,
    bool HasMore = false,
    bool Loaded = false,
    /// <summary>Sent by this device, not yet echoed by the core.</summary>
    IReadOnlyList<PendingMessage>? Pending = null,
    /// <summary>The answer streaming in now.</summary>
    LiveBubble? Live = null,
    /// <summary>Answers of this turn that finished before a handoff, until the turn's messages arrive.</summary>
    IReadOnlyList<LiveBubble>? Earlier = null,
    IReadOnlyList<PermissionRequest>? Permissions = null,
    bool Busy = false,
    bool Transcribing = false,
    bool Viewing = false,
    /// <summary>A handoff in flight: who passed the turn on, and to whom, until the next agent's first event.</summary>
    string? HandoffFrom = null,
    string? HandoffTo = null,
    /// <summary>A sub-agent (or skill) working for the agent that is answering.</summary>
    string? SubAgent = null,
    /// <summary>Lines under the conversation: errors, "stopped", handoffs.</summary>
    IReadOnlyList<Note>? Notes = null,
    /// <summary>The chat's pinned messages, from every session.</summary>
    IReadOnlyList<PinView>? Pins = null,
    /// <summary>False while an older session is on screen: new turns land in the newest one.</summary>
    bool Latest = true,
    /// <summary>Every session of the chat, newest first.</summary>
    IReadOnlyList<SessionView>? Sessions = null,
    /// <summary>Tasks started in this chat while it was open (task cards).</summary>
    IReadOnlyList<TaskCard>? Tasks = null,
    ServerFrame.SessionContext? Context = null)
{
    public IReadOnlyList<ChatMessageView> MessageList => Messages ?? [];
    public IReadOnlyList<PendingMessage> PendingList => Pending ?? [];
    public IReadOnlyList<LiveBubble> EarlierList => Earlier ?? [];
    public IReadOnlyList<PermissionRequest> PermissionList => Permissions ?? [];
    public IReadOnlyList<Note> NoteList => Notes ?? [];
    public IReadOnlyList<PinView> PinList => Pins ?? [];
    public IReadOnlyList<SessionView> SessionList => Sessions ?? [];
    public IReadOnlyList<TaskCard> TaskList => Tasks ?? [];
    public long? LastMessageId => MessageList.Count > 0 ? MessageList[^1].Id : null;

    public ChatTimeline AddPending(PendingMessage message) => this with { Pending = [.. PendingList, message] };

    private static IReadOnlyList<ChatMessageView> MergeById(IReadOnlyList<ChatMessageView> a, IReadOnlyList<ChatMessageView> b)
    {
        var byId = new Dictionary<long, ChatMessageView>();
        foreach (var message in a) byId[message.Id] = message;
        foreach (var message in b) byId[message.Id] = message;
        return byId.Values.OrderBy(message => message.Id).ToList();
    }

    private static IReadOnlyList<PermissionRequest> AddPermission(IReadOnlyList<PermissionRequest> list, IEnumerable<PermissionRequest> more) =>
        list.Concat(more).DistinctBy(request => request.Id).ToList();

    internal static string PreviewOf(JsonElement input)
    {
        var text = input.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? "" : input.ToString();
        text = Regex.Replace(text, @"\s+", " ").Trim();
        return text.Length > 160 ? text[..160] + "…" : text;
    }

    public static LiveBubble ToBubble(LiveTurnView live)
    {
        var segments = new List<LiveSegment>();
        foreach (var tool in live.Tools ?? []) segments.Add(new LiveSegment.Tool(tool.Id, tool.Name, tool.Arg, tool.Risk, tool.Ok, tool.Output));
        foreach (var file in live.Attachments ?? []) segments.Add(new LiveSegment.File(file));
        if (live.Text.Length > 0) segments.Add(new LiveSegment.Text(live.Text));
        return new LiveBubble(live.Agent, segments, live.Speech);
    }

    /// <summary>True when the frame belongs to this chat's session on screen (an older session's events are ignored).</summary>
    private bool Showing(long chatId, long sessionId) => chatId == ChatId && (Session is null || sessionId == 0 || Session.Id == sessionId);

    public ChatTimeline Reduce(ServerFrame frame) => frame switch
    {
        ServerFrame.ChatHistory history => history.Chat.Id != ChatId ? this : OnHistory(history),
        ServerFrame.ChatSession next => next.ChatId != ChatId ? this
            // An older session on screen stays there; the turn is in the newest one.
            : !Latest && Session is not null && next.Session.Id != Session.Id ? this
            : Session is not null && next.Session.Id != Session.Id && next.Started ? this with { Session = next.Session, Messages = [], Live = null, Notes = [] }
            : this with { Session = next.Session },
        ServerFrame.SessionContext context => context.ChatId == ChatId && (Session is null || context.SessionId == Session.Id) ? this with { Context = context } : this,
        ServerFrame.MessageMarks marks => marks.ChatId != ChatId ? this : this with
        {
            Pins = marks.Pins,
            Messages = MessageList.Select(message => message.Id == marks.MessageId ? message with { Pinned = marks.Pinned, Reactions = marks.Reactions } : message).ToList(),
        },
        ServerFrame.ChatMessage message => message.ChatId != ChatId ? this : OnMessage(message),
        ServerFrame.ChatEvent chatEvent => !Showing(chatEvent.ChatId, chatEvent.SessionId) ? this : Apply(chatEvent.Agent, chatEvent.Event),
        ServerFrame.ChatTurnMessages turn => turn.ChatId != ChatId ? this : this with { Messages = MergeById(MessageList, turn.Messages), Live = null, Earlier = [] },
        ServerFrame.Busy { ChatId: null } => this with { Busy = false, Transcribing = false, Viewing = false, HandoffFrom = null, HandoffTo = null, SubAgent = null },
        ServerFrame.Busy busy when busy.ChatId != ChatId => this,
        ServerFrame.Busy { Done: true } => this with { Busy = false, Transcribing = false, Viewing = false, HandoffFrom = null, HandoffTo = null, SubAgent = null, Live = Live is { Finished: true } ? Live : null },
        ServerFrame.Busy => this with { Busy = true },
        ServerFrame.Transcribing transcribing => transcribing.ChatId == ChatId ? this with { Transcribing = transcribing.On } : this,
        ServerFrame.Viewing viewing => viewing.ChatId == ChatId ? this with { Viewing = viewing.On } : this,
        ServerFrame.PermissionResolved resolved => this with { Permissions = PermissionList.Where(request => request.Id != resolved.RequestId).ToList() },
        ServerFrame.Error error => OnError(error),
        ServerFrame.Welcome welcome => this with { Permissions = AddPermission(PermissionList, welcome.PendingPermissions), Busy = welcome.BusyChats.Contains(ChatId) },
        _ => this,
    };

    private ChatTimeline OnHistory(ServerFrame.ChatHistory frame)
    {
        if (frame.BeforeId is not null) return this with { Messages = MergeById(frame.Messages, MessageList), HasMore = frame.HasMore };
        if (frame.AfterId is not null && frame.Session?.Id == Session?.Id) return this with { Chat = frame.Chat, Messages = MergeById(MessageList, frame.Messages), Loaded = true, Pins = frame.Pins ?? PinList };
        return this with
        {
            Chat = frame.Chat,
            Session = frame.Session,
            Latest = frame.Session is null || frame.Sessions.Count == 0 || frame.Sessions[0].Id == frame.Session.Id,
            Sessions = frame.Sessions.Count > 0 ? frame.Sessions : SessionList,
            Context = Context is not null && Context.SessionId == frame.Session?.Id ? Context : null,
            Pins = frame.Pins ?? PinList,
            Messages = frame.Messages,
            HasMore = frame.HasMore,
            Loaded = true,
            Live = frame.Live is not null ? ToBubble(frame.Live) : Busy && Live is { Finished: false } ? Live : null,
            Permissions = frame.Live?.PendingPermissions ?? PermissionList,
            // What was sent but never echoed is gone once the log says so.
            Pending = PendingList.Where(sent => !frame.Messages.Any(message => message.Role == "user" && message.Text == sent.Text)).ToList(),
        };
    }

    /// <summary>task-start / -update carry the whole task; the others patch a part of the card.</summary>
    private IReadOnlyList<TaskCard> OnTask(AgentEvent.Task task)
    {
        var json = task.Json;
        if (json.TryGetProperty("task", out var whole) && whole.ValueKind == JsonValueKind.Object && whole.TryGetProperty("id", out var wholeId))
        {
            var id = wholeId.GetString() ?? "";
            var card = new TaskCard(id, whole.Clone());
            return TaskList.Any(entry => entry.Id == id) ? TaskList.Select(entry => entry.Id == id ? card : entry).ToList() : [.. TaskList, card];
        }
        if (!json.TryGetProperty("taskId", out var taskId)) return TaskList;
        var key = taskId.GetString() ?? "";
        var known = TaskList.FirstOrDefault(entry => entry.Id == key);
        if (known is null) return TaskList;
        var node = System.Text.Json.Nodes.JsonNode.Parse(known.Task.GetRawText())!.AsObject();
        switch (task.Type)
        {
            case "task-step" when json.TryGetProperty("step", out var step):
            {
                var steps = node["steps"] as System.Text.Json.Nodes.JsonArray ?? [];
                var stepId = step.TryGetProperty("id", out var sid) ? sid.GetString() : null;
                var at = steps.Select((entry, index) => (entry, index)).FirstOrDefault(pair => pair.entry?["id"]?.GetValue<string>() == stepId).index;
                var parsed = System.Text.Json.Nodes.JsonNode.Parse(step.GetRawText());
                if (stepId is not null && steps.Any(entry => entry?["id"]?.GetValue<string>() == stepId)) steps[at] = parsed;
                else steps.Add(parsed);
                node["steps"] = steps.DeepClone();
                break;
            }
            case "task-plan" when json.TryGetProperty("plan", out var plan):
                node["plan"] = System.Text.Json.Nodes.JsonNode.Parse(plan.GetRawText());
                break;
            case "task-receipt" when json.TryGetProperty("receipt", out var receipt):
                node[json.TryGetProperty("undo", out var undo) && undo.ValueKind == JsonValueKind.True ? "undoReceipt" : "receipt"] = System.Text.Json.Nodes.JsonNode.Parse(receipt.GetRawText());
                break;
            case "task-finish":
                if (json.TryGetProperty("status", out var status)) node["status"] = status.GetString();
                if (json.TryGetProperty("receipt", out var final)) node["receipt"] = System.Text.Json.Nodes.JsonNode.Parse(final.GetRawText());
                break;
        }
        var updated = new TaskCard(key, JsonDocument.Parse(node.ToJsonString()).RootElement.Clone());
        return TaskList.Select(entry => entry.Id == key ? updated : entry).ToList();
    }

    private ChatTimeline OnMessage(ServerFrame.ChatMessage frame)
    {
        var rest = PendingList.Where(sent => !(frame.Message.ClientId is not null && sent.ClientId == frame.Message.ClientId)).ToList();
        return Showing(frame.ChatId, frame.SessionId)
            ? this with { Pending = rest, Messages = MergeById(MessageList, [frame.Message]) }
            : this with { Pending = rest };
    }

    private ChatTimeline OnError(ServerFrame.Error frame)
    {
        if (frame.ClientId is not null && PendingList.Any(sent => sent.ClientId == frame.ClientId))
        {
            return this with { Pending = PendingList.Select(sent => sent.ClientId == frame.ClientId ? sent with { Failed = frame.Message } : sent).ToList() };
        }
        if (frame.ChatId == ChatId) return this with { Notes = [.. NoteList, new Note($"[{frame.Code ?? "E-INTERNAL"}] {frame.Message}", true)] };
        return this;
    }

    private ChatTimeline Apply(string agent, AgentEvent agentEvent)
    {
        switch (agentEvent)
        {
            case AgentEvent.RunStart start:
                return this with
                {
                    Earlier = Live is { Finished: true } ? [.. EarlierList, Live] : EarlierList,
                    Live = new LiveBubble(start.Agent.Length > 0 ? start.Agent : agent),
                    Busy = true,
                    HandoffFrom = null,
                    HandoffTo = null,
                    SubAgent = null,
                };
            case AgentEvent.TextDelta delta:
            {
                var bubble = Live ?? new LiveBubble(agent);
                var segments = bubble.Segments.ToList();
                if (segments.Count > 0 && segments[^1] is LiveSegment.Text last) segments[^1] = new LiveSegment.Text(last.Raw + delta.Text);
                else segments.Add(new LiveSegment.Text(delta.Text));
                return this with { Live = bubble with { Segments = segments } };
            }
            case AgentEvent.ToolCall call:
            {
                var bubble = Live ?? new LiveBubble(agent);
                return this with { Live = bubble with { Segments = [.. bubble.Segments, new LiveSegment.Tool(call.Id, call.Name, PreviewOf(call.Input), call.Risk)] } };
            }
            case AgentEvent.ToolResult result:
                if (Live is null) return this;
                return this with
                {
                    Live = Live with
                    {
                        Segments = Live.Segments.Select(segment => segment is LiveSegment.Tool tool && tool.Id == result.CallId
                            ? tool with { Ok = result.Ok, Output = result.Output.Length > 4000 ? result.Output[..4000] : result.Output }
                            : segment).ToList(),
                    },
                };
            case AgentEvent.Attachment file:
            {
                var bubble = Live ?? new LiveBubble(agent);
                return this with { Live = bubble with { Segments = [.. bubble.Segments, new LiveSegment.File(file.File)] } };
            }
            case AgentEvent.Permission permission:
                return this with { Permissions = AddPermission(PermissionList, [permission.Request]) };
            case AgentEvent.Task task:
                return this with { Tasks = OnTask(task) };
            case AgentEvent.PermissionDecision decision:
                return this with { Permissions = PermissionList.Where(request => request.Id != decision.RequestId).ToList() };
            case AgentEvent.Activity activity:
            {
                var withHelper = Live is not null ? this with { Live = Live with { Helper = activity.Agent } } : this;
                withHelper = withHelper with { SubAgent = activity.Event is AgentEvent.RunFinish ? null : activity.Agent };
                // A sub-agent's permission question is the user's to answer too.
                return activity.Event switch
                {
                    AgentEvent.Permission inner => withHelper with { Permissions = AddPermission(PermissionList, [inner.Request]) },
                    AgentEvent.PermissionDecision inner => withHelper with { Permissions = PermissionList.Where(request => request.Id != inner.RequestId).ToList() },
                    _ => withHelper,
                };
            }
            case AgentEvent.RunFinish finish:
            {
                var bubble = Live ?? new LiveBubble(agent);
                // The final text replaces what streamed in (it lacks the direction line for sure).
                var segments = bubble.Segments.ToList();
                if (finish.Text.Length > 0)
                {
                    var lastText = segments.FindLastIndex(segment => segment is LiveSegment.Text);
                    if (lastText >= 0) segments[lastText] = new LiveSegment.Text(finish.Text);
                    else segments.Add(new LiveSegment.Text(finish.Text));
                }
                Note? note = finish.Reason switch
                {
                    "error" => new Note($"ผิดพลาด [{finish.ErrorCode ?? "E-INTERNAL"}]: {finish.Error ?? ""}", true),
                    "handoff" when finish.HandoffTo is not null => new Note($"↪ ส่งต่อให้ {finish.HandoffTo}", false),
                    "handoff" or "stop" => null,
                    _ => new Note($"หยุด: {finish.Reason}", true),
                };
                var handingOff = finish.Reason == "handoff" && finish.HandoffTo is not null;
                return this with
                {
                    Live = bubble with { Segments = segments, Speech = finish.Speech ?? bubble.Speech, Finished = true },
                    Notes = note is null ? NoteList : [.. NoteList, note],
                    HandoffFrom = handingOff ? bubble.Agent : null,
                    HandoffTo = handingOff ? finish.HandoffTo : null,
                    SubAgent = null,
                };
            }
            default:
                return this;
        }
    }
}
