package app.mimi.android

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.mimi.core.data.SessionStore
import app.mimi.core.data.repo.AuthRepository
import app.mimi.core.data.repo.PushRepository
import app.mimi.core.ui.MimiColors
import app.mimi.core.ui.MimiTheme
import app.mimi.feature.auth.AuthRoute
import app.mimi.feature.chat.ChatListRoute
import app.mimi.feature.chat.ChatRoute
import app.mimi.feature.mimiamp.MimiampCommands
import app.mimi.feature.mimiamp.MimiampRoute
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The whole app in Compose (no WebView): sign-in → chats → chat, and Mimiamp. */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var sessions: SessionStore
    @Inject lateinit var auth: AuthRepository
    @Inject lateinit var push: PushRepository
    @Inject lateinit var updates: UpdateChecker
    @Inject lateinit var mimiamp: MimiampCommands

    /** A notification, widget row or the media notification pointed somewhere. */
    private val deepLinks = MutableSharedFlow<Intent>(replay = 1, extraBufferCapacity = 4)
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent {
            MimiTheme {
                val navController = rememberNavController()
                val session by sessions.session.collectAsStateWithLifecycle()
                val scope = rememberCoroutineScope()
                LaunchedEffect(Unit) {
                    updates.check(BuildConfig.VERSION_NAME)
                    deepLinks.tryEmit(intent)
                }
                LaunchedEffect(Unit) { deepLinks.collect { follow(navController, it) } }
                LaunchedEffect(Unit) { mimiamp.open.collect { navController.navigate("mimiamp") { launchSingleTop = true } } }
                // Signed out by the core (expired, revoked): back to the sign-in screen.
                LaunchedEffect(session.token) {
                    if (session.token == null && navController.currentDestination?.route != "auth") {
                        navController.navigate("auth") { popUpTo(0) }
                    }
                }
                NavHost(navController, startDestination = if (session.token != null) "chats" else "auth") {
                    composable("auth") {
                        AuthRoute(onSignedIn = {
                            (application as MimiApp).signedIn()
                            navController.navigate("chats") { popUpTo("auth") { inclusive = true } }
                        })
                    }
                    composable("chats") {
                        ChatListRoute(
                            onOpenChat = { navController.navigate("chat/$it") },
                            onMimiamp = { navController.navigate("mimiamp") },
                            onSignOut = {
                                scope.launch {
                                    (application as MimiApp).signedOut()
                                    auth.signOut { push.unregister() }
                                    navController.navigate("auth") { popUpTo(0) }
                                }
                            },
                            banner = { UpdateBanner(updates) },
                        )
                    }
                    composable("chat/{chatId}", arguments = listOf(navArgument("chatId") { type = NavType.LongType })) {
                        ChatRoute(onBack = { navController.popBackStack() })
                    }
                    composable("mimiamp") { MimiampRoute(onBack = { navController.popBackStack() }) }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        deepLinks.tryEmit(intent)
    }

    private fun follow(navController: NavHostController, intent: Intent?) {
        if (intent == null || sessions.session.value.token == null) return
        val chat = intent.getLongExtra("chat", 0)
        when {
            chat > 0 -> navController.navigate("chat/$chat") { launchSingleTop = true }
            intent.getStringExtra("open") == "mimiamp" -> navController.navigate("mimiamp") { launchSingleTop = true }
        }
        intent.removeExtra("chat")
        intent.removeExtra("open")
    }

    @Composable
    private fun UpdateBanner(updates: UpdateChecker) {
        val update by updates.update.collectAsStateWithLifecycle()
        val found = update ?: return
        Row(
            Modifier.fillMaxWidth().background(MimiColors.raised).clickable {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(found.url)))
            }.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("มีแอป Mimi เวอร์ชันใหม่ ${found.version} — แตะเพื่อดาวน์โหลด", modifier = Modifier.weight(1f), color = MimiColors.accentText)
            TextButton(onClick = updates::dismiss) { Text("ปิด") }
        }
    }
}
