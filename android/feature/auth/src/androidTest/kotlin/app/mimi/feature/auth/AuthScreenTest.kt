package app.mimi.feature.auth

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.mimi.core.ui.MimiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AuthScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun gatewaySignInNeedsUsernameAndPassword() {
        val signedIn = mutableListOf<String>()
        compose.setContent {
            MimiTheme {
                AuthContent(
                    ui = AuthUiState(step = AuthStep.Credentials, server = "https://mimi.test", accounts = true),
                    onServer = {}, onConnect = {}, onRemember = {}, onBack = {},
                    onSignIn = { user, password, _ -> signedIn += "$user/$password" },
                )
            }
        }
        compose.onNodeWithTag("signIn").assertIsNotEnabled()
        compose.onNodeWithTag("username").performTextInput("alice")
        compose.onNodeWithTag("password").performTextInput("secret-1")
        compose.onNodeWithTag("signIn").assertIsEnabled().performClick()
        assertEquals(listOf("alice/secret-1"), signedIn)
    }

    @Test
    fun aServerThatNeedsANewerAppSaysSo() {
        compose.setContent {
            MimiTheme {
                AuthContent(AuthUiState(server = "mimi.test", appTooOld = true), {}, {}, {}, {}, { _, _, _ -> })
            }
        }
        compose.onNodeWithTag("tooOld").assertExists()
        compose.onNodeWithTag("connect").assertIsEnabled()
    }
}
