package app.mimi.feature.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.mimi.core.data.AppInfo
import app.mimi.core.data.SessionStore
import app.mimi.core.data.repo.AuthActions
import app.mimi.core.data.repo.ProbeResult
import app.mimi.core.data.repo.SignInResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class AuthStep { Server, Credentials }

data class AuthUiState(
    val step: AuthStep = AuthStep.Server,
    val server: String = "",
    /** The accounts gateway: username + password; otherwise the core's one token. */
    val accounts: Boolean = false,
    val coreVersion: String = "",
    val askCode: Boolean = false,
    val remember: Boolean = true,
    val busy: Boolean = false,
    val error: String? = null,
    /** The server needs a newer app (its minClientApi is above ours). */
    val appTooOld: Boolean = false,
    val signedIn: Boolean = false,
)

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val auth: AuthActions,
    sessions: SessionStore,
    info: AppInfo,
) : ViewModel() {
    private val state = MutableStateFlow(
        AuthUiState(server = sessions.session.value.server.ifEmpty { info.defaultServer }),
    )
    val ui: StateFlow<AuthUiState> = state.asStateFlow()

    fun setServer(value: String) = state.update { it.copy(server = value, error = null) }
    fun setRemember(value: Boolean) = state.update { it.copy(remember = value) }
    fun back() = state.update { it.copy(step = AuthStep.Server, askCode = false, error = null) }

    fun connect() {
        if (state.value.busy) return
        state.update { it.copy(busy = true, error = null, appTooOld = false) }
        viewModelScope.launch {
            when (val result = auth.probe(state.value.server)) {
                is ProbeResult.Ok -> state.update {
                    it.copy(busy = false, step = AuthStep.Credentials, server = result.server, accounts = result.health.accounts, coreVersion = result.health.version)
                }
                is ProbeResult.AppTooOld -> state.update { it.copy(busy = false, appTooOld = true, server = result.server) }
                is ProbeResult.Failed -> state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    fun signIn(username: String, password: String, code: String) {
        if (state.value.busy) return
        state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val current = state.value
            val result = if (current.accounts) auth.signInWithPassword(username, password, code.takeIf { current.askCode }, current.remember)
                else auth.signInWithToken(password, current.remember)
            state.update {
                when (result) {
                    SignInResult.Success -> it.copy(busy = false, signedIn = true)
                    is SignInResult.NeedsCode -> it.copy(busy = false, askCode = true, error = result.message)
                    is SignInResult.Failed -> it.copy(busy = false, error = result.message)
                }
            }
        }
    }
}
