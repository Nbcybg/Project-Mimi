package app.mimi.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

fun spansToAnnotated(spans: List<Span>): AnnotatedString = buildAnnotatedString {
    for (span in spans) when (span) {
        is Span.Plain -> append(span.text)
        is Span.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
        is Span.Action -> withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = MimiColors.act)) { append(span.text) }
        is Span.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = MimiColors.codeBg)) { append(span.text) }
        is Span.Mention -> withStyle(SpanStyle(color = MimiColors.accentText, fontWeight = FontWeight.SemiBold)) { append(span.text) }
        // Opens in the system browser (the app has no WebView).
        is Span.Link -> withLink(LinkAnnotation.Url(span.url, TextLinkStyles(SpanStyle(color = MimiColors.info, textDecoration = TextDecoration.Underline)))) { append(span.url) }
    }
}

/** The text size of chat messages (the chat's own "ขนาดตัวอักษร"); unspecified = the theme's. */
val LocalMessageFontSize = androidx.compose.runtime.compositionLocalOf { androidx.compose.ui.unit.TextUnit.Unspecified }

/**
 * Message text with the web client's formatting. [selectable] lets the person select and copy it; a chat
 * bubble turns it off so a long press reaches the bubble's own menu (reply, copy, react, pin).
 */
@Composable
fun MessageText(text: String, modifier: Modifier = Modifier, selectable: Boolean = true) {
    val blocks = remember(text) { parseBlocks(text) }
    val size = LocalMessageFontSize.current
    val body: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (block in blocks) when (block) {
                is Block.Paragraph -> Text(
                    spansToAnnotated(block.spans),
                    style = MaterialTheme.typography.bodyLarge.let { if (size != androidx.compose.ui.unit.TextUnit.Unspecified) it.copy(fontSize = size, lineHeight = size * 1.5f) else it },
                    color = androidx.compose.material3.LocalContentColor.current,
                )
                is Block.Code -> Text(
                    block.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = MimiColors.ink2,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MimiColors.codeBg, RoundedCornerShape(8.dp))
                        .horizontalScroll(rememberScrollState())
                        .padding(10.dp),
                )
            }
        }
    }
    if (selectable) SelectionContainer(modifier) { body() } else androidx.compose.foundation.layout.Box(modifier) { body() }
}
