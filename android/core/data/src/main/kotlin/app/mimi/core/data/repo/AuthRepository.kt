package app.mimi.core.data.repo

import app.mimi.core.data.Session
import app.mimi.core.data.SessionStore
import app.mimi.core.data.net.MimiHttpException
import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.net.ServerAddress
import app.mimi.core.data.net.defaultStatusMessage
import app.mimi.core.data.net.httpCall
import app.mimi.core.data.net.toError
import app.mimi.core.model.CLIENT_API
import app.mimi.core.model.ErrorBody
import app.mimi.core.model.Health
import app.mimi.core.model.LoginRequest
import app.mimi.core.model.LoginResponse
import app.mimi.core.model.MimiJson
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

sealed interface ProbeResult {
    data class Ok(val server: String, val health: Health) : ProbeResult
    data class AppTooOld(val server: String, val health: Health) : ProbeResult
    data class Failed(val message: String) : ProbeResult
}

sealed interface SignInResult {
    data object Success : SignInResult
    data class NeedsCode(val message: String) : SignInResult
    data class Failed(val message: String) : SignInResult
}

/** Signing in to a core (one token) or a gateway (username, password, 2FA code). */
interface AuthActions {
    suspend fun probe(input: String): ProbeResult
    suspend fun signInWithPassword(username: String, password: String, code: String?, remember: Boolean): SignInResult
    suspend fun signInWithToken(token: String, remember: Boolean): SignInResult
}

/**
 * Connecting and signing in (docs/native/auth-and-session.md): `/health` says whether the server is
 * a single core or the accounts gateway. The password is only held for the sign-in call and is
 * never stored; on success only the token enters the [SessionStore], and only when `remember`.
 */
@Singleton
class AuthRepository @Inject constructor(
    private val client: OkHttpClient,
    private val sessions: SessionStore,
    private val socket: MimiSocket,
) : AuthActions {
    private val http = client.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()
    private val shortHttp = client.newBuilder().callTimeout(5, TimeUnit.SECONDS).build()

    @Volatile
    private var checkedServer: String? = null

    @Volatile
    private var gateway: Boolean? = null

    override suspend fun probe(input: String): ProbeResult {
        val server = try {
            ServerAddress.normalize(input)
        } catch (invalid: IllegalArgumentException) {
            return ProbeResult.Failed(invalid.message ?: "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง")
        }
        val health = try {
            httpCall {
                val request = Request.Builder().url("$server/health").get().build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw response.toError()
                    val text = response.body?.string().orEmpty()
                    MimiJson.decodeFromString(Health.serializer(), text)
                }
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: MimiHttpException) {
            return ProbeResult.Failed(
                if (error.status == 0) error.message ?: UNREACHABLE else "ไม่ใช่เซิร์ฟเวอร์ Mimi หรือเซิร์ฟเวอร์ไม่พร้อมใช้งาน",
            )
        } catch (error: SerializationException) {
            return ProbeResult.Failed("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง")
        } catch (error: IOException) {
            return ProbeResult.Failed(UNREACHABLE)
        }
        if (!health.ok) return ProbeResult.Failed("ไม่ใช่เซิร์ฟเวอร์ Mimi หรือเซิร์ฟเวอร์ไม่พร้อมใช้งาน")
        checkedServer = server
        gateway = health.accounts
        return if (health.minClientApi > CLIENT_API) ProbeResult.AppTooOld(server, health)
        else ProbeResult.Ok(server, health)
    }

    override suspend fun signInWithPassword(username: String, password: String, code: String?, remember: Boolean): SignInResult {
        val server = currentServer() ?: return SignInResult.Failed("เลือกเซิร์ฟเวอร์ก่อน")
        val request = LoginRequest(
            username = username.trim(),
            password = password,
            code = code?.trim()?.takeIf { it.isNotEmpty() },
        )
        return try {
            val reply = httpCall {
                val body = MimiJson.encodeToString(LoginRequest.serializer(), request).toRequestBody(JSON)
                val httpRequest = Request.Builder().url("$server/auth/login").post(body).build()
                http.newCall(httpRequest).execute().use { response ->
                    val text = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        val error = runCatching { MimiJson.decodeFromString(ErrorBody.serializer(), text) }.getOrNull()
                        throw MimiHttpException(
                            response.code,
                            error?.error?.takeIf { it.isNotBlank() } ?: defaultStatusMessage(response.code),
                            error?.twoFactor == true,
                        )
                    }
                    MimiJson.decodeFromString(LoginResponse.serializer(), text)
                }
            }
            sessions.save(
                Session(server, reply.token, reply.username.ifBlank { username.trim() }),
                remember,
            )
            SignInResult.Success
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: MimiHttpException) {
            when {
                error.twoFactor -> SignInResult.NeedsCode(
                    error.message?.takeIf { it.isNotBlank() } ?: "ใส่รหัส 6 หลักจากแอป authenticator (หรือรหัสกู้คืน)",
                )
                error.status == 401 -> SignInResult.Failed("ชื่อผู้ใช้ รหัสผ่าน หรือรหัสไม่ถูกต้อง")
                error.status == 429 -> SignInResult.Failed("ลองผิดหลายครั้งเกินไป รอสักพักแล้วลองใหม่")
                error.status == 503 -> SignInResult.Failed("เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง")
                else -> SignInResult.Failed(error.message ?: defaultStatusMessage(error.status))
            }
        } catch (error: SerializationException) {
            SignInResult.Failed("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง")
        } catch (error: IOException) {
            SignInResult.Failed("ติดต่อเซิร์ฟเวอร์ไม่ได้: ${error.message ?: "เครือข่ายขัดข้อง"}")
        }
    }

    override suspend fun signInWithToken(token: String, remember: Boolean): SignInResult {
        val server = currentServer() ?: return SignInResult.Failed("เลือกเซิร์ฟเวอร์ก่อน")
        val value = token.trim()
        if (value.isEmpty()) return SignInResult.Failed("ใส่รหัสผ่านของ Mimi (MIMI_TOKEN ของเครื่องที่รัน core)")
        return try {
            httpCall {
                val request = Request.Builder()
                    .url("$server/api/widget")
                    .header("Authorization", "Bearer $value")
                    .get()
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw response.toError()
                }
            }
            sessions.save(Session(server, value, ""), remember)
            SignInResult.Success
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: MimiHttpException) {
            if (error.status == 401) SignInResult.Failed("รหัสผ่านไม่ถูกต้อง (หรือผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่)")
            else SignInResult.Failed(error.message ?: defaultStatusMessage(error.status))
        } catch (error: IOException) {
            SignInResult.Failed("ติดต่อเซิร์ฟเวอร์ไม่ได้: ${error.message ?: "เครือข่ายขัดข้อง"}")
        }
    }

    /**
     * Signs out in the order the web used (auth-and-session.md 9): the caller unregisters push
     * first (it needs the token), then a gateway session is ended, then the token is forgotten and
     * the socket closed. Failures on the way never block the sign-out.
     */
    suspend fun signOut(beforeClear: suspend () -> Unit = {}) {
        runCatching { beforeClear() }
        val session = sessions.session.value
        if (session.server.isNotBlank() && session.token != null && gateway != false) {
            runCatching {
                httpCall {
                    val request = Request.Builder()
                        .url(session.server.trimEnd('/') + "/auth/logout")
                        .header("Authorization", "Bearer ${session.token}")
                        .post(ByteArray(0).toRequestBody(null))
                        .build()
                    shortHttp.newCall(request).execute().use { }
                }
            }
        }
        sessions.signOut()
        socket.stop()
    }

    private fun currentServer(): String? =
        checkedServer ?: sessions.session.value.server.takeIf { it.isNotBlank() }

    private companion object {
        const val UNREACHABLE = "ติดต่อเซิร์ฟเวอร์นี้ไม่ได้ หรือไม่ใช่เซิร์ฟเวอร์ Mimi"
        val JSON = "application/json".toMediaType()
    }
}
