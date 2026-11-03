package app.mimi.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** The web app's dark palette (packages/core/src/server/web/app.css :root). */
object MimiColors {
    val bg = Color(0xFF171215)
    val panel = Color(0xFF20191E)
    val raised = Color(0xFF2A2027)
    val line = Color(0xFF40303A)
    val ink = Color(0xFFF2E7EC)
    val ink2 = Color(0xFFD2BEC8)
    val muted = Color(0xFFA48B97)
    val faint = Color(0xFF7A6470)
    val accent = Color(0xFFE08AA7)
    val accentInk = Color(0xFF2A121B)
    val accentText = Color(0xFFF2AEC3)
    val ok = Color(0xFF7FCF9F)
    val warn = Color(0xFFE1B96C)
    val bad = Color(0xFFF08995)
    val info = Color(0xFF8DB8E8)
    val userBg = Color(0xFF3B2733)
    val userLine = Color(0xFF563746)
    val codeBg = Color(0xFF120E11)
    val act = Color(0xFFD6B98C)
}

private val scheme = darkColorScheme(
    primary = MimiColors.accent,
    onPrimary = MimiColors.accentInk,
    primaryContainer = MimiColors.userBg,
    onPrimaryContainer = MimiColors.ink,
    secondary = MimiColors.info,
    background = MimiColors.bg,
    onBackground = MimiColors.ink,
    surface = MimiColors.panel,
    onSurface = MimiColors.ink,
    surfaceVariant = MimiColors.raised,
    onSurfaceVariant = MimiColors.ink2,
    surfaceContainer = MimiColors.panel,
    surfaceContainerHigh = MimiColors.raised,
    outline = MimiColors.line,
    error = MimiColors.bad,
)

@Composable
fun MimiTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
}
