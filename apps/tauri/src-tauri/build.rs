fn main() {
    // The core address and test token can be baked in at build time (Android has no process env).
    println!("cargo:rerun-if-env-changed=MIMI_CORE_URL");
    println!("cargo:rerun-if-env-changed=MIMI_TOKEN");
    tauri_build::build()
}
