package app.mimi.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.remember
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import app.mimi.core.data.repo.ChatRepository
import app.mimi.core.model.SearchHit
import app.mimi.core.ui.MimiColors
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/** A found message: where it is, who wrote it, and the snippet cut into plain and matched parts. */
data class SearchRow(val hit: SearchHit, val where: String, val parts: List<Pair<String, Boolean>>, val whenText: String)

data class SearchUiState(
    val query: String = "",
    val status: String = PROMPT,
    val rows: List<SearchRow> = emptyList(),
) {
    companion object {
        const val PROMPT = "พิมพ์คำที่ต้องการหา (คำไทยไม่ต้องเว้นวรรค)"
    }
}

/** The core marks the match with `**` in the snippet: split it into plain and matched parts. */
fun highlightParts(snippet: String): List<Pair<String, Boolean>> =
    snippet.split("**").mapIndexedNotNull { index, text -> if (text.isEmpty()) null else text to (index % 2 == 1) }

/** Searching every session of every chat (feature-inventory #15): only the answer to the latest query is shown. */
@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
@HiltViewModel
class SearchViewModel @Inject constructor(private val chats: ChatRepository) : ViewModel() {
    private val query = MutableStateFlow("")
    private val _state = MutableStateFlow(SearchUiState())
    val state: StateFlow<SearchUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            query.debounce(300).distinctUntilChanged().collectLatest { text -> run(text.trim()) }
        }
    }

    fun setQuery(text: String) {
        query.value = text
        _state.value = _state.value.copy(query = text)
    }

    private suspend fun run(text: String) {
        if (text.isEmpty()) {
            _state.value = _state.value.copy(rows = emptyList(), status = SearchUiState.PROMPT)
            return
        }
        _state.value = _state.value.copy(status = "กำลังค้นหา…")
        val hits = chats.search(text)
        if (hits == null) {
            _state.value = _state.value.copy(rows = emptyList(), status = "ค้นหาไม่ได้ — เซิร์ฟเวอร์ไม่ตอบ")
            return
        }
        val agents = chats.agents.first().associateBy { it.name }
        val rows = hits.map { hit ->
            val who = if (hit.role == "user") "คุณ" else agents[hit.agent]?.shownName ?: hit.agent
            // A direct chat has no title of its own: it is called after its agent (as the chat list does).
            val chat = chats.chats.value.firstOrNull { it.id == hit.chatId }
            val title = chat?.title?.takeIf { it.isNotBlank() }
                ?: chat?.agents?.takeIf { it.isNotEmpty() }?.joinToString(", ") { agents[it]?.shownName ?: it }
                ?: hit.chatTitle.ifBlank { "แชต" }
            SearchRow(hit, if (title == who) title else "$title · $who", highlightParts(hit.snippet), shortTime(hit.createdAt))
        }
        _state.value = _state.value.copy(
            rows = rows,
            status = if (rows.isEmpty()) "ไม่พบ \"$text\"" else "พบ ${rows.size} ข้อความ",
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchRoute(onBack: () -> Unit, onOpen: (chatId: Long, sessionId: Long, messageId: Long) -> Unit, viewModel: SearchViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    TextField(
                        value = state.query,
                        onValueChange = viewModel::setQuery,
                        placeholder = { Text("ค้นหาทุกแชต…") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                        shape = RoundedCornerShape(12.dp),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = MimiColors.codeBg,
                            unfocusedContainerColor = MimiColors.codeBg,
                            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                            unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        ),
                        trailingIcon = {
                            if (state.query.isNotEmpty()) IconButton(onClick = { viewModel.setQuery("") }) { Icon(Icons.Default.Close, contentDescription = "ล้าง") }
                        },
                    )
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "กลับ") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            Text(state.status, color = MimiColors.muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.rows, key = { "${it.hit.chatId}-${it.hit.messageId}" }) { row ->
                    Column(
                        Modifier.fillMaxWidth().clickable { onOpen(row.hit.chatId, row.hit.sessionId, row.hit.messageId) }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Row2(row)
                        Text(snippetText(row.parts), color = MimiColors.ink2, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    HorizontalDivider(color = MimiColors.line.copy(alpha = 0.4f))
                }
            }
        }
    }
}

@Composable
private fun Row2(row: SearchRow) {
    androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) {
        Text(row.where, color = MimiColors.accentText, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(row.whenText, color = MimiColors.faint, fontSize = 11.sp)
    }
}

private fun snippetText(parts: List<Pair<String, Boolean>>): AnnotatedString = buildAnnotatedString {
    for ((text, match) in parts) {
        if (match) withStyle(SpanStyle(color = MimiColors.accentText, fontWeight = FontWeight.Bold)) { append(text) } else append(text)
    }
}
