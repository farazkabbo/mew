fn main() {
    // Declaring the app's commands makes them deny-by-default: a page may only call one if a
    // capability grants it (see `remote_capability` and `screen::settings_capability`).
    let commands = tauri_build::AppManifest::new().commands(&[
        "notify_due",
        "screen_coach_status",
        "screen_coach_set_enabled",
        "screen_coach_set_paused",
        "screen_coach_set_hotkey",
        "screen_coach_set_privacy",
        "screen_coach_open_mic_settings",
        "screen_coach_link_start",
        "screen_coach_link_finish",
        "screen_coach_disconnect",
        "screen_coach_ask",
        "screen_ink_drawn",
        "screen_ink_pill",
        "screen_clip_ready",
        "screen_clip_save",
        "screen_clip_cancel",
        "screen_notes_panel",
        "screen_coach_pill",
    ]);
    // Our own manifest replaces Tauri's default: the same Common Controls dependency, plus
    // Per-Monitor DPI Awareness V2 (Screen Coach maps screenshot pixels to screen pixels).
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(commands)
            .windows_attributes(windows),
    )
    .expect("failed to run tauri-build");
}
