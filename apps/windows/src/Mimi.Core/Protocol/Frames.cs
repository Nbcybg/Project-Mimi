using System.Text.Json;
using System.Text.Json.Nodes;

namespace Mimi.Core.Protocol;

/// <summary>What a tool, a sub-agent or the model did during a turn (packages/shared/src/events.ts).</summary>
public abstract record AgentEvent
{
    public sealed record RunStart(string Agent, string Model) : AgentEvent;
    public sealed record TextDelta(string Text) : AgentEvent;
    public sealed record ToolCall(string Id, string Name, JsonElement Input, string? Risk) : AgentEvent;
    public sealed record ToolResult(string CallId, bool Ok, string Output) : AgentEvent;
    public sealed record Attachment(AttachmentView File) : AgentEvent;
    public sealed record Permission(PermissionRequest Request) : AgentEvent;
    public sealed record PermissionDecision(string RequestId) : AgentEvent;
    public sealed record Activity(string Agent, AgentEvent Event) : AgentEvent;
    public sealed record RunFinish(string Reason, string Text, SpeechStyle? Speech, string? Error, string? ErrorCode, string? HandoffTo) : AgentEvent;
    /// <summary>A task card event (task-start / -update / -step / -plan / -receipt / -finish), kept as JSON.</summary>
    public sealed record Task(string Type, JsonElement Json) : AgentEvent;
    /// <summary>Usage, task cards and anything newer: not shown by this version of the app.</summary>
    public sealed record Other(string Type) : AgentEvent;
}

/// <summary>Frames the core sends (protocol.ts ServerMessage); only the ones this app uses are typed.</summary>
public abstract record ServerFrame
{
    public sealed record Welcome(
        IReadOnlyList<AgentSummary> AgentSummaries,
        string DefaultAgent,
        IReadOnlyList<long> BusyChats,
        IReadOnlyList<PermissionRequest> PendingPermissions,
        string? Version,
        int Api,
        int MinClientApi) : ServerFrame;
    public sealed record Pong : ServerFrame;
    public sealed record Chats(IReadOnlyList<ChatView> List) : ServerFrame;
    public sealed record Agents(IReadOnlyList<AgentView> List, string? DefaultAgent) : ServerFrame;
    public sealed record ChatHistory(
        ChatView Chat,
        SessionView? Session,
        IReadOnlyList<SessionView> Sessions,
        IReadOnlyList<ChatMessageView> Messages,
        bool HasMore,
        long? BeforeId,
        long? AfterId,
        LiveTurnView? Live,
        IReadOnlyList<PinView>? Pins = null) : ServerFrame;
    public sealed record ChatSession(long ChatId, SessionView Session, bool Started) : ServerFrame;
    public sealed record ChatMessage(long ChatId, long SessionId, ChatMessageView Message) : ServerFrame;
    public sealed record ChatEvent(long ChatId, long SessionId, string Agent, AgentEvent Event) : ServerFrame;
    public sealed record ChatTurnMessages(long ChatId, long SessionId, long AfterId, IReadOnlyList<ChatMessageView> Messages) : ServerFrame;
    public sealed record Busy(long? ChatId, bool Done) : ServerFrame;
    public sealed record Transcribing(long ChatId, bool On) : ServerFrame;
    public sealed record Viewing(long ChatId, bool On) : ServerFrame;
    public sealed record ChatChanged(long ChatId, long SessionId) : ServerFrame;
    public sealed record PermissionResolved(string RequestId) : ServerFrame;
    public sealed record Notification(string Kind, string Title, string Body, long? ChatId, long? Id) : ServerFrame;
    /// <summary>An event of background work outside any chat (it may ask for permission).</summary>
    public sealed record Background(AgentEvent Event) : ServerFrame;
    public sealed record Mimiamp(MimiampCommand Command) : ServerFrame;
    public sealed record Error(string Message, string? Code, long? ChatId, string? ClientId, string? RequestType) : ServerFrame;
    public sealed record SecurityAlert(string At) : ServerFrame;
    public sealed record PcStatus(bool Online, string? Name) : ServerFrame;
    /// <summary>How full a session is (the header meter): tokens sent, the window, cache share, cost.</summary>
    public sealed record SessionContext(long ChatId, long SessionId, long UsedTokens, long WindowTokens, double? CacheHitPct, double CostUsd, long ConversationTokens, long MaxTokens) : ServerFrame;
    /// <summary>Screen settings shared by the user's devices that changed (null = removed).</summary>
    public sealed record Ui(IReadOnlyDictionary<string, string?> Values) : ServerFrame;
    /// <summary>A message was pinned or unpinned, or its reactions changed; <see cref="Pins"/> is the chat's whole pin list.</summary>
    public sealed record MessageMarks(long ChatId, long SessionId, long MessageId, bool Pinned, IReadOnlyList<string> Reactions, IReadOnlyList<PinView> Pins) : ServerFrame;
    /// <summary>The answer to <c>rewind</c>: the text taken back, to edit and send again, and the files put back.</summary>
    public sealed record Rewound(long ChatId, long SessionId, string Text, IReadOnlyList<string> Restored, IReadOnlyList<string> Skipped) : ServerFrame;
    public sealed record SearchResults(string Query, IReadOnlyList<SearchHit> Hits) : ServerFrame;
    /// <summary>The notification inbox (the newest first) and how many are unread.</summary>
    public sealed record Notifications(IReadOnlyList<NotificationSyncItem> Items, int Unread) : ServerFrame;
    public sealed record Unknown(string Type) : ServerFrame;
}

/// <summary>Parses the text frames of <c>/ws</c>. Never throws: a broken frame is <see cref="ServerFrame.Unknown"/>.</summary>
public static class FrameParser
{
    private static string? Str(JsonElement json, string key) =>
        json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static long? Long(JsonElement json, string key) =>
        json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : null;

    private static bool Bool(JsonElement json, string key) =>
        json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;

    private static JsonElement Get(JsonElement json, string key) =>
        json.TryGetProperty(key, out var value) ? value : default;

    private static T? Decode<T>(JsonElement json, string key) => MimiJson.Decode<T>(Get(json, key));

    private static IReadOnlyList<T> List<T>(JsonElement json, string key) => Decode<List<T>>(json, key) ?? [];

    private static T Required<T>(T? value, string what) where T : class =>
        value ?? throw new FormatException($"missing {what}");

    private static long Required(long? value, string what) => value ?? throw new FormatException($"missing {what}");

    public static AgentEvent ParseEvent(JsonElement json)
    {
        var type = Str(json, "type") ?? "";
        switch (type)
        {
            case "run-start":
                return new AgentEvent.RunStart(Str(json, "agent") ?? "", Str(json, "model") ?? "");
            case "text-delta":
                return new AgentEvent.TextDelta(Str(json, "text") ?? "");
            case "tool-call":
            {
                var call = Get(json, "call");
                return call.ValueKind == JsonValueKind.Object
                    ? new AgentEvent.ToolCall(Str(call, "id") ?? "", Str(call, "name") ?? "", Get(call, "input").Clone(), Str(json, "risk"))
                    : new AgentEvent.Other(type);
            }
            case "tool-result":
            {
                var result = Get(json, "result");
                return result.ValueKind == JsonValueKind.Object
                    ? new AgentEvent.ToolResult(Str(result, "callId") ?? "", Bool(result, "ok"), Str(result, "output") ?? "")
                    : new AgentEvent.Other(type);
            }
            case "attachment":
                return Decode<AttachmentView>(json, "attachment") is { } file ? new AgentEvent.Attachment(file) : new AgentEvent.Other(type);
            case "permission-request":
                return Decode<PermissionRequest>(json, "request") is { } request ? new AgentEvent.Permission(request) : new AgentEvent.Other(type);
            case "permission-decision":
                return new AgentEvent.PermissionDecision(Str(json, "requestId") ?? "");
            case "agent-activity":
            {
                var inner = Get(json, "event");
                return new AgentEvent.Activity(Str(json, "agent") ?? "", inner.ValueKind == JsonValueKind.Object ? ParseEvent(inner) : new AgentEvent.Other("?"));
            }
            case "run-finish":
            {
                var handoff = Get(json, "handoff");
                return new AgentEvent.RunFinish(
                    Str(json, "reason") ?? "",
                    Str(json, "text") ?? "",
                    Decode<SpeechStyle>(json, "speech"),
                    Str(json, "error"),
                    Str(json, "errorCode"),
                    handoff.ValueKind == JsonValueKind.Object ? Str(handoff, "to") : null);
            }
            case "task-start" or "task-update" or "task-step" or "task-plan" or "task-receipt" or "task-finish":
                return new AgentEvent.Task(type, json.Clone());
            default:
                return new AgentEvent.Other(type);
        }
    }

    public static ServerFrame Parse(string text)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            return new ServerFrame.Unknown("");
        }
        using (document)
        {
            var json = document.RootElement;
            if (json.ValueKind != JsonValueKind.Object) return new ServerFrame.Unknown("");
            var type = Str(json, "type") ?? "";
            try
            {
                return ParseKnown(json, type);
            }
            catch (Exception error) when (error is FormatException or JsonException or InvalidOperationException)
            {
                return new ServerFrame.Unknown(type);
            }
        }
    }

    private static ServerFrame ParseKnown(JsonElement json, string type) => type switch
    {
        "welcome" => new ServerFrame.Welcome(
            List<AgentSummary>(json, "agents"),
            Str(json, "defaultAgent") ?? "",
            List<long>(json, "busyChats"),
            List<PermissionRequest>(json, "pendingPermissions"),
            Str(json, "version"),
            (int)(Long(json, "api") ?? 0),
            (int)(Long(json, "minClientApi") ?? 0)),
        "pong" => new ServerFrame.Pong(),
        "chats" => new ServerFrame.Chats(List<ChatView>(json, "chats")),
        "agents" => new ServerFrame.Agents(List<AgentView>(json, "agents"), Str(json, "defaultAgent")),
        "chat-history" => new ServerFrame.ChatHistory(
            Required(Decode<ChatView>(json, "chat"), "chat"),
            Decode<SessionView>(json, "session"),
            List<SessionView>(json, "sessions"),
            List<ChatMessageView>(json, "messages"),
            Bool(json, "hasMore"),
            Long(json, "beforeId"),
            Long(json, "afterId"),
            Decode<LiveTurnView>(json, "live"),
            List<PinView>(json, "pins")),
        "chat-session" => new ServerFrame.ChatSession(Required(Long(json, "chatId"), "chatId"), Required(Decode<SessionView>(json, "session"), "session"), Bool(json, "started")),
        "chat-message" => new ServerFrame.ChatMessage(Required(Long(json, "chatId"), "chatId"), Long(json, "sessionId") ?? 0, Required(Decode<ChatMessageView>(json, "message"), "message")),
        "chat-event" => new ServerFrame.ChatEvent(
            Required(Long(json, "chatId"), "chatId"),
            Long(json, "sessionId") ?? 0,
            Str(json, "agent") ?? "",
            Get(json, "event").ValueKind == JsonValueKind.Object ? ParseEvent(Get(json, "event")) : throw new FormatException("missing event")),
        "chat-turn-messages" => new ServerFrame.ChatTurnMessages(
            Required(Long(json, "chatId"), "chatId"),
            Long(json, "sessionId") ?? 0,
            Long(json, "afterId") ?? 0,
            List<ChatMessageView>(json, "messages")),
        "busy" => new ServerFrame.Busy(Long(json, "chatId"), Bool(json, "done")),
        "chat-transcribing" => new ServerFrame.Transcribing(Required(Long(json, "chatId"), "chatId"), Bool(json, "on")),
        "chat-viewing" => new ServerFrame.Viewing(Required(Long(json, "chatId"), "chatId"), Bool(json, "on")),
        "chat-changed" => new ServerFrame.ChatChanged(Required(Long(json, "chatId"), "chatId"), Long(json, "sessionId") ?? 0),
        "permission-resolved" => new ServerFrame.PermissionResolved(Str(json, "requestId") ?? ""),
        "notification" => ParseNotification(Get(json, "notification")),
        "event" => Get(json, "event").ValueKind == JsonValueKind.Object ? new ServerFrame.Background(ParseEvent(Get(json, "event"))) : new ServerFrame.Unknown(type),
        "mimiamp" => new ServerFrame.Mimiamp(Required(Decode<MimiampCommand>(json, "command"), "command")),
        "error" => new ServerFrame.Error(Str(json, "message") ?? "", Str(json, "code"), Long(json, "chatId"), Str(json, "clientId"), Str(json, "requestType")),
        "security-alert" => new ServerFrame.SecurityAlert(Str(json, "at") ?? ""),
        "pc-status" => new ServerFrame.PcStatus(Bool(json, "online"), Str(json, "name")),
        "session-context" => ParseContext(json),
        "ui" => new ServerFrame.Ui(Decode<Dictionary<string, string?>>(json, "values") ?? []),
        "message-marks" => new ServerFrame.MessageMarks(
            Required(Long(json, "chatId"), "chatId"),
            Long(json, "sessionId") ?? 0,
            Required(Long(json, "messageId"), "messageId"),
            Bool(json, "pinned"),
            List<string>(json, "reactions"),
            List<PinView>(json, "pins")),
        "rewound" => new ServerFrame.Rewound(
            Required(Long(json, "chatId"), "chatId"),
            Long(json, "sessionId") ?? 0,
            Str(json, "text") ?? "",
            List<string>(json, "restored"),
            List<string>(json, "skipped")),
        "search-results" => new ServerFrame.SearchResults(Str(json, "query") ?? "", List<SearchHit>(json, "hits")),
        "notifications" => new ServerFrame.Notifications(List<NotificationSyncItem>(json, "items"), (int)(Long(json, "unread") ?? 0)),
        _ => new ServerFrame.Unknown(type),
    };

    private static ServerFrame ParseContext(JsonElement json)
    {
        var context = Get(json, "context");
        if (context.ValueKind != JsonValueKind.Object) throw new FormatException("missing context");
        double? Number(string key) => context.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
        return new ServerFrame.SessionContext(Required(Long(json, "chatId"), "chatId"), Long(json, "sessionId") ?? 0, (long)(Number("usedTokens") ?? 0), (long)(Number("windowTokens") ?? 0),
            Number("cacheHitPct"), Number("costUsd") ?? 0, (long)(Number("conversationTokens") ?? 0), (long)(Number("maxTokens") ?? 0));
    }

    private static ServerFrame ParseNotification(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object) throw new FormatException("missing notification");
        return new ServerFrame.Notification(Str(item, "kind") ?? "", Str(item, "title") ?? "", Str(item, "body") ?? "", Long(item, "chatId"), Long(item, "id"));
    }
}

/// <summary>Builders for what the app sends (protocol.ts ClientMessage).</summary>
public static class ClientFrames
{
    // Thai text stays as it is (frames go to a socket, never into HTML): a third of the bytes of \u escapes.
    private static readonly JsonSerializerOptions Compact = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static string Build(string type, Action<JsonObject>? fill = null)
    {
        var json = new JsonObject { ["type"] = type };
        fill?.Invoke(json);
        return json.ToJsonString(Compact);
    }

    public static string Hello(string token, string appVersion) => Build("hello", json =>
    {
        json["role"] = "client";
        json["token"] = token;
        json["name"] = "windows";
        json["client"] = new JsonObject { ["platform"] = "windows", ["version"] = appVersion, ["api"] = ClientApi.Version };
    });

    public static string Simple(string type) => Build(type);

    /// <summary>Any frame: <paramref name="type"/> plus the fields of <paramref name="body"/> (the management screens).</summary>
    public static string Json(string type, JsonObject? body = null) => Build(type, json =>
    {
        if (body is null) return;
        // A field left out and a null mean the same to the core: nulls stay out (nested ones are kept).
        foreach (var (key, value) in body)
        {
            if (value is not null) json[key] = value.DeepClone();
        }
    });

    public static string Presence(long? chatId, bool visible) => Build("presence", json =>
    {
        json["chatId"] = chatId is null ? null : JsonValue.Create(chatId.Value);
        json["visible"] = visible;
    });

    public static string ChatOpen(long chatId, long? sessionId = null, long? beforeId = null, long? afterId = null) => Build("chat-open", json =>
    {
        json["chatId"] = chatId;
        if (sessionId is not null) json["sessionId"] = sessionId;
        if (beforeId is not null) json["beforeId"] = beforeId;
        if (afterId is not null) json["afterId"] = afterId;
    });

    public static string ChatCreateDirect(string agent) => Build("chat-create", json =>
    {
        json["kind"] = "direct";
        json["agents"] = new JsonArray(agent);
    });

    public static string ChatSend(long chatId, string text, IReadOnlyList<string> attachments, string? clientId, long? replyTo = null, ForwardedFrom? forward = null) => Build("chat-send", json =>
    {
        json["chatId"] = chatId;
        json["text"] = text;
        if (attachments.Count > 0) json["attachments"] = new JsonArray(attachments.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray());
        if (clientId is not null) json["clientId"] = clientId;
        if (replyTo is not null) json["replyTo"] = replyTo;
        if (forward is not null) json["forward"] = new JsonObject { ["from"] = forward.From, ["chat"] = forward.Chat };
    });

    public static string MessagePin(long messageId, bool pinned) => Build("message-pin", json =>
    {
        json["messageId"] = messageId;
        json["pinned"] = pinned;
    });

    /// <summary>Adds the emoji to the message, or takes it away when it is there already.</summary>
    public static string MessageReact(long messageId, string emoji) => Build("message-react", json =>
    {
        json["messageId"] = messageId;
        json["emoji"] = emoji;
    });

    public static string Rewind(long sessionId, long messageId) => Build("rewind", json =>
    {
        json["sessionId"] = sessionId;
        json["messageId"] = messageId;
    });

    public static string Search(string query) => Build("search", json => json["query"] = query);

    /// <summary>Marks these notifications read; no ids = all of them.</summary>
    public static string NotificationsRead(IReadOnlyList<long>? ids = null) => Build("notifications-read", json =>
    {
        if (ids is not null) json["ids"] = new JsonArray(ids.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray());
    });

    public static string Abort(long chatId) => Build("abort", json => json["chatId"] = chatId);

    /// <summary><paramref name="scope"/>: once | task | session | always (ignored when denying).</summary>
    public static string PermissionResponse(string requestId, bool allow, string scope = "once") => Build("permission-response", json =>
    {
        json["requestId"] = requestId;
        json["allow"] = allow;
        if (allow) json["scope"] = scope;
    });

    public static string ApprovalDecide(long id, bool approved) => Build("approval-decide", json =>
    {
        json["id"] = id;
        json["approved"] = approved;
    });
}
