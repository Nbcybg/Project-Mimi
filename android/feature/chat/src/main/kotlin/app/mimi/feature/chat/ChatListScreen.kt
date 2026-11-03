package app.mimi.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mimi.core.data.net.SocketState
import app.mimi.core.ui.Avatar
import app.mimi.core.ui.MimiColors
import kotlinx.coroutines.launch

/** Short local time of a message: today's clock, else the date. */
fun shortTime(iso: String?): String {
    if (iso.isNullOrEmpty()) return ""
    return runCatching {
        val instant = java.time.Instant.parse(iso)
        val local = instant.atZone(java.time.ZoneId.systemDefault())
        val today = java.time.LocalDate.now()
        if (local.toLocalDate() == today) "%02d:%02d".format(local.hour, local.minute) else "${local.dayOfMonth}/${local.monthValue}"
    }.getOrDefault("")
}

@Composable
fun connectionLabel(state: SocketState): String? = when (state) {
    is SocketState.Online -> null
    SocketState.Idle, SocketState.Connecting -> "กำลังเชื่อมต่อ…"
    is SocketState.Offline -> "ออฟไลน์ — กำลังเชื่อมต่อใหม่"
    SocketState.RateLimited -> "ลองรหัสผิดหลายครั้ง รอ 15 นาที"
    SocketState.SignedOut -> "ออกจากระบบแล้ว"
    SocketState.AppTooOld -> "เซิร์ฟเวอร์ต้องใช้แอปเวอร์ชันใหม่กว่า"
    is SocketState.CoreTooOld -> "เซิร์ฟเวอร์เก่าเกินไปสำหรับแอปนี้"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListRoute(
    onOpenChat: (Long) -> Unit,
    onMimiamp: () -> Unit,
    onSignOut: () -> Unit,
    banner: @Composable () -> Unit = {},
    viewModel: ChatListViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var group by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var pickAgent by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Mimi", fontWeight = FontWeight.Bold)
                        connectionLabel(state.connection)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MimiColors.muted) }
                    }
                },
                actions = {
                    IconButton(onClick = onMimiamp) { Icon(Icons.Default.LibraryMusic, contentDescription = "Mimiamp") }
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "เมนู") }
                    DropdownMenu(menu, onDismissRequest = { menu = false }) {
                        if (state.username.isNotEmpty()) DropdownMenuItem(text = { Text(state.username, color = MimiColors.muted) }, onClick = {}, enabled = false)
                        DropdownMenuItem(
                            text = { Text("ออกจากระบบ") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                            onClick = { menu = false; onSignOut() },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { pickAgent = true }) { Icon(Icons.Default.Add, contentDescription = "แชตใหม่") }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            banner()
            SecondaryTabRow(selectedTabIndex = if (group) 1 else 0, containerColor = MaterialTheme.colorScheme.background) {
                Tab(selected = !group, onClick = { group = false }, text = { Text("ตัวต่อตัว") })
                Tab(selected = group, onClick = { group = true }, text = { Text("กลุ่ม") })
            }
            val rows = state.rows.filter { (it.chat.kind == "group") == group }
            if (rows.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(if (group) "ยังไม่มีแชตกลุ่ม (สร้างได้จากเว็บ)" else "ยังไม่มีแชต — กด + เพื่อเริ่มคุยกับ agent", color = MimiColors.muted)
                }
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(rows, key = { it.chat.id }) { row ->
                    ChatRowItem(row) { onOpenChat(row.chat.id) }
                    HorizontalDivider(color = MimiColors.line.copy(alpha = 0.4f))
                }
            }
        }
    }
    if (pickAgent) {
        AgentPicker(state.agents, onDismiss = { pickAgent = false }) { agent ->
            pickAgent = false
            scope.launch { viewModel.directChat(agent)?.let(onOpenChat) }
        }
    }
}

@Composable
private fun ChatRowItem(row: ChatRow, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(row.title, row.avatarUrl, size = 48.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(row.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(shortTime(row.chat.lastMessageAt), style = MaterialTheme.typography.labelSmall, color = MimiColors.faint)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (row.busy) "กำลังพิมพ์…" else row.chat.preview,
                    color = if (row.busy) MimiColors.accentText else MimiColors.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (row.chat.unread) Box(Modifier.padding(start = 8.dp).size(10.dp).clip(CircleShape).background(MimiColors.accent))
            }
        }
    }
}

@Composable
private fun AgentPicker(agents: List<app.mimi.core.model.AgentView>, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("คุยกับ agent") },
        text = {
            if (agents.isEmpty()) Text("ยังไม่มี agent — สร้างได้จากเว็บ (Agent / Overseer)")
            LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(agents, key = { it.name }) { agent ->
                    Column(Modifier.fillMaxWidth().clickable { onPick(agent.name) }.padding(vertical = 10.dp)) {
                        Text(agent.shownName, fontWeight = FontWeight.SemiBold)
                        if (agent.description.isNotBlank()) Text(agent.description, color = MimiColors.muted, maxLines = 2, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("ปิด") } },
    )
}
