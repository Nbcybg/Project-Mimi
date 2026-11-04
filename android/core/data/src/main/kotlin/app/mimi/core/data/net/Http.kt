package app.mimi.core.data.net

import app.mimi.core.model.ErrorBody
import app.mimi.core.model.MimiJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/** A refusal of the server, with its own message (`{"error": …}`, api-contract.md 0). */
class MimiHttpException(
    val status: Int,
    message: String,
    val twoFactor: Boolean = false,
    cause: Throwable? = null,
) : Exception(message, cause)

/** The message of a failed `/api/...` answer, or a readable one for the status. */
internal fun Response.toError(): MimiHttpException {
    val text = runCatching { body?.string() }.getOrNull().orEmpty()
    val error = runCatching { MimiJson.decodeFromString(ErrorBody.serializer(), text) }.getOrNull()
    val message = error?.error?.takeIf { it.isNotBlank() } ?: defaultStatusMessage(code)
    return MimiHttpException(code, message, error?.twoFactor == true)
}

internal fun defaultStatusMessage(status: Int): String = when (status) {
    401 -> "รหัสผ่านหรือ token ไม่ถูกต้อง"
    403 -> "ไม่มีสิทธิ์เข้าถึงข้อมูลนี้"
    404 -> "ไม่พบข้อมูลบนเซิร์ฟเวอร์"
    410 -> "ไฟล์นี้ถูกลบตามระยะเวลาเก็บแล้ว"
    413 -> "ไฟล์ใหญ่เกิน 25 MB"
    429 -> "ลองผิดหลายครั้งเกินไป รอสักพักแล้วลองใหม่"
    500 -> "เซิร์ฟเวอร์ขัดข้อง"
    502 -> "ติดต่อ Mimi core ไม่ได้ในขณะนี้"
    503 -> "เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง"
    507 -> "พื้นที่เก็บไฟล์ในแชตเต็มแล้ว"
    else -> "เซิร์ฟเวอร์ตอบกลับผิดพลาด (HTTP $status)"
}

/** Runs a blocking HTTP call on the IO pool and turns network failures into a readable error. */
internal suspend fun <T> httpCall(block: () -> T): T = withContext(Dispatchers.IO) {
    try {
        block()
    } catch (error: IOException) {
        throw MimiHttpException(0, "ติดต่อเซิร์ฟเวอร์ไม่ได้: ${error.message ?: "เครือข่ายขัดข้อง"}", cause = error)
    }
}

/** Executes a request and returns its successful body text, or throws [MimiHttpException]. */
internal fun OkHttpClient.callText(request: Request): String = newCall(request).execute().use { response ->
    if (!response.isSuccessful) throw response.toError()
    response.body?.string().orEmpty()
}
