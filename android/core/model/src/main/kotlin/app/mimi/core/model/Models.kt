package app.mimi.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** The client API this app is built against (docs/native/api-versioning.md). */
const val CLIENT_API = 1

/** Close codes of `/ws` (docs/native/realtime.md 7.4). */
object CloseCodes {
    const val HELLO_TIMEOUT = 4001
    const val INVALID_TOKEN = 4003
    const val RATE_LIMITED = 4029
    const val CLIENT_TOO_OLD = 4426
    const val GATEWAY_CORE_REFUSED = 4502
}

@Serializable
data class Health(
    val ok: Boolean = false,
    val version: String = "",
    /** Absent on a core older than client API 1. */
    val api: Int = 0,
    val minClientApi: Int = 0,
    val accounts: Boolean = false,
)

@Serializable
data class LoginRequest(val username: String, val password: String, val code: String? = null)

@Serializable
data class LoginResponse(val token: String, val username: String = "", val expiresAt: String = "", val webhookBase: String = "")

@Serializable
data class ErrorBody(val error: String = "", val twoFactor: Boolean = false)

@Serializable
data class SpeechStyle(val emotion: String? = null, val tone: String? = null, val voice: String? = null, val speed: Double? = null)

@Serializable
data class AttachmentView(
    val id: String,
    val kind: String,
    val name: String,
    val mime: String,
    val size: Long = 0,
    val text: String = "",
    val caption: String = "",
    val deletedAt: String? = null,
)

@Serializable
data class ToolSummary(val name: String, val summary: String = "")

@Serializable
data class QuotedMessage(val id: Long, val role: String, val agent: String = "", val text: String = "")

@Serializable
data class ApprovalView(val id: Long, val status: String, val workflow: String = "", val expiresAt: String = "", val note: String? = null)

@Serializable
data class ChatMessageView(
    val id: Long,
    val role: String,
    val agent: String = "",
    val text: String = "",
    val speech: SpeechStyle? = null,
    val createdAt: String = "",
    val attachments: List<AttachmentView> = emptyList(),
    val tools: List<ToolSummary> = emptyList(),
    val replyTo: QuotedMessage? = null,
    val clientId: String? = null,
    val approval: ApprovalView? = null,
    val pinned: Boolean = false,
    val reactions: List<String> = emptyList(),
)

@Serializable
data class ChatView(
    val id: Long,
    val kind: String,
    val title: String = "",
    val agents: List<String> = emptyList(),
    val lastMessageAt: String? = null,
    val preview: String = "",
    val unread: Boolean = false,
)

/** A pinned message as the pin bar lists it (protocol.ts PinView). */
@Serializable
data class PinView(
    val id: Long,
    val sessionId: Long = 0,
    val role: String = "",
    val agent: String = "",
    val text: String = "",
    val createdAt: String = "",
)

/** A found message (protocol.ts SearchHit): where it is, who wrote it, and a snippet with the match in `**`. */
@Serializable
data class SearchHit(
    val messageId: Long,
    val chatId: Long,
    val sessionId: Long,
    val chatTitle: String = "",
    val sessionTitle: String = "",
    val role: String = "",
    val agent: String = "",
    val snippet: String = "",
    val createdAt: String = "",
)

/** The size of a session (protocol.ts SessionContextView): the header meter and the context panel. */
@Serializable
data class SessionContextView(
    /** Tokens the model was sent last time, or an estimate of the next prompt. */
    val usedTokens: Long = 0,
    val windowTokens: Long = 0,
    /** Cache share of the input tokens over the session, 0..100; null before any call. */
    val cacheHitPct: Double? = null,
    val costUsd: Double = 0.0,
    val conversationTokens: Long = 0,
    val maxTokens: Long = 0,
)

@Serializable
data class SessionView(
    val id: Long,
    val chatId: Long,
    val title: String = "",
    val summary: String = "",
    val auto: Boolean = true,
    val createdAt: String = "",
    val lastMessageAt: String = "",
    val readAt: String? = null,
    val unread: Boolean = false,
)

@Serializable
data class PermissionRequest(
    val id: String,
    val traceId: String = "",
    val agent: String = "",
    val tool: String,
    val risk: String = "",
    val input: JsonElement = JsonNull,
    val summary: String = "",
    val timeoutMs: Long = 0,
    val noGrant: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class LiveTool(val id: String, val name: String, val arg: String = "", val risk: String? = null, val ok: Boolean? = null, val output: String = "")

@Serializable
data class LiveTurnView(
    val sessionId: Long,
    val agent: String,
    val model: String = "",
    val text: String = "",
    val speech: SpeechStyle? = null,
    val tools: List<LiveTool> = emptyList(),
    val attachments: List<AttachmentView> = emptyList(),
    val pendingPermissions: List<PermissionRequest> = emptyList(),
)

@Serializable
data class AgentSummary(val name: String, val displayName: String? = null, val description: String = "")

/** The fields of an agent the chat screens use (the editor's are many more). */
@Serializable
data class AgentView(
    val name: String,
    val displayName: String? = null,
    val description: String = "",
    val avatar: String? = null,
    val portrait: String? = null,
    /** Expression pictures by emoji key (see [lastEmojiKey]), each with a version stamp. */
    val sprites: Map<String, String> = emptyMap(),
    /** "sprite" (a picture) or "vrm" (a 3D model: this app shows its 2D picture). */
    val character: String? = null,
) {
    val shownName: String get() = displayName?.takeIf { it.isNotBlank() } ?: name
}

@Serializable
data class NotificationSyncItem(
    val id: Long,
    val kind: String,
    val title: String = "",
    val body: String = "",
    val chatId: Long? = null,
    val createdAt: String = "",
    val read: Boolean = false,
)

@Serializable
data class WidgetChat(
    val id: Long,
    val title: String = "",
    val agent: String = "",
    val avatar: String? = null,
    val preview: String = "",
    val lastMessageAt: String? = null,
    val unread: Int = 0,
)

@Serializable
data class WidgetView(val chats: List<WidgetChat> = emptyList(), val busyChat: Long? = null)

@Serializable
data class NativePushRegistration(
    val platform: String,
    val token: String,
    val label: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class PushRegistered(val ok: Boolean = false, val delivering: Boolean = false)

@Serializable
data class OkReply(val ok: Boolean = false)

/**
 * The oldest core API this app works with. API 0 cores (before Phase 1) still chat, but lack
 * `chat-turn-messages`, Range on files and push; the app copes (it reopens the chat after a turn).
 */
const val MIN_SUPPORTED_CORE_API = 0
