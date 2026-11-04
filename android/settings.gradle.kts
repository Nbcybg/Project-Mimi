// The native Android app (Kotlin + Jetpack Compose). No WebView: it talks to the Mimi core over
// HTTP + WebSocket as docs/native/ describes. Built by .github/workflows/release.yml.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "mimi-android"

include(":app")
// Shared layers: protocol types (plain Kotlin), data (network, socket, cache, session), UI kit.
include(":core:model", ":core:data", ":core:ui")
// One module per feature, so later phases add screens without touching the others.
include(":feature:auth", ":feature:chat")
