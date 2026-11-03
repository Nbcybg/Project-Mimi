package app.mimi.feature.chat

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.draw.clip
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.title, maxLines = 1, fontWeight = FontWeight.SemiBold)
                        val status = when {
                            timeline.transcribing -> "กำลังถอดเสียง…"
                            timeline.viewing -> "AI กำลังดูรูป…"
                            timeline.busy -> "กำลังพิมพ์…"
                            else -> connectionLabel(state.connection)
                        }
                        status?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MimiColors.accentText) }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "กลับ") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            val list = rememberLazyListState()
            val count = timeline.messages.size + timeline.pending.size + (if (timeline.live != null) 1 else 0) + timeline.earlier.size + timeline.permissions.size + timeline.notes.size
            val liveLength = timeline.live?.segments?.sumOf { if (it is LiveSegment.Text) it.raw.length else 1 } ?: 0
            LaunchedEffect(count, liveLength) {
                if (count > 0) list.animateScrollToItem(count + 1)
            }
            // Near the top: ask for the older page.
            LaunchedEffect(list) {
                snapshotFlow { list.firstVisibleItemIndex }.collect { if (it == 0 && timeline.hasMore) viewModel.loadOlder() }
            }
            LazyColumn(
                state = list,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item(key = "top") {
                    if (timeline.hasMore) TextButton(onClick = viewModel::loadOlder, modifier = Modifier.fillMaxWidth()) { Text("โหลดข้อความก่อนหน้า") }
                    else if (timeline.loaded && timeline.messages.isEmpty() && timeline.live == null) {
                        Text("เริ่มคุยได้เลย", color = MimiColors.muted, modifier = Modifier.fillMaxWidth().padding(24.dp))
                    }
                }
                items(timeline.messages, key = { "m${it.id}" }) { message ->
                    MessageBubble(message, state.agents[message.agent]?.shownName ?: message.agent, viewModel::fileUrl, open, viewModel::decideApproval)
                }
                items(timeline.earlier.size, key = { "e$it" }) { LiveBubbleView(timeline.earlier[it], state.agents[timeline.earlier[it].agent]?.shownName, viewModel::fileUrl, open) }
                timeline.live?.let { live -> item(key = "live") { LiveBubbleView(live, state.agents[live.agent]?.shownName, viewModel::fileUrl, open) } }
                items(timeline.pending, key = { "p${it.clientId}" }) { pending ->
                    UserBubble {
                        if (pending.attachmentNames.isNotEmpty()) Text("📎 " + pending.attachmentNames.joinToString(), color = MimiColors.ink2, style = MaterialTheme.typography.bodySmall)
                        if (pending.text.isNotEmpty()) MessageText(pending.text)
                        Text(pending.failed?.let { "ส่งไม่สำเร็จ: $it" } ?: "กำลังส่ง…", color = if (pending.failed != null) MimiColors.bad else MimiColors.faint, style = MaterialTheme.typography.labelSmall)
                    }
                }
                notes(timeline.notes)
                items(timeline.permissions, key = { "q${it.id}" }) { request -> PermissionCard(request, viewModel::answerPermission) }
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
    }
    viewing?.let { attachment -> ImageViewer(viewModel.fileUrl(attachment)) { viewing = null } }
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
private fun UserBubble(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)).background(MimiColors.userBg)
                .border(1.dp, MimiColors.userLine, RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)).padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) { content() }
    }
}

@Composable
private fun AgentBubble(name: String?, speech: SpeechStyle?, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!name.isNullOrBlank()) Text(name, color = MimiColors.accentText, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
            speechLabel(speech)?.let { Text("  $it", color = MimiColors.faint, style = MaterialTheme.typography.labelSmall) }
        }
        Column(
            Modifier.widthIn(max = 340.dp).clip(RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp)).background(MimiColors.raised).padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) { content() }
    }
}

private fun speechLabel(speech: SpeechStyle?): String? =
    listOfNotNull(speech?.emotion, speech?.tone).takeIf { it.isNotEmpty() }?.joinToString(" · ")

@Composable
private fun MessageBubble(
    message: ChatMessageView,
    agentName: String,
    fileUrl: (AttachmentView) -> String,
    open: (AttachmentView) -> Unit,
    decide: (Long, Boolean) -> Unit,
) {
    if (message.role == "user") {
        UserBubble {
            message.replyTo?.let { Text("↩ ${it.text}", color = MimiColors.faint, style = MaterialTheme.typography.bodySmall, maxLines = 2) }
            Attachments(message.attachments, fileUrl, open)
            if (message.text.isNotEmpty()) MessageText(message.text)
            Text(shortTime(message.createdAt), color = MimiColors.faint, style = MaterialTheme.typography.labelSmall)
        }
        return
    }
    val text = parseSpeech(message.text).text
    AgentBubble(agentName, message.speech) {
        message.tools.forEach { ToolLine(it.name, it.summary, ok = true) }
        if (text.isNotEmpty()) MessageText(text)
        Attachments(message.attachments, fileUrl, open)
        message.approval?.takeIf { it.status == "pending" }?.let { approval ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { decide(approval.id, true) }) { Text("อนุมัติ") }
                OutlinedButton(onClick = { decide(approval.id, false) }) { Text("ปฏิเสธ") }
            }
        }
        message.approval?.takeIf { it.status != "pending" }?.let { Text("คำขอ: ${it.status}", color = MimiColors.muted, style = MaterialTheme.typography.labelSmall) }
        Text(shortTime(message.createdAt), color = MimiColors.faint, style = MaterialTheme.typography.labelSmall)
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
    Row(
        Modifier.fillMaxWidth().background(MimiColors.panel).navigationBarsPadding().padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (recording) {
            var shown by remember { mutableStateOf(0f) }
            LaunchedEffect(Unit) { while (true) { shown = level(); delay(80) } }
            IconButton(onClick = onCancelRecording) { Icon(Icons.Default.Close, contentDescription = "ยกเลิก") }
            Box(Modifier.weight(1f).heightIn(min = 48.dp), contentAlignment = Alignment.CenterStart) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size((10 + shown * 30).dp).clip(RoundedCornerShape(50)).background(MimiColors.bad))
                    Spacer(Modifier.width(12.dp))
                    Text("กำลังอัดเสียง — แตะไมค์อีกครั้งเพื่อส่ง", color = MimiColors.ink2)
                }
            }
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
private fun ImageViewer(url: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        }
    }
}
