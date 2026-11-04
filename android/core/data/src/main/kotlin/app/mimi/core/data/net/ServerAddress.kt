package app.mimi.core.data.net

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** What the person typed, turned into the origin of a Mimi server (api-contract.md 0). */
object ServerAddress {
    /**
     * `mimi.example.com` becomes `https://mimi.example.com`; an explicit `http://` stays, a trailing
     * slash, path, query or fragment is dropped. Throws [IllegalArgumentException] with a Thai message.
     */
    fun normalize(raw: String): String {
        val typed = raw.trim()
        require(typed.isNotEmpty()) { "ใส่ที่อยู่เซิร์ฟเวอร์ เช่น https://mimi.example.com" }
        val withScheme = if (typed.contains("://")) typed else "https://$typed"
        val url = withScheme.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("ที่อยู่ไม่ถูกต้อง ใส่แบบ https://mimi.example.com")
        require(url.host.isNotBlank()) { "ที่อยู่ไม่ถูกต้อง ใส่แบบ https://mimi.example.com" }
        require(url.username.isEmpty() && url.password.isEmpty()) { "ที่อยู่ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่านอยู่ข้างใน" }
        val origin = url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString()
        return origin.trimEnd('/')
    }

    /** The socket of a server: `ws(s)://host/ws`. Throws [IllegalArgumentException] for a bad address. */
    fun socket(server: String): String {
        val url = server.toHttpUrlOrNull() ?: throw IllegalArgumentException("ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง")
        val http = url.newBuilder().encodedPath("/ws").query(null).fragment(null).build().toString()
        return http.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
    }
}
