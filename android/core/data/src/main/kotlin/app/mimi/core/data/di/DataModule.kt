package app.mimi.core.data.di

import android.content.Context
import app.mimi.core.data.AppInfo
import app.mimi.core.data.PersistentSessionStore
import app.mimi.core.data.SessionStore
import app.mimi.core.data.repo.AuthActions
import app.mimi.core.data.repo.AuthRepository
import app.mimi.core.data.repo.PushRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import javax.inject.Qualifier
import javax.inject.Singleton

/** The application-wide scope for work that outlives one screen (the socket, the repositories). */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class AppScope

@Module
@InstallIn(SingletonComponent::class)
object DataModule {
    @Provides
    @Singleton
    @AppScope
    fun appScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Provides
    @Singleton
    fun sessionStore(@ApplicationContext context: Context): SessionStore = PersistentSessionStore(context)

    /**
     * One client for the core, the widget and Coil. The Bearer token is attached only to requests
     * for the signed-in server's host (never to GitHub for the update check or any other host),
     * and only when the caller did not already choose a token.
     */
    @Provides
    @Singleton
    fun httpClient(sessions: SessionStore): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val request = chain.request()
            val session = sessions.session.value
            val token = session.token
            val host = session.server.toHttpUrlOrNull()?.host
            if (token != null && host != null && request.url.host.equals(host, ignoreCase = true) && request.header("Authorization") == null) {
                chain.proceed(request.newBuilder().header("Authorization", "Bearer $token").build())
            } else {
                chain.proceed(request)
            }
        }
        .build()

    @Provides
    @Singleton
    fun authActions(repository: AuthRepository): AuthActions = repository

    @Provides
    @Singleton
    fun pushRepository(
        @ApplicationContext context: Context,
        client: OkHttpClient,
        sessions: SessionStore,
        info: AppInfo,
    ): PushRepository = PushRepository(client, sessions, info, context)
}
