//! Owned native red-border presentation test. No pixels, audio, account, app contents or input.
#[cfg(target_os = "macos")]
fn main() {
    use mew_desktop_lib::screen::mac::{indicator::Indicator, target};
    tauri::Builder::default()
        .setup(|app| {
            let rect = target::main_display()
                .ok_or_else(|| std::io::Error::other("No test display"))?
                .points;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| {
                    let indicator = Indicator::begin(rect).map_err(|e| format!("begin: {e:?}"))?;
                    indicator
                        .wait_presented(&mut || true)
                        .map_err(|e| format!("presentation: {e:?}"))?;
                    if !indicator.is_presented() {
                        return Err("lease validation".to_owned());
                    }
                    let check = indicator.check_handle();
                    drop(indicator);
                    if check.is_presented() {
                        return Err("revocation".to_owned());
                    }
                    Ok(())
                })();
                let success = result.is_ok();
                if success {
                    println!("MAC_INDICATOR_PRESENTATION_AND_REVOCATION_PASSED");
                } else {
                    eprintln!("MAC_INDICATOR_PRESENTATION_UNVERIFIED: {:?}", result.err());
                }
                app.exit(if success { 0 } else { 1 });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Indicator fixture failed");
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This fixture requires macOS.");
}
