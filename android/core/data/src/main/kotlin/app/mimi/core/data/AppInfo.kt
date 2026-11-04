package app.mimi.core.data

/** What the app knows about itself; the shell (`:app`) provides it from `BuildConfig`. */
data class AppInfo(val versionName: String, val defaultServer: String)
