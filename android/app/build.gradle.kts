plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// The server offered on the first start, e.g. -PmimiHost=mimi.example.com (https).
val mimiHost = (findProperty("mimiHost") ?: "mimi-production-c4c7.up.railway.app").toString()
val appVersion = (findProperty("versionName") ?: "0.0.0").toString()
val appCode = (findProperty("versionCode") ?: "1").toString().toInt()
// Firebase Cloud Messaging without google-services.json: the app's Firebase ids come from
// properties (-PfcmProjectId=… -PfcmAppId=… -PfcmApiKey=… -PfcmSenderId=…). Without them the
// app polls the core for notifications instead (docs/native/push-and-background.md).
fun prop(name: String) = (findProperty(name) ?: System.getenv(name.uppercase()) ?: "").toString()
// Release signing: the same PKCS#12 key as the WebView app (android/README.md), so this APK
// installs over it. Its path and password come from the environment (GitHub secrets in CI).
val keystore: String? = System.getenv("MIMI_KEYSTORE")
val keystorePassword: String? = System.getenv("MIMI_KEYSTORE_PASSWORD")

android {
    namespace = "app.mimi.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.mimi.android"
        minSdk = 23
        targetSdk = 35
        versionCode = appCode
        versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "MIMI_HOST", "\"$mimiHost\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${prop("fcmProjectId")}\"")
        buildConfigField("String", "FCM_APP_ID", "\"${prop("fcmAppId")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${prop("fcmApiKey")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${prop("fcmSenderId")}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = keystorePassword
                keyAlias = "mimi"
                keyPassword = keystorePassword
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":core:data"))
    implementation(project(":core:ui"))
    implementation(project(":feature:auth"))
    implementation(project(":feature:chat"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    implementation(libs.hilt.work)
    ksp(libs.hilt.compiler)
    ksp(libs.hilt.androidx.compiler)
    implementation(libs.work.runtime)
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.runner)
    debugImplementation(libs.compose.ui.test.manifest)
}
