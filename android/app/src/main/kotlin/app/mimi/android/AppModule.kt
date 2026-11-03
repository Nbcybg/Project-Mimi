package app.mimi.android

import app.mimi.core.data.AppInfo
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton
    fun info(): AppInfo = AppInfo(versionName = BuildConfig.VERSION_NAME, defaultServer = BuildConfig.MIMI_HOST)
}
