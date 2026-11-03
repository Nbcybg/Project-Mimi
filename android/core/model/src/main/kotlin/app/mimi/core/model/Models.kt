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

// ---------- Mimiamp (packages/shared/src/mimiamp.ts) ----------

@Serializable
data class MimiampTrack(
    val id: String,
    val source: String,
    val file: String? = null,
    val videoId: String? = null,
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val duration: Double? = null,
    val url: String = "",
    val thumbnail: String? = null,
)

@Serializable
data class MimiampPlaylistItem(
    val id: String,
    val trackId: String? = null,
    val source: String,
    val file: String? = null,
    val videoId: String? = null,
    val localId: String? = null,
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val duration: Double? = null,
    val thumbnail: String? = null,
    val addedAt: String = "",
)

@Serializable
data class MimiampPlaylist(val id: String, val name: String, val createdAt: String = "", val updatedAt: String = "", val items: List<MimiampPlaylistItem> = emptyList())

@Serializable
data class YoutubeStatus(val ready: Boolean = false, val google: Boolean = false, val error: String? = null)

@Serializable
data class MimiampState(val tracks: List<MimiampTrack> = emptyList(), val playlists: List<MimiampPlaylist> = emptyList(), val youtube: YoutubeStatus = YoutubeStatus())

@Serializable
data class YoutubeSearchResult(val videoId: String, val title: String, val artist: String? = null, val duration: Double? = null, val thumbnail: String? = null)

@Serializable
data class YoutubeSearchReply(val results: List<YoutubeSearchResult> = emptyList(), val source: String = "none", val error: String? = null)

@Serializable
data class TrackReply(val track: MimiampTrack? = null)

@Serializable
data class PlaylistReply(val playlist: MimiampPlaylist)

@Serializable
data class PlaylistsReply(val playlists: List<MimiampPlaylist> = emptyList())

@Serializable
data class OkReply(val ok: Boolean = false)

/** What an agent tells the player (protocol.ts MimiampCommand). */
@Serializable
data class MimiampCommand(val action: String, val query: String? = null, val level: Double? = null, val seconds: Double? = null)

/**
 * The oldest core API this app works with. API 0 cores (before Phase 1) still chat, but lack
 * `chat-turn-messages`, Range on files and push; the app copes (it reopens the chat after a turn).
 */
const val MIN_SUPPORTED_CORE_API = 0
