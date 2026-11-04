package app.mimi.core.data.net

/** Where the one connection to `/ws` stands (realtime.md 2 and 7). */
sealed interface SocketState {
    data object Idle : SocketState
    data object Connecting : SocketState

    /** Waiting out a `4029` rate limit (about 15 minutes). */
    data object RateLimited : SocketState

    /** Close `4003`: the token no longer works. Never retried. */
    data object SignedOut : SocketState

    /** Close `4426`: this app is older than the core serves. Never retried. */
    data object AppTooOld : SocketState

    data class Online(val version: String?, val api: Int) : SocketState

    /** Lost; the socket tries again by itself. */
    data class Offline(val reason: String) : SocketState

    /** The core answered `welcome` with an API older than [app.mimi.core.model.MIN_SUPPORTED_CORE_API]. */
    data class CoreTooOld(val api: Int) : SocketState
}
