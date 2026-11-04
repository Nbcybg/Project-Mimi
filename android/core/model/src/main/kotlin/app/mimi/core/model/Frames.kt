package app.mimi.core.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** One JSON parser for the whole app: newer cores add fields, so unknown ones are skipped. */
val MimiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = true
}

/** What a tool, a sub-agent or the model did during a turn (packages/shared/src/events.ts). */
sealed interface AgentEvent {
    data class RunStart(val agent: String, val model: String) : AgentEvent
    data class TextDelta(val text: String) : AgentEvent
    data class ToolCall(val id: String, val name: String, val input: JsonElement?, val risk: String?) : AgentEvent
    data class ToolResult(val callId: String, val ok: Boolean, val output: String) : AgentEvent
    data class Attachment(val attachment: AttachmentView) : AgentEvent
    data class Permission(val request: PermissionRequest) : AgentEvent
    data class PermissionDecision(val requestId: String) : AgentEvent
    data class Activity(val agent: String, val event: AgentEvent) : AgentEvent
    data class RunFinish(
        val reason: String,
        val text: String,
        val speech: SpeechStyle?,
        val error: String?,
        val errorCode: String?,
        val handoffTo: String?,
    ) : AgentEvent
    /** A task card event (task-start / -update / -step / -plan / -receipt / -finish), kept as JSON. */
    data class Task(val type: String, val json: JsonObject) : AgentEvent
    /** Usage and anything newer: not shown by this version of the app. */
    data class Other(val type: String) : AgentEvent
}

/** Frames the core sends (protocol.ts ServerMessage); only the ones this app uses are typed. */
sealed interface ServerFrame {
    data class Welcome(
        val agents: List<AgentSummary>,
        val defaultAgent: String,
        val busyChats: List<Long>,
        val pendingPermissions: List<PermissionRequest>,
        val version: String?,
        val api: Int,
        val minClientApi: Int,
        /** The screen settings the account's devices share (`ui-set`), every key with its string. */
        val ui: Map<String, String> = emptyMap(),
    ) : ServerFrame
    /** Another device changed shared settings: a null value means the key was removed. */
    data class Ui(val values: Map<String, String?>) : ServerFrame
    data object Pong : ServerFrame
    data class Chats(val chats: List<ChatView>) : ServerFrame
    data class Agents(val agents: List<AgentView>, val defaultAgent: String?) : ServerFrame
    data class ChatHistory(
        val chat: ChatView,
        val session: SessionView?,
        val sessions: List<SessionView>,
        val messages: List<ChatMessageView>,
        val hasMore: Boolean,
        val beforeId: Long?,
        val afterId: Long?,
        val live: LiveTurnView?,
        val pins: List<PinView>? = null,
    ) : ServerFrame
    data class ChatSession(val chatId: Long, val session: SessionView, val started: Boolean) : ServerFrame
    data class ChatMessage(val chatId: Long, val sessionId: Long, val message: ChatMessageView) : ServerFrame
    data class ChatEvent(val chatId: Long, val sessionId: Long, val agent: String, val event: AgentEvent) : ServerFrame
    data class ChatTurnMessages(val chatId: Long, val sessionId: Long, val afterId: Long, val messages: List<ChatMessageView>) : ServerFrame
    /** A pin or a reaction changed on one message (and the chat's pin list with it). */
    data class MessageMarks(
        val chatId: Long,
        val sessionId: Long,
        val messageId: Long,
        val pinned: Boolean,
        val reactions: List<String>,
        val pins: List<PinView>,
    ) : ServerFrame
    /** The answer to `rewind`: the text of the message taken back (to edit and resend), and what happened to the files. */
    data class Rewound(val chatId: Long, val sessionId: Long, val text: String, val restored: List<String>, val skipped: List<String>) : ServerFrame
    data class SearchResults(val query: String, val hits: List<SearchHit>) : ServerFrame
    data class SessionContext(val chatId: Long, val sessionId: Long, val context: SessionContextView) : ServerFrame
    data class Busy(val chatId: Long?, val done: Boolean) : ServerFrame
    data class Transcribing(val chatId: Long, val on: Boolean) : ServerFrame
    data class Viewing(val chatId: Long, val on: Boolean) : ServerFrame
    data class ChatChanged(val chatId: Long, val sessionId: Long) : ServerFrame
    data class PermissionResolved(val requestId: String) : ServerFrame
    data class Notification(val kind: String, val title: String, val body: String, val chatId: Long?, val id: Long?) : ServerFrame
    /** An event of background work outside any chat (it may ask for permission). */
    data class Background(val event: AgentEvent) : ServerFrame
    data class Error(val message: String, val code: String?, val chatId: Long?, val clientId: String?, val requestType: String?) : ServerFrame
    data class SecurityAlert(val at: String) : ServerFrame
    data class Unknown(val type: String) : ServerFrame
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
/** The string values of an object (anything else becomes null): the shared `ui` settings. */
private fun JsonObject?.strings(): Map<String, String?> =
    this?.mapValues { (_, value) -> (value as? JsonPrimitive)?.takeIf { it.isString }?.content } ?: emptyMap()

private fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false
private inline fun <reified T> JsonObject.decode(key: String): T? = this[key]?.let { runCatching { MimiJson.decodeFromJsonElement<T>(it) }.getOrNull() }

fun parseAgentEvent(json: JsonObject): AgentEvent = when (val type = json.str("type")) {
    "run-start" -> AgentEvent.RunStart(json.str("agent").orEmpty(), json.str("model").orEmpty())
    "text-delta" -> AgentEvent.TextDelta(json.str("text").orEmpty())
    "tool-call" -> {
        val call = json["call"]?.jsonObject
        AgentEvent.ToolCall(call?.str("id").orEmpty(), call?.str("name").orEmpty(), call?.get("input"), json.str("risk"))
    }
    "tool-result" -> {
        val result = json["result"]?.jsonObject
        AgentEvent.ToolResult(result?.str("callId").orEmpty(), result?.bool("ok") ?: false, result?.str("output").orEmpty())
    }
    "attachment" -> json.decode<AttachmentView>("attachment")?.let { AgentEvent.Attachment(it) } ?: AgentEvent.Other("attachment")
    "permission-request" -> json.decode<PermissionRequest>("request")?.let { AgentEvent.Permission(it) } ?: AgentEvent.Other("permission-request")
    "permission-decision" -> AgentEvent.PermissionDecision(json.str("requestId").orEmpty())
    "agent-activity" -> AgentEvent.Activity(json.str("agent").orEmpty(), json["event"]?.jsonObject?.let(::parseAgentEvent) ?: AgentEvent.Other("?"))
    "run-finish" -> AgentEvent.RunFinish(
        reason = json.str("reason").orEmpty(),
        text = json.str("text").orEmpty(),
        speech = json.decode<SpeechStyle>("speech"),
        error = json.str("error"),
        errorCode = json.str("errorCode"),
        handoffTo = (json["handoff"] as? JsonObject)?.str("to"),
    )
    "task-start", "task-update", "task-step", "task-plan", "task-receipt", "task-finish" -> AgentEvent.Task(type, json)
    else -> AgentEvent.Other(type.orEmpty())
}

/** Parses one text frame of `/ws`; never throws (a broken frame is Unknown). */
fun parseServerFrame(text: String): ServerFrame {
    val json = runCatching { MimiJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return ServerFrame.Unknown("")
    return runCatching { parseKnown(json) }.getOrElse { ServerFrame.Unknown(json.str("type").orEmpty()) }
}

private fun parseKnown(json: JsonObject): ServerFrame = when (val type = json.str("type")) {
    "welcome" -> ServerFrame.Welcome(
        agents = json.decode<List<AgentSummary>>("agents").orEmpty(),
        defaultAgent = json.str("defaultAgent").orEmpty(),
        busyChats = json.decode<List<Long>>("busyChats").orEmpty(),
        pendingPermissions = json.decode<List<PermissionRequest>>("pendingPermissions").orEmpty(),
        version = json.str("version"),
        api = json.long("api")?.toInt() ?: 0,
        minClientApi = json.long("minClientApi")?.toInt() ?: 0,
        ui = (json["ui"] as? JsonObject).strings().filterValues { it != null }.mapValues { it.value!! },
    )
    "ui" -> ServerFrame.Ui((json["values"] as? JsonObject).strings())
    "pong" -> ServerFrame.Pong
    "chats" -> ServerFrame.Chats(json.decode<List<ChatView>>("chats").orEmpty())
    "agents" -> ServerFrame.Agents(json.decode<List<AgentView>>("agents").orEmpty(), json.str("defaultAgent"))
    "chat-history" -> ServerFrame.ChatHistory(
        chat = json.decode<ChatView>("chat")!!,
        session = json.decode<SessionView>("session"),
        sessions = json.decode<List<SessionView>>("sessions").orEmpty(),
        messages = json.decode<List<ChatMessageView>>("messages").orEmpty(),
        hasMore = json.bool("hasMore"),
        beforeId = json.long("beforeId"),
        afterId = json.long("afterId"),
        live = json.decode<LiveTurnView>("live"),
        pins = json.decode<List<PinView>>("pins"),
    )
    "chat-session" -> ServerFrame.ChatSession(json.long("chatId")!!, json.decode<SessionView>("session")!!, json.bool("started"))
    "chat-message" -> ServerFrame.ChatMessage(json.long("chatId")!!, json.long("sessionId") ?: 0, json.decode<ChatMessageView>("message")!!)
    "chat-event" -> ServerFrame.ChatEvent(
        json.long("chatId")!!,
        json.long("sessionId") ?: 0,
        json.str("agent").orEmpty(),
        parseAgentEvent(json["event"]!!.jsonObject),
    )
    "chat-turn-messages" -> ServerFrame.ChatTurnMessages(
        json.long("chatId")!!,
        json.long("sessionId") ?: 0,
        json.long("afterId") ?: 0,
        json.decode<List<ChatMessageView>>("messages").orEmpty(),
    )
    "message-marks" -> ServerFrame.MessageMarks(
        json.long("chatId")!!,
        json.long("sessionId") ?: 0,
        json.long("messageId")!!,
        json.bool("pinned"),
        json.decode<List<String>>("reactions").orEmpty(),
        json.decode<List<PinView>>("pins").orEmpty(),
    )
    "rewound" -> ServerFrame.Rewound(
        json.long("chatId")!!,
        json.long("sessionId") ?: 0,
        json.str("text").orEmpty(),
        json.decode<List<String>>("restored").orEmpty(),
        json.decode<List<String>>("skipped").orEmpty(),
    )
    "search-results" -> ServerFrame.SearchResults(json.str("query").orEmpty(), json.decode<List<SearchHit>>("hits").orEmpty())
    "session-context" -> ServerFrame.SessionContext(
        json.long("chatId")!!,
        json.long("sessionId") ?: 0,
        json.decode<SessionContextView>("context")!!,
    )
    "busy" -> ServerFrame.Busy(json.long("chatId"), json.bool("done"))
    "chat-transcribing" -> ServerFrame.Transcribing(json.long("chatId")!!, json.bool("on"))
    "chat-viewing" -> ServerFrame.Viewing(json.long("chatId")!!, json.bool("on"))
    "chat-changed" -> ServerFrame.ChatChanged(json.long("chatId")!!, json.long("sessionId") ?: 0)
    "permission-resolved" -> ServerFrame.PermissionResolved(json.str("requestId").orEmpty())
    "notification" -> {
        val item = json["notification"]!!.jsonObject
        ServerFrame.Notification(item.str("kind").orEmpty(), item.str("title").orEmpty(), item.str("body").orEmpty(), item.long("chatId"), item.long("id"))
    }
    "event" -> ServerFrame.Background(parseAgentEvent(json["event"]!!.jsonObject))
    "error" -> ServerFrame.Error(json.str("message").orEmpty(), json.str("code"), json.long("chatId"), json.str("clientId"), json.str("requestType"))
    "security-alert" -> ServerFrame.SecurityAlert(json.str("at").orEmpty())
    else -> ServerFrame.Unknown(type.orEmpty())
}

/** Builders for what the app sends (protocol.ts ClientMessage). */
object ClientFrames {
    fun hello(token: String, appVersion: String): String = buildJsonObject {
        put("type", "hello")
        put("role", "client")
        put("token", token)
        put("name", "android")
        put("client", buildJsonObject {
            put("platform", "android")
            put("version", appVersion)
            put("api", CLIENT_API)
        })
    }.toString()

    fun simple(type: String): String = buildJsonObject { put("type", type) }.toString()

    fun presence(chatId: Long?, visible: Boolean): String = buildJsonObject {
        put("type", "presence")
        if (chatId == null) put("chatId", null as String?) else put("chatId", chatId)
        put("visible", visible)
    }.toString()

    fun chatOpen(chatId: Long, sessionId: Long? = null, beforeId: Long? = null, afterId: Long? = null): String = buildJsonObject {
        put("type", "chat-open")
        put("chatId", chatId)
        sessionId?.let { put("sessionId", it) }
        beforeId?.let { put("beforeId", it) }
        afterId?.let { put("afterId", it) }
    }.toString()

    fun chatCreateDirect(agent: String): String = buildJsonObject {
        put("type", "chat-create")
        put("kind", "direct")
        put("agents", buildJsonArray { add(JsonPrimitive(agent)) })
    }.toString()

    fun chatSend(chatId: Long, text: String, attachments: List<String>, clientId: String, replyTo: Long? = null): String = buildJsonObject {
        put("type", "chat-send")
        put("chatId", chatId)
        put("text", text)
        if (attachments.isNotEmpty()) put("attachments", buildJsonArray { attachments.forEach { add(JsonPrimitive(it)) } })
        put("clientId", clientId)
        replyTo?.let { put("replyTo", it) }
    }.toString()

    /** Takes back a message of the session and everything after it. */
    fun rewind(sessionId: Long, messageId: Long): String = buildJsonObject {
        put("type", "rewind")
        put("sessionId", sessionId)
        put("messageId", messageId)
    }.toString()

    /** Shares screen settings with the account's other devices; a null value removes the key. */
    fun uiSet(values: Map<String, String?>): String = buildJsonObject {
        put("type", "ui-set")
        put("values", buildJsonObject { values.forEach { (key, value) -> put(key, value) } })
    }.toString()

    fun search(query: String): String = buildJsonObject {
        put("type", "search")
        put("query", query)
    }.toString()

    fun sessionNew(chatId: Long): String = buildJsonObject {
        put("type", "session-new")
        put("chatId", chatId)
    }.toString()

    fun sessionContext(chatId: Long, sessionId: Long? = null): String = buildJsonObject {
        put("type", "session-context")
        put("chatId", chatId)
        sessionId?.let { put("sessionId", it) }
    }.toString()

    fun messagePin(messageId: Long, pinned: Boolean): String = buildJsonObject {
        put("type", "message-pin")
        put("messageId", messageId)
        put("pinned", pinned)
    }.toString()

    /** Adds the emoji to the message, or takes it away when it is there already. */
    fun messageReact(messageId: Long, emoji: String): String = buildJsonObject {
        put("type", "message-react")
        put("messageId", messageId)
        put("emoji", emoji)
    }.toString()

    /** `action`: pause | resume | cancel. */
    fun taskControl(taskId: String, action: String): String = buildJsonObject {
        put("type", "task-control")
        put("taskId", taskId)
        put("action", action)
    }.toString()

    fun taskUndo(taskId: String): String = buildJsonObject {
        put("type", "task-undo")
        put("taskId", taskId)
    }.toString()

    fun abort(chatId: Long): String = buildJsonObject {
        put("type", "abort")
        put("chatId", chatId)
    }.toString()

    /** `scope`: once | task | session | always (ignored when denying). */
    fun permissionResponse(requestId: String, allow: Boolean, scope: String = "once"): String = buildJsonObject {
        put("type", "permission-response")
        put("requestId", requestId)
        put("allow", allow)
        if (allow) put("scope", scope)
    }.toString()

    fun approvalDecide(id: Long, approved: Boolean): String = buildJsonObject {
        put("type", "approval-decide")
        put("id", id)
        put("approved", approved)
    }.toString()
}
