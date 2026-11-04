// Network, session, socket and repositories of the native app (docs/native).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "app.mimi.core.data"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin { jvmToolchain(17) }

dependencies {
    api(project(":core:model"))
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.security.crypto)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
