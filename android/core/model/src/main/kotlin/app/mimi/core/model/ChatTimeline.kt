package app.mimi.core.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * What one open chat looks like, folded from the frames of `/ws` (docs/native/realtime.md 4).
 * Pure data and a pure reducer, so the streaming rules are tested on the JVM.
 */
data class ChatTimeline(
    val chatId: Long,
    val chat: ChatView? = null,
    val session: SessionView? = null,
    val messages: List<ChatMessageView> = emptyList(),
    val hasMore: Boolean = false,
    val loaded: Boolean = false,
    /** Sent by this device, not yet echoed by the core. */
    val pending: List<PendingMessage> = emptyList(),
    /** The answer streaming in now. */
    val live: LiveBubble? = null,
    /** Answers of this turn that finished before a handoff, until the turn's messages arrive. */
    val earlier: List<LiveBubble> = emptyList(),
    val permissions: List<PermissionRequest> = emptyList(),
    val busy: Boolean = false,
    val transcribing: Boolean = false,
    val viewing: Boolean = false,
    /** Lines under the conversation: errors, "stopped", handoffs. */
    val notes: List<Note> = emptyList(),
    /** The chat's pinned messages, from every session (the pin bar). */
    val pins: List<PinView> = emptyList(),
    /** Tasks started in this chat while it was open (task cards). */
    val tasks: List<TaskCard> = emptyList(),
    /** Every session of the chat, newest first. */
    val sessions: List<SessionView> = emptyList(),
    /** False while an older session is on screen: new turns land in the newest one. */
    val latest: Boolean = true,
    /** The size of the session on screen (null until asked). */
    val context: SessionContextView? = null,
    /** The session [context] belongs to. */
    val contextSession: Long = 0,
) {
    val lastMessageId: Long? get() = messages.lastOrNull()?.id
}

/** A task as its card shows it: the TaskView JSON, kept up to date by the `task-*` events. */
data class TaskCard(val id: String, val task: JsonObject) {
    val status: String get() = (task["status"] as? JsonPrimitive)?.contentOrNull.orEmpty()
}

data class PendingMessage(val clientId: String, val text: String, val attachmentNames: List<String>, val failed: String? = null)

data class Note(val text: String, val bad: Boolean)

data class LiveBubble(
    val agent: String,
    val segments: List<LiveSegment> = emptyList(),
    val speech: SpeechStyle? = null,
    /** A sub-agent working for this one, shown as a small line. */
    val helper: String? = null,
    val finished: Boolean = false,
)

sealed interface LiveSegment {
    data class Text(val raw: String) : LiveSegment {
        /** The text without a direction line that is still arriving. */
        val shown: String get() = parseSpeech(raw, live = true).text
    }
    data class Tool(val id: String, val name: String, val arg: String, val risk: String?, val ok: Boolean? = null, val output: String = "") : LiveSegment
    data class File(val attachment: AttachmentView) : LiveSegment
}

private fun preview(input: Any?): String {
    val text = input?.toString().orEmpty().replace(Regex("\\s+"), " ").trim()
    return if (text.length > 160) text.take(160) + "…" else text
}

private fun List<ChatMessageView>.mergeById(more: List<ChatMessageView>): List<ChatMessageView> {
    val byId = LinkedHashMap<Long, ChatMessageView>()
    for (message in this) byId[message.id] = message
    for (message in more) byId[message.id] = message
    return byId.values.sortedBy { it.id }
}

fun LiveTurnView.toBubble(): LiveBubble {
    val segments = buildList<LiveSegment> {
        tools.forEach { add(LiveSegment.Tool(it.id, it.name, it.arg, it.risk, it.ok, it.output)) }
        attachments.forEach { add(LiveSegment.File(it)) }
        if (text.isNotEmpty()) add(LiveSegment.Text(text))
    }
    return LiveBubble(agent, segments, speech)
}

/** True when the frame belongs to this chat's session on screen (an older session's events are ignored). */
private fun ChatTimeline.showing(chatId: Long, sessionId: Long): Boolean =
    chatId == this.chatId && (session == null || sessionId == 0L || session.id == sessionId)

fun ChatTimeline.addPending(message: PendingMessage): ChatTimeline = copy(pending = pending + message)

fun ChatTimeline.reduce(frame: ServerFrame): ChatTimeline = when (frame) {
    is ServerFrame.ChatHistory -> if (frame.chat.id != chatId) this else when {
        frame.beforeId != null -> copy(messages = frame.messages.mergeById(messages), hasMore = frame.hasMore)
        frame.afterId != null && frame.session?.id == session?.id ->
            copy(chat = frame.chat, messages = messages.mergeById(frame.messages), loaded = true, pins = frame.pins ?: pins)
        else -> copy(
            chat = frame.chat,
            session = frame.session,
            messages = frame.messages,
            hasMore = frame.hasMore,
            loaded = true,
            pins = frame.pins ?: pins,
            latest = frame.session == null || frame.sessions.isEmpty() || frame.sessions[0].id == frame.session.id,
            sessions = frame.sessions.ifEmpty { sessions },
            context = context?.takeIf { frame.session != null && contextSession == frame.session.id },
            live = frame.live?.toBubble() ?: live?.takeIf { busy && !it.finished },
            permissions = frame.live?.pendingPermissions ?: permissions,
            // What was sent but never echoed is gone once the log says so.
            pending = pending.filter { sent -> frame.messages.none { it.role == "user" && it.text == sent.text } },
        )
    }
    is ServerFrame.ChatSession -> when {
        frame.chatId != chatId -> this
        // An older session on screen stays there; the turn is in the newest one.
        !latest && session != null && frame.session.id != session.id -> this
        session != null && frame.session.id != session.id && frame.started -> copy(
            session = frame.session,
            messages = emptyList(),
            live = null,
            notes = emptyList(),
            sessions = listOf(frame.session) + sessions.filter { it.id != frame.session.id },
            latest = true,
            context = null,
        )
        else -> copy(session = frame.session)
    }
    is ServerFrame.SessionContext -> if (frame.chatId == chatId && (session == null || frame.sessionId == session.id)) {
        copy(context = frame.context, contextSession = frame.sessionId)
    } else this
    is ServerFrame.ChatMessage -> if (frame.chatId != chatId) this else {
        val rest = pending.filterNot { frame.message.clientId != null && it.clientId == frame.message.clientId }
        if (!showing(frame.chatId, frame.sessionId)) copy(pending = rest)
        else copy(pending = rest, messages = messages.mergeById(listOf(frame.message)))
    }
    is ServerFrame.ChatEvent -> if (!showing(frame.chatId, frame.sessionId)) this else applyEvent(frame.agent, frame.event)
    is ServerFrame.ChatTurnMessages -> if (frame.chatId != chatId) this
        else copy(messages = messages.mergeById(frame.messages), live = null, earlier = emptyList())
    is ServerFrame.Busy -> when {
        frame.chatId == null -> copy(busy = false, transcribing = false, viewing = false)
        frame.chatId != chatId -> this
        frame.done -> copy(busy = false, transcribing = false, viewing = false, live = live?.takeIf { it.finished })
        else -> copy(busy = true)
    }
    is ServerFrame.MessageMarks -> if (frame.chatId != chatId) this else copy(
        pins = frame.pins,
        messages = messages.map { if (it.id == frame.messageId) it.copy(pinned = frame.pinned, reactions = frame.reactions) else it },
    )
    is ServerFrame.Transcribing -> if (frame.chatId == chatId) copy(transcribing = frame.on) else this
    is ServerFrame.Viewing -> if (frame.chatId == chatId) copy(viewing = frame.on) else this
    is ServerFrame.PermissionResolved -> copy(permissions = permissions.filterNot { it.id == frame.requestId })
    is ServerFrame.Error -> when {
        frame.clientId != null && pending.any { it.clientId == frame.clientId } ->
            copy(pending = pending.map { if (it.clientId == frame.clientId) it.copy(failed = frame.message) else it })
        frame.chatId == chatId -> copy(notes = notes + Note("[${frame.code ?: "E-INTERNAL"}] ${frame.message}", bad = true))
        else -> this
    }
    is ServerFrame.Welcome -> copy(permissions = (permissions + frame.pendingPermissions).distinctBy { it.id }, busy = chatId in frame.busyChats)
    else -> this
}

private fun ChatTimeline.applyEvent(agent: String, event: AgentEvent): ChatTimeline = when (event) {
    is AgentEvent.RunStart -> copy(
        earlier = live?.takeIf { it.finished }?.let { earlier + it } ?: earlier,
        live = LiveBubble(event.agent.ifEmpty { agent }),
        busy = true,
    )
    is AgentEvent.TextDelta -> {
        val bubble = live ?: LiveBubble(agent)
        val last = bubble.segments.lastOrNull()
        val segments = if (last is LiveSegment.Text) bubble.segments.dropLast(1) + LiveSegment.Text(last.raw + event.text)
            else bubble.segments + LiveSegment.Text(event.text)
        copy(live = bubble.copy(segments = segments))
    }
    is AgentEvent.ToolCall -> {
        val bubble = live ?: LiveBubble(agent)
        copy(live = bubble.copy(segments = bubble.segments + LiveSegment.Tool(event.id, event.name, preview(event.input), event.risk)))
    }
    is AgentEvent.ToolResult -> live?.let { bubble ->
        copy(live = bubble.copy(segments = bubble.segments.map {
            if (it is LiveSegment.Tool && it.id == event.callId) it.copy(ok = event.ok, output = event.output.take(4000)) else it
        }))
    } ?: this
    is AgentEvent.Attachment -> {
        val bubble = live ?: LiveBubble(agent)
        copy(live = bubble.copy(segments = bubble.segments + LiveSegment.File(event.attachment)))
    }
    is AgentEvent.Task -> copy(tasks = onTask(event))
    is AgentEvent.Permission -> copy(permissions = (permissions + event.request).distinctBy { it.id })
    is AgentEvent.PermissionDecision -> copy(permissions = permissions.filterNot { it.id == event.requestId })
    is AgentEvent.Activity -> {
        val inner = event.event
        val withHelper = live?.let { copy(live = it.copy(helper = event.agent)) } ?: this
        // A sub-agent's permission question is the user's to answer too.
        when (inner) {
            is AgentEvent.Permission -> withHelper.copy(permissions = (permissions + inner.request).distinctBy { it.id })
            is AgentEvent.PermissionDecision -> withHelper.copy(permissions = permissions.filterNot { it.id == inner.requestId })
            else -> withHelper
        }
    }
    is AgentEvent.RunFinish -> {
        val bubble = live ?: LiveBubble(agent)
        // The final text replaces what streamed in (it lacks the direction line for sure).
        val segments = if (event.text.isNotEmpty()) {
            val lastText = bubble.segments.indexOfLast { it is LiveSegment.Text }
            if (lastText >= 0) bubble.segments.toMutableList().also { it[lastText] = LiveSegment.Text(event.text) } else bubble.segments + LiveSegment.Text(event.text)
        } else bubble.segments
        val note = when {
            event.reason == "error" -> Note("ผิดพลาด [${event.errorCode ?: "E-INTERNAL"}]: ${event.error.orEmpty()}", bad = true)
            event.reason == "handoff" && event.handoffTo != null -> Note("↪ ส่งต่อให้ ${event.handoffTo}", bad = false)
            event.reason !in setOf("stop", "handoff") -> Note("หยุด: ${event.reason}", bad = true)
            else -> null
        }
        copy(live = bubble.copy(segments = segments, speech = event.speech ?: bubble.speech, finished = true), notes = note?.let { notes + it } ?: notes)
    }
    is AgentEvent.Other -> this
}

/** task-start / -update carry the whole task; the others patch a part of the card. */
private fun ChatTimeline.onTask(event: AgentEvent.Task): List<TaskCard> {
    val json = event.json
    val whole = json["task"] as? JsonObject
    val wholeId = (whole?.get("id") as? JsonPrimitive)?.contentOrNull
    if (whole != null && wholeId != null) {
        val card = TaskCard(wholeId, whole)
        return if (tasks.any { it.id == wholeId }) tasks.map { if (it.id == wholeId) card else it } else tasks + card
    }
    val key = (json["taskId"] as? JsonPrimitive)?.contentOrNull ?: return tasks
    val known = tasks.firstOrNull { it.id == key } ?: return tasks
    val node = known.task.toMutableMap()
    when (event.type) {
        "task-step" -> {
            val step = json["step"] as? JsonObject ?: return tasks
            val steps = ((node["steps"] as? JsonArray)?.toMutableList()) ?: mutableListOf()
            val at = steps.indexOfFirst { (it as? JsonObject)?.get("id") == step["id"] }
            if (at >= 0) steps[at] = step else steps.add(step)
            node["steps"] = JsonArray(steps)
        }
        "task-plan" -> json["plan"]?.let { node["plan"] = it }
        "task-receipt" -> json["receipt"]?.let {
            node[if ((json["undo"] as? JsonPrimitive)?.booleanOrNull == true) "undoReceipt" else "receipt"] = it
        }
        "task-finish" -> {
            json["status"]?.let { node["status"] = it }
            json["receipt"]?.let { node["receipt"] = it }
        }
    }
    return tasks.map { if (it.id == key) TaskCard(key, JsonObject(node)) else it }
}
