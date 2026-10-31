fn main() {
    // Declaring the app's commands makes them deny-by-default: a page may only call one if a
    // capability grants it (see `remote_capability` and `screen::settings_capability`).
    let commands = tauri_build::AppManifest::new().commands(&[
        "notify_due",
        "notify_checks",
        "notify_skills",
        "screen_coach_status",
        "screen_coach_set_enabled",
        "screen_coach_set_paused",
        "screen_coach_shortcuts_seen",
        "screen_coach_set_privacy",
        "screen_coach_open_mic_settings",
        "screen_coach_link_start",
        "screen_coach_link_finish",
        "screen_coach_disconnect",
        "desktop_sign_in_start",
        "desktop_sign_in_ticket",
        "desktop_sign_out",
        "screen_coach_ask",
        "screen_coach_onboarding",
        "screen_ink_drawn",
        "screen_ink_pill",
        "screen_clip_ready",
        "screen_clip_save",
        "screen_clip_cancel",
        "screen_notes_panel",
        "screen_coach_pill",
        "screen_coach_set_circle",
        "screen_coach_spoken",
        "screen_draw_mark",
        "screen_draw_erase",
        "screen_draw_select",
        "screen_draw_note",
        "screen_circle_card",
        "screen_quiz_card",
        "screen_island",
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
