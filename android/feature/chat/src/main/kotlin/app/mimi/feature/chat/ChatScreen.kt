package app.mimi.feature.chat

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import app.mimi.core.model.ChatTimeline
import app.mimi.core.model.SessionContextView
import app.mimi.core.model.SessionView
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.rememberModalBottomSheetState
import app.mimi.core.data.ChatBackground
import app.mimi.core.data.ChatLook
import app.mimi.core.ui.LocalMessageFontSize
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Slider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material.icons.filled.Settings
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.material3.LocalContentColor
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import app.mimi.core.model.AgentView
import app.mimi.core.model.TaskCard
import app.mimi.core.model.QuotedMessage
import app.mimi.core.model.PinView
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mimi.core.model.AttachmentView
import app.mimi.core.model.ChatMessageView
import app.mimi.core.model.LiveBubble
import app.mimi.core.model.LiveSegment
import app.mimi.core.model.PermissionRequest
import app.mimi.core.model.SpeechStyle
import app.mimi.core.model.parseSpeech
import app.mimi.core.ui.MessageText
import app.mimi.core.ui.MimiColors
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A direct chat uses the web's character-chat look (app.css .solo): round bubbles, glass buttons, the time under the bubble. */
private val LocalSolo = compositionLocalOf { false }

/** What a long press on a message offers (feature-inventory #12). */
private class MessageActions(
    val react: (ChatMessageView, String) -> Unit,
    val reply: (ChatMessageView) -> Unit,
    val pin: (ChatMessageView) -> Unit,
    val copy: (String) -> Unit,
    val rewind: (ChatMessageView) -> Unit,
)

private val QUICK_REACTIONS = listOf("❤️", "👍", "😂", "😮", "😢", "🙏")

private val IMAGE = Regex("^image/(png|jpeg|webp|gif)$")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatRoute(onBack: () -> Unit, viewModel: ChatViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val timeline = state.timeline
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var text by rememberSaveable { mutableStateOf("") }
    var viewing by remember { mutableStateOf<AttachmentView?>(null) }
    var confirmRewind by remember { mutableStateOf<ChatMessageView?>(null) }

    // The core does not notify about the chat the user is reading (realtime.md 7.2).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> viewModel.onScreen(true)
                Lifecycle.Event.ON_PAUSE -> viewModel.onScreen(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(state.toast) {
        state.toast?.let { snackbar.showSnackbar(it); viewModel.consumeToast() }
    }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) viewModel.stage(uris) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.startRecording() else scope.launch { snackbar.showSnackbar("ยังไม่ได้อนุญาตไมค์") }
    }
    val open: (AttachmentView) -> Unit = { attachment ->
        if (IMAGE.matches(attachment.mime) && attachment.deletedAt == null) viewing = attachment
        else scope.launch {
            viewModel.download(attachment).onSuccess { openFile(context, it, attachment.mime) }
                .onFailure { snackbar.showSnackbar(it.message ?: "เปิดไฟล์ไม่ได้") }
        }
    }

    val clipboard = LocalClipboardManager.current
    val actions = remember(viewModel) {
        MessageActions(
            react = viewModel::react,
            reply = viewModel::reply,
            pin = viewModel::pin,
            copy = { clipboard.setText(AnnotatedString(it)) },
            rewind = { message ->
                val problem = viewModel.rewindProblem(message)
                if (problem != null) scope.launch { snackbar.showSnackbar(problem) } else confirmRewind = message
            },
        )
    }
    // A message taken back returns to the composer to edit and send again (app.js 'rewound').
    LaunchedEffect(viewModel) {
        viewModel.rewound.collect { frame ->
            text = frame.text
            viewModel.reply(null)
            val note = buildList {
                if (frame.restored.isNotEmpty()) add("ย้อนไฟล์กลับ ${frame.restored.size} ไฟล์: ${frame.restored.joinToString(", ")}")
                if (frame.skipped.isNotEmpty()) add("บางไฟล์ย้อนไม่ได้: ${frame.skipped.joinToString(", ")}")
            }.joinToString("\n")
            if (note.isNotEmpty()) snackbar.showSnackbar(note)
        }
    }
    val solo = timeline.chat?.kind == "direct"
    val look = state.look
    var settings by remember { mutableStateOf(false) }
    // The character stands behind the chat only in a direct chat that has a picture (web .solo + figure).
    val stage = solo && look.character && state.figure != null
    val fontSize = when (look.textSize) { 0 -> 12.5.sp; 2 -> 17.sp; else -> 14.sp }
    val statusText = when {
        timeline.transcribing -> "กำลังถอดเสียง…"
        timeline.viewing -> "กำลังดูรูป…"
        timeline.busy -> "${state.title.ifBlank { "agent" }} กำลังตอบ…"
        else -> connectionLabel(state.connection)
    }
    CompositionLocalProvider(LocalSolo provides solo, LocalMessageFontSize provides fontSize) {
    Scaffold(
        topBar = {
            if (!solo) TopAppBar(
                title = {
                    Column {
                        Text(state.title, maxLines = 1, fontWeight = FontWeight.SemiBold)
                        val status = when {
                            timeline.transcribing -> "กำลังถอดเสียง…"
                            timeline.viewing -> "AI กำลังดูรูป…"
                            timeline.busy -> "กำลังตอบ…"
                            else -> connectionLabel(state.connection)
                        }
                        status?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MimiColors.accentText) }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "กลับ") } },
                actions = { IconButton(onClick = { settings = true }) { Icon(Icons.Default.Settings, contentDescription = "ตั้งค่าแชต") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        // The character screen runs under the status bar (its own bar adds the inset); the others sit below the app bar.
        Box(Modifier.padding(if (solo) PaddingValues(bottom = padding.calculateBottomPadding()) else padding).fillMaxSize()) {
        StageLayers(background = look.background, backgroundUrl = viewModel::backgroundUrl, figure = if (stage) state.figure else null, look = look)
        Column(Modifier.fillMaxSize().imePadding().then(if (solo) Modifier.statusBarsPadding().padding(top = 60.dp) else Modifier)) {
            val list = rememberLazyListState()
            // Opened from a search hit: stay on that message instead of scrolling to the newest.
            var jumped by remember { mutableStateOf(viewModel.jumpTo == null) }
            val count = timeline.messages.size + timeline.pending.size + (if (timeline.live != null) 1 else 0) + timeline.earlier.size + timeline.permissions.size + timeline.notes.size
            val liveLength = timeline.live?.segments?.sumOf { if (it is LiveSegment.Text) it.raw.length else 1 } ?: 0
            LaunchedEffect(count, liveLength) {
                if (count > 0 && jumped) list.animateScrollToItem(count + 1)
            }
            // Near the top: ask for the older page.
            LaunchedEffect(list) {
                snapshotFlow { list.firstVisibleItemIndex }.collect { if (it == 0 && timeline.hasMore) viewModel.loadOlder() }
            }
            PinBar(timeline.pins)
            if (!timeline.latest) OlderSessionBar { viewModel.openSession(null) }
            // How much chat shows over the character: none, the two newest, or all (look.bubbles).
            val over = stage && look.bubbles == 0
            val extraRows = timeline.earlier.size + timeline.pending.size + (if (timeline.live != null) 1 else 0)
            val shownMessages = when {
                over -> emptyList()
                !stage || look.bubbles == 2 -> timeline.messages
                else -> timeline.messages.takeLast((2 - extraRows).coerceAtLeast(0))
            }
            LaunchedEffect(shownMessages.size, timeline.session?.id) {
                val target = viewModel.jumpTo
                if (!jumped && target != null) {
                    val at = shownMessages.indexOfFirst { it.id == target }
                    if (at >= 0) {
                        list.scrollToItem(at + 1)
                        jumped = true
                    } else if (timeline.loaded && timeline.hasMore) viewModel.loadOlder() else if (timeline.loaded) jumped = true
                }
            }
            LazyColumn(
                state = list,
                modifier = Modifier.weight(1f).fillMaxWidth().then(
                    // Old messages fade out at the top, but never while a question or a running task waits to be answered.
                    if (stage && timeline.permissions.isEmpty() && timeline.tasks.none { it.status in ACTIVE_TASK }) Modifier.fadeTop() else Modifier,
                ),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = if (solo) Arrangement.spacedBy(12.dp, Alignment.Bottom) else Arrangement.spacedBy(8.dp),
            ) {
                item(key = "top") {
                    if (timeline.hasMore) TextButton(onClick = viewModel::loadOlder, modifier = Modifier.fillMaxWidth()) { Text("โหลดข้อความก่อนหน้า") }
                    else if (timeline.loaded && timeline.messages.isEmpty() && timeline.live == null) {
                        Text("เริ่มคุยได้เลย", color = MimiColors.muted, modifier = Modifier.fillMaxWidth().padding(24.dp))
                    }
                }
                items(shownMessages, key = { "m${it.id}" }) { message ->
                    MessageBubble(message, state.agents[message.agent]?.shownName ?: message.agent, viewModel::fileUrl, open, viewModel::decideApproval, actions, state.agents)
                }
                items(if (over) 0 else timeline.earlier.size, key = { "e$it" }) { LiveBubbleView(timeline.earlier[it], state.agents[timeline.earlier[it].agent]?.shownName, viewModel::fileUrl, open) }
                timeline.live?.takeIf { !over }?.let { live -> item(key = "live") { LiveBubbleView(live, state.agents[live.agent]?.shownName, viewModel::fileUrl, open) } }
                items(timeline.tasks, key = { "t${it.id}" }) { card -> TaskCardView(card, viewModel::taskControl, viewModel::taskUndo) }
                items(if (over) emptyList() else timeline.pending, key = { "p${it.clientId}" }) { pending ->
                    UserBubble {
                        if (pending.attachmentNames.isNotEmpty()) Text("📎 " + pending.attachmentNames.joinToString(), color = MimiColors.ink2, style = MaterialTheme.typography.bodySmall)
                        if (pending.text.isNotEmpty()) MessageText(pending.text)
                        Text(pending.failed?.let { "ส่งไม่สำเร็จ: $it" } ?: "กำลังส่ง…", color = if (pending.failed != null) MimiColors.bad else MimiColors.faint, style = MaterialTheme.typography.labelSmall)
                    }
                }
                notes(timeline.notes)
                items(timeline.permissions, key = { "q${it.id}" }) { request -> PermissionCard(request, viewModel::answerPermission) }
            }
            state.replyTo?.let { target ->
                ReplyBar(target, if (target.role == "user") "คุณ" else state.agents[target.agent]?.shownName ?: target.agent) { viewModel.reply(null) }
            }
            if (state.staged.isNotEmpty()) StagedRow(state.staged, viewModel::unstage)
            Composer(
                text = text,
                onText = { text = it },
                busy = timeline.busy,
                recording = state.recording,
                level = { viewModel.recordLevel() },
                onAttach = { pick.launch("*/*") },
                onSend = { viewModel.send(text); text = "" },
                onStop = viewModel::abort,
                onMic = {
                    if (state.recording) viewModel.stopRecording(send = true)
                    else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) viewModel.startRecording()
                    else askMic.launch(Manifest.permission.RECORD_AUDIO)
                },
                onCancelRecording = { viewModel.stopRecording(send = false) },
            )
        }
        if (solo) SoloBar(onBack = onBack, status = statusText, onSettings = { settings = true }, modifier = Modifier.align(Alignment.TopCenter))
        }
    }
    }
    if (settings) ChatSettingsSheet(
        look, solo, viewModel::setLook, timeline,
        onOpenSession = { settings = false; viewModel.openSession(it) },
        onNewSession = { settings = false; viewModel.newSession() },
        onDismiss = { settings = false },
    )
    confirmRewind?.let { message ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmRewind = null },
            title = { Text("ย้อนกลับมาตรงนี้?") },
            text = { Text("ข้อความนี้และที่ตามมาจะถูกซ่อน ข้อความจะกลับไปที่ช่องพิมพ์ให้แก้แล้วส่งใหม่ และไฟล์ที่งานย้ายไปจะถูกย้อนกลับ") },
            confirmButton = { TextButton(onClick = { confirmRewind = null; viewModel.rewind(message) }) { Text("ย้อนกลับ") } },
            dismissButton = { TextButton(onClick = { confirmRewind = null }) { Text("ยกเลิก") } },
        )
    }
    viewing?.let { attachment -> ImageViewer(viewModel.fileUrl(attachment)) { viewing = null } }
}

/** The character chat's top: a glass back button, a pill while something is happening (web .typing-chip), and settings. */
@Composable
private fun SoloBar(onBack: () -> Unit, status: String?, onSettings: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
        GlassCircle(onClick = onBack, size = 44, modifier = Modifier.align(Alignment.CenterStart)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "กลับ", tint = Color.White)
        }
        if (status != null) {
            Text(
                status,
                color = Color.White,
                fontSize = 12.5.sp,
                maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(Color(0xDB1B1419)).border(1.dp, Color(0x2EFFFFFF), RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
        GlassCircle(onClick = onSettings, size = 44, modifier = Modifier.align(Alignment.CenterEnd)) {
            Icon(Icons.Default.Settings, contentDescription = "ตั้งค่าแชต", tint = Color.White)
        }
    }
}

@Composable
private fun GlassCircle(onClick: () -> Unit, size: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier.size(size.dp).clip(RoundedCornerShape(50)).background(MimiColors.glass).border(1.dp, MimiColors.glassLine, RoundedCornerShape(50)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

private fun LazyListScope.notes(notes: List<app.mimi.core.model.Note>) {
    items(notes.size, key = { "n$it" }) { index ->
        val note = notes[index]
        Text(note.text, color = if (note.bad) MimiColors.bad else MimiColors.muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 8.dp))
    }
}

fun openFile(context: Context, file: java.io.File, mime: String) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
private fun UserBubble(time: String? = null, content: @Composable () -> Unit) {
    val solo = LocalSolo.current
    val shape = if (solo) RoundedCornerShape(18.dp) else RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val look = if (solo) Modifier.background(MimiColors.soloUser, shape) else Modifier.background(MimiColors.userBg, shape).border(1.dp, MimiColors.userLine, shape)
            Column(
                Modifier.widthIn(max = 320.dp).clip(shape).then(look).padding(horizontal = if (solo) 15.dp else 13.dp, vertical = if (solo) 9.dp else 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // Dark text on the cream bubble (app.css .solo .user).
                CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides if (solo) MimiColors.soloUserInk else MimiColors.ink) { content() }
            }
            time?.takeIf { it.isNotEmpty() }?.let { Text(it, color = if (solo) MimiColors.soloTime else MimiColors.faint, fontSize = 11.sp) }
        }
    }
}

@Composable
private fun AgentBubble(name: String?, speech: SpeechStyle?, time: String? = null, content: @Composable () -> Unit) {
    val solo = LocalSolo.current
    val shape = if (solo) RoundedCornerShape(16.dp) else RoundedCornerShape(4.dp, 14.dp, 14.dp, 14.dp)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!solo) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!name.isNullOrBlank()) Text(name, color = MimiColors.accentText, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                speechLabel(speech)?.let { Text("  $it", color = MimiColors.faint, style = MaterialTheme.typography.labelSmall) }
            }
        }
        val look = if (solo) Modifier.background(MimiColors.soloTx, shape).border(1.dp, MimiColors.soloTxLine, shape) else Modifier.background(MimiColors.panel, shape).border(1.dp, MimiColors.line, shape)
        Column(
            Modifier.widthIn(max = if (solo) 340.dp else 340.dp).clip(shape).then(look).padding(horizontal = if (solo) 14.dp else 12.dp, vertical = if (solo) 10.dp else 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) { content() }
        time?.takeIf { it.isNotEmpty() }?.let { Text(it, color = if (solo) MimiColors.soloTime else MimiColors.faint, fontSize = 11.sp) }
    }
}

private fun speechLabel(speech: SpeechStyle?): String? =
    listOfNotNull(speech?.emotion, speech?.tone).takeIf { it.isNotEmpty() }?.joinToString(" · ")

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: ChatMessageView,
    agentName: String,
    fileUrl: (AttachmentView) -> String,
    open: (AttachmentView) -> Unit,
    decide: (Long, Boolean) -> Unit,
    actions: MessageActions,
    agents: Map<String, AgentView>,
) {
    var menu by remember { mutableStateOf(false) }
    val time = (if (message.pinned) "📌 " else "") + shortTime(message.createdAt)
    val mine = message.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Box(Modifier.combinedClickable(onClick = {}, onLongClick = { menu = true })) {
            if (mine) {
                UserBubble(time = time) {
                    message.replyTo?.let { QuoteBlock(it, agents, onCream = LocalSolo.current) }
                    Attachments(message.attachments, fileUrl, open)
                    if (message.text.isNotEmpty()) MessageText(message.text, selectable = false)
                }
            } else {
                val text = parseSpeech(message.text).text
                AgentBubble(agentName, message.speech, time = time) {
                    message.replyTo?.let { QuoteBlock(it, agents) }
                    message.tools.forEach { ToolLine(it.name, it.summary, ok = true) }
                    if (text.isNotEmpty()) MessageText(text, selectable = false)
                    Attachments(message.attachments, fileUrl, open)
                    message.approval?.takeIf { it.status == "pending" }?.let { approval ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { decide(approval.id, true) }) { Text("อนุมัติ") }
                            OutlinedButton(onClick = { decide(approval.id, false) }) { Text("ปฏิเสธ") }
                        }
                    }
                    message.approval?.takeIf { it.status != "pending" }?.let { Text("คำขอ: ${it.status}", color = MimiColors.muted, style = MaterialTheme.typography.labelSmall) }
                }
            }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                Row(Modifier.padding(horizontal = 8.dp)) {
                    for (emoji in QUICK_REACTIONS) {
                        Text(emoji, fontSize = 22.sp, modifier = Modifier.clickable { menu = false; actions.react(message, emoji) }.padding(6.dp))
                    }
                }
                DropdownMenuItem(text = { Text("ตอบกลับ") }, onClick = { menu = false; actions.reply(message) })
                DropdownMenuItem(text = { Text("คัดลอก") }, onClick = { menu = false; actions.copy(parseSpeech(message.text).text) })
                DropdownMenuItem(text = { Text(if (message.pinned) "เลิกปักหมุด" else "ปักหมุด") }, onClick = { menu = false; actions.pin(message) })
                if (mine) DropdownMenuItem(text = { Text("ย้อนกลับมาตรงนี้") }, onClick = { menu = false; actions.rewind(message) })
            }
        }
        if (message.reactions.isNotEmpty()) {
            Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((emoji, count) in message.reactions.groupingBy { it }.eachCount()) {
                    Text(
                        if (count > 1) "$emoji $count" else emoji,
                        fontSize = 13.sp,
                        modifier = Modifier.clip(RoundedCornerShape(50)).background(MimiColors.accent.copy(alpha = 0.14f))
                            .border(1.dp, MimiColors.accent.copy(alpha = 0.5f), RoundedCornerShape(50))
                            .clickable { actions.react(message, emoji) }.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }
    }
}

/** The message a reply answers, shown inside the bubble (app.css .quote). */
@Composable
private fun QuoteBlock(quoted: QuotedMessage, agents: Map<String, AgentView>, onCream: Boolean = false) {
    val who = if (quoted.role == "user") "คุณ" else agents[quoted.agent]?.shownName ?: quoted.agent
    Row(Modifier.height(IntrinsicSize.Min).clip(RoundedCornerShape(6.dp)).background(MimiColors.accent.copy(alpha = 0.08f))) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(MimiColors.accent))
        Column(Modifier.padding(horizontal = 9.dp, vertical = 4.dp)) {
            if (who.isNotBlank()) Text(who, color = if (onCream) Color(0xFF9B3F61) else MimiColors.accentText, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(quoted.text.replace("*", "").replace("`", ""), color = LocalContentColor.current.copy(alpha = 0.7f), fontSize = 12.sp, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
    }
}

/** The reply bar above the composer: who is being answered, and a way to drop it. */
@Composable
private fun ReplyBar(target: ChatMessageView, who: String, onClear: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(10.dp)).background(MimiColors.raised),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(40.dp).background(MimiColors.accent))
        Column(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text("ตอบกลับ $who", color = MimiColors.accentText, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text(parseSpeech(target.text).text.replace("*", "").replace("`", ""), color = MimiColors.muted, fontSize = 12.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
        IconButton(onClick = onClear) { Icon(Icons.Default.Close, contentDescription = "เลิกตอบกลับ") }
    }
}

/** The newest pinned message under the top (web .pinbar); a tap shows the next one. */
@Composable
private fun PinBar(pins: List<PinView>) {
    if (pins.isEmpty()) return
    var index by remember { mutableStateOf(0) }
    val at = index.coerceIn(0, pins.lastIndex)
    val pin = pins[at]
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(MimiColors.panel)
            .border(1.dp, MimiColors.line, RoundedCornerShape(12.dp)).clickable { index = (at + 1) % pins.size }.padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.PushPin, contentDescription = null, tint = MimiColors.accentText, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text("ปักหมุด ${at + 1}/${pins.size}", color = MimiColors.accentText, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(8.dp))
        Text(parseSpeech(pin.text).text.replace("*", "").replace("`", ""), color = MimiColors.ink2, fontSize = 12.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

private val ACTIVE_TASK = setOf("queued", "running", "awaiting_confirmation", "paused")

private val TASK_STATUS = mapOf(
    "queued" to "รอคิว", "running" to "กำลังทำ", "awaiting_confirmation" to "รอให้ยืนยัน", "paused" to "หยุดชั่วคราว",
    "cancelled" to "ยกเลิกแล้ว", "completed" to "เสร็จแล้ว ✓", "failed" to "ไม่สำเร็จ ✗", "undone" to "ย้อนแล้ว",
)

private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.number(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull ?: "0"

/** A task card: goal, status, steps, plan / receipt, and its buttons (feature-inventory #10). */
@Composable
private fun TaskCardView(card: TaskCard, control: (String, String) -> Unit, undo: (String) -> Unit) {
    val task = card.task
    val status = card.status
    val steps = (task["steps"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { step ->
        val mark = when (step.text("status")) { "done" -> "✓"; "running" -> "…"; "failed" -> "✗"; "skipped" -> "–"; "cancelled" -> "■"; else -> "○" }
        val detail = step.text("detail")
        "$mark ${step.text("title")}${if (detail.isNotEmpty()) " — $detail" else ""}"
    }
    val summary = buildList {
        (task["plan"] as? JsonObject)?.let { add("แผน: ${it.number("total")} ไฟล์ใน ${it.text("folder")} (${it.text("policy")})") }
        (task["receipt"] as? JsonObject)?.let { add("ผล: ${it.text("summary")} · ย้าย ${it.number("moved")} · ข้าม ${it.number("skipped")} · ล้มเหลว ${it.number("failed")}") }
        (task["undoReceipt"] as? JsonObject)?.let { add("ย้อน: ${it.text("summary")}") }
        (task["verification"] as? JsonObject)?.let { add("ตรวจผล: ${it.text("summary")}") }
        task.text("error").takeIf { it.isNotEmpty() }?.let { add("ผิดพลาด: $it") }
    }
    val undoable = status == "completed" && (task["receipt"] as? JsonObject)?.let { (it["undoable"] as? JsonPrimitive)?.booleanOrNull == true } == true
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MimiColors.raised).border(1.dp, MimiColors.info.copy(alpha = 0.6f), RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Text(task.text("goal"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(TASK_STATUS[status] ?: status, color = MimiColors.info, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
        }
        // One line per step and two per result: the paths are long, the card must stay readable.
        for (line in steps) Text(line, color = MimiColors.ink2, fontSize = 12.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        for (line in summary) Text(line, color = MimiColors.muted, fontSize = 12.sp, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (status == "running" || status == "queued") OutlinedButton(onClick = { control(card.id, "pause") }) { Text("หยุดชั่วคราว") }
            if (status == "paused") Button(onClick = { control(card.id, "resume") }) { Text("ทำต่อ") }
            if (status in setOf("running", "queued", "paused", "awaiting_confirmation")) OutlinedButton(onClick = { control(card.id, "cancel") }) { Text("ยกเลิก") }
            if (undoable) OutlinedButton(onClick = { undo(card.id) }) { Text("ย้อนไฟล์กลับ") }
        }
    }
}

@Composable
private fun LiveBubbleView(live: LiveBubble, name: String?, fileUrl: (AttachmentView) -> String, open: (AttachmentView) -> Unit) {
    AgentBubble(name ?: live.agent, live.speech) {
        if (live.segments.isEmpty()) Text("…", color = MimiColors.muted)
        for (segment in live.segments) when (segment) {
            is LiveSegment.Text -> if (segment.shown.isNotEmpty()) MessageText(segment.shown)
            is LiveSegment.Tool -> ToolLine(segment.name, segment.arg, segment.ok)
            is LiveSegment.File -> Attachments(listOf(segment.attachment), fileUrl, open)
        }
        live.helper?.takeIf { !live.finished }?.let { Text("↳ $it กำลังช่วย…", color = MimiColors.faint, style = MaterialTheme.typography.labelSmall) }
    }
}

@Composable
private fun ToolLine(name: String, detail: String, ok: Boolean?) {
    val mark = when (ok) { null -> "⏳"; true -> "⚙"; false -> "✗" }
    Text(
        "$mark $name ${detail.take(120)}",
        color = if (ok == false) MimiColors.bad else MimiColors.muted,
        style = MaterialTheme.typography.bodySmall,
        maxLines = 2,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Attachments(files: List<AttachmentView>, fileUrl: (AttachmentView) -> String, open: (AttachmentView) -> Unit) {
    if (files.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (file in files) {
            if (IMAGE.matches(file.mime) && file.deletedAt == null) {
                AsyncImage(
                    model = fileUrl(file),
                    contentDescription = file.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(180.dp).clip(RoundedCornerShape(10.dp)).clickable { open(file) },
                )
            } else {
                AssistChip(
                    onClick = { open(file) },
                    enabled = file.deletedAt == null,
                    label = { Text(file.name + (if (file.kind == "audio" && file.text.isNotBlank()) " — ${file.text.take(60)}" else ""), maxLines = 1) },
                    leadingIcon = { Icon(if (file.kind == "audio") Icons.Default.Mic else Icons.Default.Description, null) },
                )
            }
        }
    }
}

@Composable
private fun PermissionCard(request: PermissionRequest, answer: (String, Boolean, String) -> Unit) {
    Surface(color = MimiColors.panel, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().border(1.dp, MimiColors.warn, RoundedCornerShape(12.dp))) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("✋ ${request.agent} ขออนุญาตใช้ ${request.tool}", fontWeight = FontWeight.SemiBold)
            if (request.summary.isNotBlank()) Text(request.summary, color = MimiColors.ink2)
            Text("ความเสี่ยง: ${request.risk}", color = MimiColors.muted, style = MaterialTheme.typography.labelSmall)
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { answer(request.id, true, "once") }) { Text("ครั้งนี้") }
                if (!request.noGrant) {
                    OutlinedButton(onClick = { answer(request.id, true, "task") }) { Text("ทั้งงานนี้") }
                    OutlinedButton(onClick = { answer(request.id, true, "session") }) { Text("ทั้ง session") }
                    OutlinedButton(onClick = { answer(request.id, true, "always") }) { Text("ตลอด") }
                }
                TextButton(onClick = { answer(request.id, false, "once") }) { Text("ไม่อนุญาต", color = MimiColors.bad) }
            }
        }
    }
}

@Composable
private fun StagedRow(staged: List<Staged>, remove: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (file in staged) {
            InputChip(
                selected = false,
                onClick = { remove(file.key) },
                label = {
                    Text(
                        when {
                            file.error != null -> "✗ ${file.name}"
                            file.attachment == null -> "⏳ ${file.name}"
                            else -> file.name
                        },
                        maxLines = 1,
                    )
                },
                trailingIcon = { Icon(Icons.Default.Close, contentDescription = "เอาออก", modifier = Modifier.size(16.dp)) },
            )
        }
    }
}

@Composable
private fun Composer(
    text: String,
    onText: (String) -> Unit,
    busy: Boolean,
    recording: Boolean,
    level: () -> Float,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMic: () -> Unit,
    onCancelRecording: () -> Unit,
) {
    if (LocalSolo.current) {
        SoloComposer(text, onText, busy, recording, level, onAttach, onSend, onStop, onMic, onCancelRecording)
        return
    }
    Row(
        Modifier.fillMaxWidth().background(MimiColors.panel).navigationBarsPadding().padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (recording) {
            RecordingStrip(level, onCancelRecording, Modifier.weight(1f))
        } else {
            IconButton(onClick = onAttach) { Icon(Icons.Default.AttachFile, contentDescription = "แนบไฟล์") }
            TextField(
                value = text,
                onValueChange = onText,
                placeholder = { Text("พิมพ์ข้อความ…") },
                modifier = Modifier.weight(1f).heightIn(max = 160.dp),
                colors = TextFieldDefaults.colors(focusedContainerColor = MimiColors.raised, unfocusedContainerColor = MimiColors.raised),
                shape = RoundedCornerShape(20.dp),
            )
        }
        if (busy && !recording) {
            IconButton(onClick = onStop) { Icon(Icons.Default.Stop, contentDescription = "หยุด", tint = MimiColors.bad) }
        }
        if (text.isBlank() || recording) {
            IconButton(onClick = onMic) { Icon(Icons.Default.Mic, contentDescription = if (recording) "ส่งเสียง" else "อัดเสียง", tint = if (recording) MimiColors.bad else MimiColors.ink) }
        } else {
            IconButton(onClick = onSend) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "ส่ง", tint = MimiColors.accent) }
        }
    }
}

@Composable
private fun RecordingStrip(level: () -> Float, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf(0f) }
    LaunchedEffect(Unit) { while (true) { shown = level(); delay(80) } }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onCancel) { Icon(Icons.Default.Close, contentDescription = "ยกเลิก") }
        Box(Modifier.weight(1f).heightIn(min = 48.dp), contentAlignment = Alignment.CenterStart) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size((10 + shown * 30).dp).clip(RoundedCornerShape(50)).background(MimiColors.bad))
                Spacer(Modifier.width(12.dp))
                Text("กำลังอัดเสียง — แตะไมค์อีกครั้งเพื่อส่ง", color = MimiColors.ink2)
            }
        }
    }
}

/** app.css html[data-mode=mobile] .solo: mic and attach as 48 glass circles, a glass pill for the text, send inside its right end. */
@Composable
private fun SoloComposer(
    text: String,
    onText: (String) -> Unit,
    busy: Boolean,
    recording: Boolean,
    level: () -> Float,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMic: () -> Unit,
    onCancelRecording: () -> Unit,
) {
    val pill = RoundedCornerShape(24.dp)
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 12.dp, end = 12.dp, bottom = 12.dp, top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        if (recording) {
            Box(Modifier.weight(1f).clip(pill).background(MimiColors.soloInput).border(1.dp, MimiColors.glassLine, pill)) {
                RecordingStrip(level, onCancelRecording)
            }
            GlassCircle(onClick = onMic, size = 48) { Icon(Icons.Default.Mic, contentDescription = "ส่งเสียง", tint = MimiColors.bad) }
            return@Row
        }
        // The mic goes away while there is text or an answer is coming (web: .box.busy #mic).
        if (text.isBlank() && !busy) {
            GlassCircle(onClick = onMic, size = 48) { Icon(Icons.Default.Mic, contentDescription = "อัดเสียง", tint = Color.White) }
        }
        GlassCircle(onClick = onAttach, size = 48) { Icon(Icons.Default.AttachFile, contentDescription = "แนบไฟล์", tint = Color.White) }
        Box(Modifier.weight(1f)) {
            TextField(
                value = text,
                onValueChange = onText,
                placeholder = { Text("พิมพ์ข้อความ…", color = Color.White.copy(alpha = 0.72f)) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp, max = 140.dp).border(1.dp, MimiColors.glassLine, pill),
                shape = pill,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MimiColors.soloInput,
                    unfocusedContainerColor = MimiColors.soloInput,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                ),
            )
            when {
                busy -> GlassCircle(onClick = onStop, size = 40, modifier = Modifier.align(Alignment.CenterEnd).padding(end = 4.dp)) {
                    Icon(Icons.Default.Stop, contentDescription = "หยุด", tint = MimiColors.bad)
                }
                text.isNotBlank() -> Box(
                    Modifier.align(Alignment.CenterEnd).padding(end = 4.dp).size(40.dp).clip(RoundedCornerShape(50)).background(MimiColors.accent).clickable(onClick = onSend),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "ส่ง", tint = MimiColors.accentInk) }
            }
        }
    }
}

@Composable
private fun ImageViewer(url: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        }
    }
}

/** Older messages fade out towards the top of the list (web `.solo .log.fade-top`). */
private fun Modifier.fadeTop(): Modifier = this
    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        drawRect(
            Brush.verticalGradient(0f to Color.Transparent, 0.18f to Color.Transparent, 0.46f to Color.Black),
            blendMode = BlendMode.DstIn,
        )
    }

/** Behind the chat: the chat's own background, then the character with a shade towards the bottom (app.css .solo .stage). */
@Composable
private fun StageLayers(background: ChatBackground?, backgroundUrl: (String) -> String, figure: String?, look: ChatLook) {
    if (background?.type.let { it == null || it == "none" } && figure == null) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        when (background?.type) {
            "preset" -> background.preset?.let { AsyncImage(model = backgroundUrl(it), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
            "solid" -> parseColor(background.color)?.let { Box(Modifier.fillMaxSize().background(it)) }
            "gradient" -> {
                val from = parseColor(background.from)
                val to = parseColor(background.to)
                if (from != null && to != null) Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(from, to))))
            }
        }
        if (figure != null) {
            val width = maxWidth
            val height = maxHeight
            AsyncImage(
                model = figure,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                alignment = Alignment.BottomCenter,
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.94f)
                    .offset(x = width * (look.x / 100f), y = height * (look.y / 100f))
                    .graphicsLayer(scaleX = look.zoom, scaleY = look.zoom, transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 1f)),
            )
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.62f).background(
                    Brush.verticalGradient(listOf(Color(0x000E0F13), Color(0x380E0F13), Color(0x990E0F13))),
                ),
            )
        }
    }
}

private val BACKGROUNDS = listOf(
    "floral" to "ลายดอกไม้", "mint" to "มินต์", "blush" to "ชมพู", "sky" to "ฟ้า", "grid" to "ตาราง", "starlight" to "แสงดาว",
    "dawn" to "รุ่งอรุณ", "ember" to "เมฆแดงเข้ม", "crimson" to "เมฆชาด", "waves" to "คลื่นทะเล", "confetti" to "คอนเฟตติ",
)

/** The web's segmented switch (app.css .seg). */
@Composable
private fun Segments(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, MimiColors.line, RoundedCornerShape(12.dp)).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        options.forEachIndexed { index, label ->
            val on = index == selected
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(9.dp))
                    .background(if (on) MimiColors.accent.copy(alpha = 0.14f) else Color.Transparent)
                    .border(1.dp, if (on) MimiColors.accent.copy(alpha = 0.5f) else Color.Transparent, RoundedCornerShape(9.dp))
                    .clickable { onSelect(index) }.padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) { Text(label, color = if (on) MimiColors.accentText else MimiColors.ink2, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) }
        }
    }
}

@Composable
private fun SettingLabel(text: String) = Text(text, color = MimiColors.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))

/** Chat setting → หน้าตา: text size, the character, how much chat shows over it, where it stands, the background. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ChatSettingsSheet(
    look: ChatLook,
    direct: Boolean,
    change: ((ChatLook) -> ChatLook) -> Unit,
    timeline: ChatTimeline,
    onOpenSession: (Long?) -> Unit,
    onNewSession: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MimiColors.panel) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).verticalScroll(rememberScrollState())) {
            Text("ตั้งค่าแชต", fontWeight = FontWeight.Bold, fontSize = 17.sp)
            SessionSection(timeline, onOpenSession, onNewSession)
            SettingLabel("หน้าตา · ขนาดตัวอักษร")
            Segments(listOf("เล็ก", "ปกติ", "ใหญ่"), look.textSize) { size -> change { it.copy(textSize = size) } }
            if (direct) {
                SettingLabel("ตัวละคร")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("แสดงตัวละครหลังแชต", modifier = Modifier.weight(1f))
                    Switch(checked = look.character, onCheckedChange = { on -> change { it.copy(character = on) } })
                }
                if (look.character) {
                    SettingLabel("ข้อความบนตัวละคร")
                    Segments(listOf("ไม่แสดง", "2 ข้อความล่าสุด", "ทั้งหมด"), look.bubbles) { level -> change { it.copy(bubbles = level) } }
                    SettingLabel("ตำแหน่งตัวละคร")
                    Text("ขนาด", color = MimiColors.ink2, fontSize = 12.sp)
                    Slider(look.zoom, { v -> change { it.copy(zoom = v) } }, valueRange = 0.5f..1.8f)
                    Text("ซ้าย – ขวา", color = MimiColors.ink2, fontSize = 12.sp)
                    Slider(look.x, { v -> change { it.copy(x = v) } }, valueRange = -50f..50f)
                    Text("ขึ้น – ลง", color = MimiColors.ink2, fontSize = 12.sp)
                    Slider(look.y, { v -> change { it.copy(y = v) } }, valueRange = -40f..40f)
                    TextButton(onClick = { change { it.copy(zoom = 1f, x = 0f, y = 0f) } }) { Text("คืนตำแหน่งเดิม") }
                }
            }
            SettingLabel("ฉากหลัง")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((id, name) in listOf<Pair<String?, String>>(null to "ไม่มี") + BACKGROUNDS) {
                    val on = (look.background?.takeIf { it.type == "preset" }?.preset) == id
                    Text(
                        name,
                        color = if (on) MimiColors.accentText else MimiColors.ink2,
                        fontSize = 13.sp,
                        modifier = Modifier.clip(RoundedCornerShape(50))
                            .background(if (on) MimiColors.accent.copy(alpha = 0.14f) else Color.Transparent)
                            .border(1.dp, if (on) MimiColors.accent.copy(alpha = 0.5f) else MimiColors.line, RoundedCornerShape(50))
                            .clickable { change { it.copy(background = id?.let { preset -> ChatBackground("preset", preset = preset) }) } }.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}

private fun sessionName(session: SessionView) = session.title.ifBlank { "Session #${session.id}" }

/** "context 23% · cache 80% · $0.012" for the session meter. */
private fun contextLabel(context: SessionContextView): String? =
    if (context.windowTokens <= 0) null
    else "context ${Math.round(100.0 * context.usedTokens / context.windowTokens)}%" +
        (context.cacheHitPct?.let { " · cache ${Math.round(it)}%" } ?: "") + " · $${"%.3f".format(context.costUsd)}"

/** The chat's sessions: the one on screen with its size, a new one, the others to open (feature-inventory #14). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionSection(timeline: ChatTimeline, onOpen: (Long?) -> Unit, onNew: () -> Unit) {
    val shown = timeline.session
    SettingLabel("Session")
    if (shown != null) {
        Text(sessionName(shown) + if (timeline.latest) "" else " (เก่า)", fontWeight = FontWeight.SemiBold)
        timeline.context?.let(::contextLabel)?.let { Text(it, color = MimiColors.muted, fontSize = 12.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace) }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        OutlinedButton(onClick = onNew) { Text("+ เริ่ม session ใหม่") }
        if (!timeline.latest) Button(onClick = { onOpen(null) }) { Text("กลับไป session ล่าสุด") }
    }
    if (timeline.sessions.size > 1) {
        Column(Modifier.padding(top = 6.dp)) {
            for (entry in timeline.sessions) {
                val current = entry.id == shown?.id
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (current) MimiColors.accent.copy(alpha = 0.10f) else Color.Transparent)
                        .clickable { onOpen(if (entry.id == timeline.sessions.first().id) null else entry.id) }.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(sessionName(entry), modifier = Modifier.weight(1f), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, color = if (current) MimiColors.accentText else MimiColors.ink)
                    Text(shortTime(entry.lastMessageAt.ifEmpty { entry.createdAt }) + if (entry.unread) " · ใหม่" else "", color = MimiColors.faint, fontSize = 11.sp)
                }
            }
        }
    }
}

/** Shown while an older session is open: new turns land in the newest one. */
@Composable
private fun OlderSessionBar(onLatest: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(MimiColors.panel)
            .border(1.dp, MimiColors.line, RoundedCornerShape(12.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("กำลังดู session เก่า", color = MimiColors.muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
        TextButton(onClick = onLatest) { Text("กลับไป session ล่าสุด", fontSize = 12.sp) }
    }
}

/** "#rrggbb" from the web's background settings, or null when it is not one. */
private fun parseColor(text: String?): Color? =
    text?.takeIf { Regex("^#[0-9a-fA-F]{6}$").matches(it) }?.let { Color(android.graphics.Color.parseColor(it)) }
