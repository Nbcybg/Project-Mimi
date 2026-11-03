package app.mimi.feature.auth

import app.mimi.core.data.AppInfo
import app.mimi.core.data.MemorySessionStore
import app.mimi.core.data.repo.AuthActions
import app.mimi.core.data.repo.ProbeResult
import app.mimi.core.data.repo.SignInResult
import app.mimi.core.model.Health
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AuthViewModelTest {
    private class FakeAuth(var health: Health, val answers: ArrayDeque<SignInResult>) : AuthActions {
        val calls = mutableListOf<String>()
        override suspend fun probe(input: String): ProbeResult =
            if (health.minClientApi > 1) ProbeResult.AppTooOld("https://$input", health) else ProbeResult.Ok("https://$input", health)
        override suspend fun signInWithPassword(username: String, password: String, code: String?, remember: Boolean): SignInResult {
            calls += "password:$username:${code ?: "-"}:$remember"
            return answers.removeFirst()
        }
        override suspend fun signInWithToken(token: String, remember: Boolean): SignInResult {
            calls += "token:$remember"
            return answers.removeFirst()
        }
    }

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun viewModel(auth: AuthActions) = AuthViewModel(auth, MemorySessionStore(), AppInfo("1.0.0", "mimi.example.com"))

    @Test
    fun `a gateway asks for username and password, then the authenticator code`() {
        val auth = FakeAuth(Health(ok = true, accounts = true, api = 1), ArrayDeque(listOf(SignInResult.NeedsCode("ใส่รหัส"), SignInResult.Success)))
        val vm = viewModel(auth)
        assertEquals("mimi.example.com", vm.ui.value.server)
        vm.connect()
        assertEquals(AuthStep.Credentials, vm.ui.value.step)
        assertTrue(vm.ui.value.accounts)
        vm.signIn("alice", "pw", "")
        assertTrue(vm.ui.value.askCode)
        vm.signIn("alice", "pw", "123456")
        assertTrue(vm.ui.value.signedIn)
        assertEquals(listOf("password:alice:-:true", "password:alice:123456:true"), auth.calls)
    }

    @Test
    fun `a one-person core takes its token and not-my-device does not remember it`() {
        val auth = FakeAuth(Health(ok = true, api = 1), ArrayDeque(listOf(SignInResult.Failed("ผิด"), SignInResult.Success)))
        val vm = viewModel(auth)
        vm.connect()
        vm.setRemember(false)
        vm.signIn("", "wrong", "")
        assertEquals("ผิด", vm.ui.value.error)
        vm.signIn("", "right", "")
        assertTrue(vm.ui.value.signedIn)
        assertEquals(listOf("token:false", "token:false"), auth.calls)
    }

    @Test
    fun `a core that needs a newer app says so and stays on the server step`() {
        val vm = viewModel(FakeAuth(Health(ok = true, api = 3, minClientApi = 2), ArrayDeque()))
        vm.connect()
        assertTrue(vm.ui.value.appTooOld)
        assertEquals(AuthStep.Server, vm.ui.value.step)
    }
}
