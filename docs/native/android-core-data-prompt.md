# Prompt: rebuild the missing `android/core/data` module

Copy everything below the line into the helper. Written 2026-11-04 from reading every call site in the repo.

---

## Task

The Android app in `android/` (Kotlin, Jetpack Compose, Hilt, no WebView) is missing its Gradle module **`:core:data`**
(`android/core/data/`). It was lost (the old `.gitignore` excluded any folder named `data/`; no copy exists on the Mac
that holds this checkout, in `_old/`, or in the zips in Downloads). Every other module is intact: `:core:model`,
`:core:ui`, `:feature:auth`, `:feature:chat`, `:app`. **Write `:core:data` from scratch so the whole project builds
(`./gradlew :app:assembleDebug`) and its existing tests pass. Do not change other modules' code unless a call site is
truly impossible to satisfy; if you must, say exactly what and why.**

Environment: JDK 17 (Temurin), Android SDK at `~/Library/Android/sdk` (platforms 35, 36; create
`android/local.properties` with `sdk.dir=...` if needed), Gradle wrapper `android/gradlew`, versions in
`android/gradle/libs.versions.toml` (AGP 8.7.3, Kotlin 2.0.21, KSP, Hilt 2.52, OkHttp 4.12, kotlinx-serialization 1.7.3,
coroutines 1.9, security-crypto 1.1.0-alpha06, WorkManager). Already registered in `android/settings.gradle.kts`.
The project has **no git history**; do not run git commands.

## Read first

- `docs/native/api-contract.md` (HTTP and WebSocket commands), `docs/native/realtime.md` (handshake, reconnect,
  presence, streaming), `docs/native/auth-and-session.md` (login), `docs/native/push-and-background.md`,
  `docs/native/api-versioning.md`.
- `android/core/model/src/main/kotlin/app/mimi/core/model/`: `Models.kt`, `Frames.kt` (`parseServerFrame`,
  `ClientFrames.*` builders, `ServerFrame`), `ChatTimeline.kt` (pure reducer `ChatTimeline.reduce(frame)`,
  `addPending`), `MimiJson`, `CLIENT_API`, `CloseCodes`, `MIN_SUPPORTED_CORE_API`. **Reuse these; do not redefine
  protocol types.**
- Reference implementation of the same layer in C#: `apps/windows/src/Mimi.Core/` (`MimiSession.cs`, `Net/`,
  `Chat/ChatTimeline.cs`, `Desktop/SessionVault.cs`, `ViewModels/`). Same server, same protocol; port the behaviour,
  not the code style.

## Module setup

`android/core/data/build.gradle.kts`: Android **library**, namespace `app.mimi.core.data`, compileSdk 35, minSdk 23,
Java/Kotlin 17, plugins as in `feature/chat/build.gradle.kts` (android.library, kotlin.android, ksp, hilt).
`api(project(":core:model"))`, plus okhttp, coroutines-android, serialization-json, hilt-android (+ ksp compiler),
security-crypto, work-runtime if needed. Source root `src/main/kotlin/app/mimi/core/data/`. Add unit tests
(JUnit4, coroutines-test, okhttp-mockwebserver) under `src/test`.

## Required public API (inferred from every call site; match exactly)

Package `app.mimi.core.data`:

- `data class AppInfo(val versionName: String, val defaultServer: String)` (constructed positionally in tests:
  `AppInfo("1.0.0", "mimi.example.com")`).
- `data class Session(val server: String = "", val token: String? = null, val username: String = "")` (field names
  are used: `.server`, `.token`, `.username`).
- `interface SessionStore { val session: StateFlow<Session>; ... }` with `fun signOut()` (called from `MimiApp`) and
  whatever save/update method you need. `class MemorySessionStore() : SessionStore` (no-arg, in-memory, used by tests).
  Production implementation persists in `EncryptedSharedPreferences` (token must never be logged or stored in plain
  prefs); survives process death.
- `package app.mimi.core.data.di`: `@Qualifier annotation class AppScope`, and a Hilt module (`@InstallIn(SingletonComponent)`)
  providing: `@AppScope CoroutineScope` (SupervisorJob + Default), `OkHttpClient`, `SessionStore`, `MimiSocket`,
  `ChatRepository`, `FileRepository`, `PushRepository`, `AuthRepository`/`AuthActions`. `app/.../AppModule.kt`
  already provides `AppInfo`; do not duplicate it. `MimiApp` injects `OkHttpClient`, `SessionStore`, `MimiSocket`,
  `ChatRepository`, `PushRepository`, `@AppScope CoroutineScope`; `WidgetSync` injects `FileRepository` and
  `OkHttpClient`; `MainActivity` injects `SessionStore`, `AuthRepository`, `PushRepository`.
  The `OkHttpClient` is also used by Coil for pictures, so its interceptor must add `Authorization: Bearer <token>`
  **only to requests for the signed-in server's host** (never to GitHub or other hosts: `UpdateChecker` uses the same client).

`app.mimi.core.data.net`:

- `sealed interface SocketState`: **objects** `Idle`, `Connecting`, `RateLimited`, `SignedOut`, `AppTooOld`;
  **classes** `Online(...)`, `Offline(...)`, `CoreTooOld(...)` (matched with `is`; choose useful fields, e.g.
  `Offline(reason)`, `CoreTooOld(api: Int)`, `Online(version, api)`).
- `class MimiSocket` (`@Singleton`): `val state: StateFlow<SocketState>`, `fun start()`, `fun stop()`, `fun wake()`
  (app came to foreground: if no traffic for >12 s close and reconnect now, else send `presence` and re-open the
  current chat), a `Flow<ServerFrame>` of incoming frames and `fun send(json: String): Boolean`.
  Behaviour per `realtime.md` section 7: URL `wss://<host>/ws` (`ws://` for http), first frame `ClientFrames.hello(token, versionName)`,
  wait for `welcome`; then request the data the app needs (`chats-list`, agents, `presence`, `chat-open` of the open chat);
  app-level `ping` every ~25 s; reconnect with backoff 1 s doubling to 15 s, reset on success; **do not reconnect on
  close 4003** (state `SignedOut`); 4029 (state `RateLimited`) wait ~15 min; 4426 (state `AppTooOld`); welcome with
  `api < MIN_SUPPORTED_CORE_API` gives `CoreTooOld`; 4502 and 1013 reconnect with backoff.
  A frame `security-alert` is surfaced too (the UI may use it later).

`app.mimi.core.data.repo`:

- `interface AuthActions { suspend fun probe(input: String): ProbeResult; suspend fun signInWithPassword(username: String, password: String, code: String?, remember: Boolean): SignInResult; suspend fun signInWithToken(token: String, remember: Boolean): SignInResult }`
  (signatures fixed by `AuthViewModelTest`'s fake).
- `sealed interface ProbeResult { Ok(server: String, health: Health); AppTooOld(server: String, health: Health); Failed(message: String) }`
  `probe` normalises user input (`mimi.example.com` becomes `https://mimi.example.com`, keep explicit `http://`, strip
  trailing slash/path), `GET /health`, returns `AppTooOld` when `health.minClientApi > CLIENT_API`.
- `sealed interface SignInResult { object Success; class NeedsCode(message: String); class Failed(message: String) }`
  (`Success` is used as a bare object: `SignInResult.Success`).
  Gateway (`health.accounts`): `POST /auth/login` JSON `LoginRequest`, 401 + `twoFactor:true` gives `NeedsCode`,
  429/503/other errors give `Failed` with a Thai-friendly message. Core (single user): the token is tested with
  `GET /api/widget` (401 gives `Failed`). On success save `Session(server, token, username)` only if `remember`
  is true, otherwise keep it in memory for the process only.
- `class AuthRepository : AuthActions` with `suspend fun signOut(beforeClear: suspend () -> Unit = {})`: runs the
  lambda first (the caller passes `push.unregister()`, it needs the token), then `POST /auth/logout` on a gateway
  (ignore failures), then `sessions.signOut()` and `socket.stop()`.
- `class ChatRepository` (`@Singleton`) feeding from `MimiSocket` frames:
  `val chats: StateFlow<List<ChatView>>`, `val agents: Flow<List<AgentView>>` (StateFlow ok),
  `val busyChats: Flow<Set<Long>>` (from `welcome.busyChats` and `busy` frames),
  `fun open(chatId: Long): Flow<ChatTimeline>` (keeps one `ChatTimeline(chatId)` per open chat, folds every frame with
  `reduce`, sends `chat-open` on collect and again after reconnect, re-fetches with `afterId` when the socket
  returns, and for API-0 cores re-opens the chat after a turn ends),
  `suspend fun directChat(agent: String): Long?` (`chat-create` direct, wait for `chat-history`; null on timeout),
  `fun presence(chatId: Long?, visible: Boolean)`, `fun loadOlder(chatId: Long)` (`chat-open` with `beforeId`),
  `fun send(chatId: Long, text: String, attachmentIds: List<String>, attachmentNames: List<String>)` (add a
  `PendingMessage` with a fresh `clientId` via `addPending`, then `ClientFrames.chatSend`),
  `fun abort(chatId: Long)`, `fun answerPermission(requestId: String, allow: Boolean, scope: String)`,
  `fun decideApproval(id: Long, approved: Boolean)`. Non-suspend methods must not block (use `@AppScope`).
- `class FileRepository`: `fun url(path: String): String` (server-relative path to absolute URL; empty server gives
  the path unchanged), `fun fileUrl(attachment: AttachmentView): String` (`/api/files/<id>`),
  `suspend fun upload(name: String, mime: String, bytes: ByteArray): AttachmentView`
  (`POST /api/upload?name=<url-encoded>`, raw bytes, `Content-Type: mime`, max 25 MB; throw with a readable message
  on 413/507), `suspend fun download(attachment: AttachmentView): File` (to `cacheDir`, reuse if present, 410 means removed),
  `suspend fun widget(): WidgetView?` (`GET /api/widget`, null on failure).
- `class PushRepository`: `suspend fun register(token: String, label: String)` (`POST /api/push/register`
  with `NativePushRegistration(platform="fcm", token, label, appVersion)`), `suspend fun unregister()` (the saved token),
  `suspend fun newNotifications(): List<NotificationSyncItem>` (`GET /api/notifications?afterId=<last>`, remember the
  highest id in prefs, first call `afterId=0` but do not replay old notifications: return only unread ones on the
  first run, then everything newer than the remembered id).

If another file in `app/` or `feature/` uses a symbol not listed above (the compiler will tell you), add it with the
signature the call site implies. Known consumers: `feature/chat/.../ChatViewModels.kt`, `ChatScreen.kt`,
`ChatListScreen.kt`, `feature/auth/.../AuthViewModel.kt`, `app/.../MimiApp.kt`, `MainActivity.kt`, `widget/WidgetSync.kt`,
`push/MimiMessagingService.kt`, `push/NotificationWorker.kt`, `Notifier.kt`.

## Rules

- All HTTP and WS errors must end as a typed result or a readable Thai/English message, never an uncaught crash.
- Never send the token to a host other than the signed-in server. Never log tokens. Respect `4003`/`401`: do not
  retry with a token the server rejected (it would trip the server's rate limit).
- Server may be older (no `api` in `/health`) or newer (unknown frames): ignore unknown fields/frames
  (`MimiJson` and `ServerFrame.Unknown` already do).
- Keep the Mimiamp music feature out; it was removed on purpose (no `/mimiamp/*`).

## Done when

1. `cd android && ./gradlew :core:model:test :core:ui:testDebugUnitTest :core:data:testDebugUnitTest :feature:auth:testDebugUnitTest :feature:chat:testDebugUnitTest :app:testDebugUnitTest` passes.
2. `./gradlew :app:assembleDebug` produces an APK.
3. Unit tests exist for: probe URL normalisation, login result mapping (200 / 401 twoFactor / 401 / 429), the
   socket reconnect/backoff decisions (4003 stops, 4029 waits), `send` creating a pending message, and `newNotifications`
   id bookkeeping, using MockWebServer or fakes.
4. Report: files written, any call site you could not satisfy, and anything untested against a real core (a real
   end-to-end run needs a Mimi server: `npm run` from the repo root; see `README.md`).
