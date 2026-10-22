fn main() {
    // Declaring the app's commands makes them deny-by-default: a page may only call one if a
    // capability grants it (see `remote_capability` in lib.rs).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["notify_due"])),
    )
    .expect("failed to run tauri-build");
}
