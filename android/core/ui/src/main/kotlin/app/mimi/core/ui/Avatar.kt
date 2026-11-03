package app.mimi.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage

/** An agent's round picture (loaded with the token by the app's image loader), or its first letter. */
@Composable
fun Avatar(name: String, url: String?, size: Dp = 40.dp, modifier: Modifier = Modifier) {
    val letter: @Composable () -> Unit = {
        Box(Modifier.size(size).clip(CircleShape).background(MimiColors.raised), contentAlignment = Alignment.Center) {
            Text(name.take(1).uppercase(), color = MimiColors.accentText, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp)
        }
    }
    if (url == null) {
        Box(modifier) { letter() }
        return
    }
    SubcomposeAsyncImage(
        model = url,
        contentDescription = name,
        contentScale = ContentScale.Crop,
        modifier = modifier.size(size).clip(CircleShape),
        loading = { letter() },
        error = { letter() },
    )
}
