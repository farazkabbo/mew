fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_mac_capture();
    }
    // Declaring the app's commands makes them deny-by-default: a page may only call one if a
    // capability grants it (see `remote_capability` and `screen::settings_capability`).
    let commands = tauri_build::AppManifest::new().commands(&[
        "desktop_summon_shortcut",
        "mac_settings_status",
        "mac_settings_update",
        "mac_tools_toggle",
        "mac_handoff_start",
        "mac_handoff_forget",
        "mac_open_microphone_settings",
        "mac_open_notebook",
        "mac_local_history",
        "mac_cursor_catch_action",
        "screen_draw_ready",
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
        "desktop_sign_in_cancel",
        "desktop_sign_in_ticket",
        "desktop_sign_out",
        "screen_coach_ask",
        "screen_coach_onboarding",
        "screen_ink_drawn",
        "screen_ink_ready",
        "screen_ink_pill",
        "screen_clip_ready",
        "screen_clip_save",
        "screen_clip_cancel",
        "screen_notes_panel",
        "screen_coach_pill",
        "screen_coach_set_circle",
        "screen_coach_set_cursor",
        "screen_coach_forget_paths",
        "screen_coach_handoff",
        "handoff_preview_state",
        "handoff_preview_update",
        "handoff_preview_blur",
        "handoff_preview_send",
        "handoff_preview_copy",
        "handoff_preview_cancel",
        "handoff_pick_up",
        "screen_coach_spoken",
        "screen_draw_mark",
        "screen_draw_erase",
        "screen_draw_island_press",
        "screen_draw_pen",
        "screen_draw_select",
        "screen_draw_note",
        "screen_circle_card",
        "screen_circle_ready",
        "screen_quiz_card",
        "screen_island",
        "desktop_update_status",
        "desktop_update_check",
        "desktop_update_install",
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

/// Compile the small Apple SDK adapter for the target architecture. No downloaded code or
/// shell evaluation: xcrun selects the installed Apple toolchain, all paths are separate args.
fn build_mac_capture() {
    use std::{env, path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=native/macos/ScreenCapture.swift");
    println!("cargo:rerun-if-changed=native/macos/include/neb_capture.h");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("Unsupported Mac architecture"),
    };
    let target = format!("{arch}-apple-macosx14.0");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let object = out.join("neb_capture.o");
    let archive = out.join("libneb_capture.a");
    // Keep compiler caches within Cargo's build directory, including sandboxed builds.
    let modules = out.join("swift-modules");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-O",
            "-target",
            &target,
            "-emit-object",
            "native/macos/ScreenCapture.swift",
            "-o",
        ])
        .arg(&object)
        .arg("-module-cache-path")
        .arg(&modules)
        .status()
        .expect("Apple Swift compiler is required for Mac capture");
    assert!(status.success(), "Mac SDK capture bridge failed to compile");
    println!("cargo:rerun-if-changed=native/macos/Indicator.swift");
    println!("cargo:rerun-if-changed=native/macos/include/neb_indicator.h");
    println!("cargo:rerun-if-changed=src/screen/mac/call_signals.m");
    let indicator = out.join("neb_indicator.o");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-O",
            "-target",
            &target,
            "-emit-object",
            "native/macos/Indicator.swift",
            "-o",
        ])
        .arg(&indicator)
        .arg("-module-cache-path")
        .arg(&modules)
        .status()
        .expect("Apple Swift compiler");
    assert!(status.success(), "Mac capture indicator failed to compile");
    println!("cargo:rerun-if-changed=native/macos/HandoffCrypto.swift");
    let handoff = out.join("neb_handoff_crypto.o");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-O",
            "-target",
            &target,
            "-emit-object",
            "native/macos/HandoffCrypto.swift",
            "-o",
        ])
        .arg(&handoff)
        .arg("-module-cache-path")
        .arg(&modules)
        .status()
        .expect("Apple Swift compiler");
    assert!(
        status.success(),
        "Mac Handoff crypto bridge failed to compile"
    );
    let signals = out.join("neb_call_signals.o");
    let status = Command::new("xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-target",
            &target,
            "-c",
            "src/screen/mac/call_signals.m",
            "-o",
        ])
        .arg(&signals)
        .status()
        .expect("Apple Objective-C compiler");
    assert!(status.success(), "Mac call inventory failed to compile");
    let status = Command::new("xcrun")
        .args(["libtool", "-static", "-o"])
        .arg(&archive)
        .arg(&object)
        .arg(&indicator)
        .arg(&handoff)
        .arg(&signals)
        .status()
        .expect("Apple libtool is required");
    assert!(status.success(), "Mac capture archive failed");
    let info = Command::new("xcrun")
        .args(["swiftc", "-print-target-info", "-target", &target])
        .output()
        .expect("Swift target info");
    assert!(info.status.success(), "Swift target info failed");
    let info: serde_json::Value = serde_json::from_slice(&info.stdout).expect("Swift target JSON");
    for path in info["paths"]["runtimeLibraryPaths"]
        .as_array()
        .expect("Swift runtime paths")
    {
        println!(
            "cargo:rustc-link-search=native={}",
            path.as_str().expect("Swift runtime path")
        );
    }
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-lib=static=neb_capture");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    for framework in [
        "Foundation",
        "AppKit",
        "Metal",
        "QuartzCore",
        "CoreAudio",
        "CoreGraphics",
        "CoreVideo",
        "ScreenCaptureKit",
        "Vision",
        "ImageIO",
        "UniformTypeIdentifiers",
        "CryptoKit",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
