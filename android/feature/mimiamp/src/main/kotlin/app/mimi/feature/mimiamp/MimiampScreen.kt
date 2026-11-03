package app.mimi.feature.mimiamp

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Equalizer
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import app.mimi.core.model.MimiampTrack
import app.mimi.core.ui.MimiColors

private fun clock(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MimiampRoute(onBack: () -> Unit, viewModel: MimiampViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var showEq by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }
    var showNewList by remember { mutableStateOf(false) }
    var addTo by remember { mutableStateOf<MimiampTrack?>(null) }
    LaunchedEffect(ui.message) { ui.message?.let { snackbar.showSnackbar(it); viewModel.consumeMessage() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Mimiamp", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "กลับ") } },
                actions = {
                    IconButton(onClick = { showAdd = true }) { Icon(Icons.Default.Add, contentDescription = "เพิ่มจาก YouTube") }
                    IconButton(onClick = { showEq = true }) { Icon(Icons.Default.Equalizer, contentDescription = "EQ") }
                    IconButton(onClick = viewModel::refresh) { Icon(Icons.Default.Refresh, contentDescription = "โหลดใหม่") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = { NowPlayingBar(ui, viewModel) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (ui.loading || ui.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = ui.active == LIBRARY, onClick = { viewModel.select(LIBRARY) }, label = { Text("คลังเพลง (${ui.library.tracks.size})") })
                for (playlist in ui.library.playlists) {
                    FilterChip(selected = ui.active == playlist.id, onClick = { viewModel.select(playlist.id) }, label = { Text("${playlist.name} (${playlist.items.size})") })
                }
                FilterChip(selected = false, onClick = { showNewList = true }, label = { Text("+ เพลย์ลิสต์") })
            }
            if (ui.active != LIBRARY) {
                val playlist = ui.library.playlists.firstOrNull { it.id == ui.active }
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (ui.missing > 0) "${ui.missing} เพลงเป็นไฟล์บนเครื่องอื่น เล่นที่นี่ไม่ได้" else "", color = MimiColors.faint, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    if (playlist != null) TextButton(onClick = { viewModel.deletePlaylist(playlist) }) { Text("ลบเพลย์ลิสต์", color = MimiColors.bad) }
                }
            }
            if (!ui.loading && ui.queue.isEmpty()) {
                Text(if (ui.active == LIBRARY) "ยังไม่มีเพลง — อัปโหลดเพลงขึ้นเซิร์ฟเวอร์ หรือกด + เพื่อเพิ่มจาก YouTube" else "เพลย์ลิสต์นี้ยังว่าง", color = MimiColors.muted, modifier = Modifier.padding(24.dp))
            }
            LazyColumn(Modifier.weight(1f).testTag("tracks")) {
                itemsIndexed(ui.queue, key = { _, track -> track.id }) { index, track ->
                    TrackRow(
                        track = track,
                        current = ui.now.mediaId == track.id,
                        playing = ui.now.mediaId == track.id && ui.now.playing,
                        inPlaylist = ui.active != LIBRARY,
                        onPlay = { viewModel.play(index) },
                        onAddTo = { addTo = track },
                        onRemove = { if (ui.active != LIBRARY) viewModel.removeFromActive(track) else viewModel.removeYoutube(track) },
                    )
                }
            }
        }
    }

    if (showEq) {
        ModalBottomSheet(onDismissRequest = { showEq = false }) { EqPanel(ui.eq, viewModel) }
    }
    if (showAdd) AddYoutubeDialog(ui, viewModel, onDismiss = { showAdd = false })
    if (showNewList) NameDialog("เพลย์ลิสต์ใหม่", onDismiss = { showNewList = false }) { viewModel.createPlaylist(it); showNewList = false }
    addTo?.let { track ->
        AlertDialog(
            onDismissRequest = { addTo = null },
            title = { Text("เพิ่ม “${track.title}” ลง") },
            text = {
                Column {
                    if (ui.library.playlists.isEmpty()) Text("ยังไม่มีเพลย์ลิสต์", color = MimiColors.muted)
                    ui.library.playlists.forEach { playlist ->
                        Text(playlist.name, modifier = Modifier.fillMaxWidth().clickable { viewModel.addToPlaylist(playlist.id, track); addTo = null }.padding(vertical = 12.dp))
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { addTo = null }) { Text("ปิด") } },
        )
    }
}

@Composable
private fun TrackRow(track: MimiampTrack, current: Boolean, playing: Boolean, inPlaylist: Boolean, onPlay: () -> Unit, onAddTo: () -> Unit, onRemove: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onPlay).background(if (current) MimiColors.raised else MimiColors.bg).padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, null, tint = if (current) MimiColors.accent else MimiColors.faint)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (current) MimiColors.accentText else MimiColors.ink)
            Text(
                listOfNotNull(track.artist, if (track.source == "youtube") "YouTube" else null, track.duration?.let { clock((it * 1000).toLong()) }).joinToString(" · "),
                color = MimiColors.muted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
            )
        }
        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "ตัวเลือก") }
        DropdownMenu(menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("เพิ่มลงเพลย์ลิสต์") }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.PlaylistAdd, null) }, onClick = { menu = false; onAddTo() })
            if (inPlaylist) DropdownMenuItem(text = { Text("เอาออกจากเพลย์ลิสต์") }, onClick = { menu = false; onRemove() })
            else if (track.source == "youtube") DropdownMenuItem(text = { Text("ลบเพลง YouTube นี้") }, onClick = { menu = false; onRemove() })
        }
    }
}

@Composable
private fun NowPlayingBar(ui: MimiampUi, viewModel: MimiampViewModel) {
    val now = ui.now
    Column(Modifier.fillMaxWidth().background(MimiColors.panel).navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(now.title.ifEmpty { "ยังไม่ได้เล่น" }, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("nowTitle"))
        if (now.artist.isNotEmpty()) Text(now.artist, color = MimiColors.muted, style = MaterialTheme.typography.bodySmall, maxLines = 1)
        val fraction = if (now.durationMs > 0) (now.positionMs.toFloat() / now.durationMs).coerceIn(0f, 1f) else 0f
        Slider(value = fraction, onValueChange = viewModel::seek, enabled = now.durationMs > 0)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("${clock(now.positionMs)} / ${clock(now.durationMs)}", color = MimiColors.faint, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = viewModel::shuffle) { Icon(Icons.Default.Shuffle, contentDescription = "สุ่ม", tint = if (now.shuffle) MimiColors.accent else MimiColors.faint) }
            IconButton(onClick = viewModel::previous) { Icon(Icons.Default.SkipPrevious, contentDescription = "ก่อนหน้า") }
            IconButton(onClick = viewModel::toggle, modifier = Modifier.testTag("playPause")) {
                Icon(if (now.playing) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = if (now.playing) "หยุดชั่วคราว" else "เล่น", modifier = Modifier.size(36.dp), tint = MimiColors.accent)
            }
            IconButton(onClick = viewModel::next) { Icon(Icons.Default.SkipNext, contentDescription = "ถัดไป") }
            IconButton(onClick = viewModel::repeat) {
                Icon(
                    if (now.repeat == Player.REPEAT_MODE_ONE) Icons.Default.RepeatOne else Icons.Default.Repeat,
                    contentDescription = "เล่นซ้ำ",
                    tint = if (now.repeat == Player.REPEAT_MODE_OFF) MimiColors.faint else MimiColors.accent,
                )
            }
        }
    }
}

@Composable
private fun EqPanel(eq: EqState, viewModel: MimiampViewModel) {
    Column(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("EQ 10 แบนด์", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Switch(checked = eq.enabled, onCheckedChange = viewModel::eqEnabled)
        }
        Text(
            if (eq.deviceBands > 0) "เครื่องนี้ปรับได้จริง ${eq.deviceBands} แบนด์ — แบนด์ที่ใกล้กันใช้ค่าเฉลี่ย" else "เริ่มเล่นเพลงก่อน แล้ว EQ จะผูกกับเครื่องเล่น",
            color = MimiColors.muted,
            style = MaterialTheme.typography.bodySmall,
        )
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            EQ_PRESETS.keys.forEach { name -> FilterChip(selected = false, onClick = { viewModel.eqPreset(name) }, label = { Text(name) }) }
        }
        EQ_BANDS.forEachIndexed { index, hz ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (hz >= 1000) "${hz / 1000}K" else "$hz", modifier = Modifier.width(44.dp), style = MaterialTheme.typography.labelSmall)
                Slider(value = eq.gains[index], onValueChange = { viewModel.eqGain(index, it) }, valueRange = -12f..12f, modifier = Modifier.weight(1f))
                Text("%+.0f".format(eq.gains[index]), modifier = Modifier.width(36.dp), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun AddYoutubeDialog(ui: MimiampUi, viewModel: MimiampViewModel, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("เพิ่มจาก YouTube (เสียงเท่านั้น)") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text, { text = it }, label = { Text("ลิงก์ หรือคำค้นหา") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                ui.search.take(8).forEach { result ->
                    Column(Modifier.fillMaxWidth().clickable { viewModel.addYoutube("https://www.youtube.com/watch?v=${result.videoId}"); onDismiss() }.padding(vertical = 6.dp)) {
                        Text(result.title, maxLines = 2)
                        result.artist?.let { Text(it, color = MimiColors.muted, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val value = text.trim()
                if (value.contains("youtu")) { viewModel.addYoutube(value); onDismiss() } else if (value.isNotEmpty()) viewModel.searchYoutube(value)
            }) { Text(if (text.contains("youtu")) "เพิ่ม" else "ค้นหา") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("ปิด") } },
    )
}

@Composable
private fun NameDialog(title: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(text, { text = it }, singleLine = true, label = { Text("ชื่อ") }) },
        confirmButton = { TextButton(onClick = { if (text.isNotBlank()) onDone(text) }) { Text("บันทึก") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("ยกเลิก") } },
    )
}
