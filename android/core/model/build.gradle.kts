// Protocol types of the Mimi core (docs/native/api-contract.md, packages/shared/src/protocol.ts),
// plain Kotlin so they test on the JVM without an emulator.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin { jvmToolchain(17) }

dependencies {
    api(libs.serialization.json)
    testImplementation(libs.junit)
}
