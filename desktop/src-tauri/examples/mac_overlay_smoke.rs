//! Isolated owned-fixture check for the Mac NSPanel + bundled island + real IPC. No screen,
//! microphone, provider, account, clipboard, input injection or permission APIs are used.
//! `cargo run --example mac_overlay_smoke` on a Mac shows a synthetic test island. Its buttons
//! update ONLY test state; this backend is never installed by the production app.
#[cfg(target_os = "macos")]
fn main() {
    use mew_desktop_lib::screen::{
        config::HelpLevel,
        island::{Activity, IslandView, Shape, Tool},
        mac::island::{self, Actions},
        music::Control,
        surfaces::Surface,
    };
    use std::sync::{Arc, Mutex};
    use tauri::{ipc::CapabilityBuilder, Manager};

    struct Fixture {
        state: Mutex<IslandView>,
    }
    impl Fixture {
        fn update(&self, action: impl FnOnce(&mut IslandView)) {
            action(&mut self.state.lock().unwrap());
        }
    }
    impl Actions for Fixture {
        fn view(&self) -> IslandView {
            self.state.lock().unwrap().clone()
        }
        fn set_tool(&self, tool: Tool) -> Result<(), String> {
            self.update(|s| s.tool = tool);
            Ok(())
        }
        fn set_shape(&self, shape: Shape) -> Result<(), String> {
            self.update(|s| {
                s.shape = shape;
                s.tool = Tool::Select;
            });
            Ok(())
        }
        fn set_help(&self, help: HelpLevel) -> Result<(), String> {
            self.update(|s| s.help = help);
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            self.update(|s| s.clearable = false);
            Ok(())
        }
        fn close(&self) -> Result<(), String> {
            self.update(|s| s.tool = Tool::None);
            Ok(())
        }
        fn toggle_mic(&self) -> Result<(), String> {
            Err("Fixture never opens microphone".into())
        }
        fn toggle_watch(&self) -> Result<(), String> {
            Err("Fixture never captures screen".into())
        }
        fn music_panel(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn music_control(&self, _: Control) -> Result<(), String> {
            Err("Fixture has no player".into())
        }
        fn music_pin(&self) -> Result<(), String> {
            Err("Fixture never reads clipboard".into())
        }
        fn music_open(&self, _: &str) -> Result<(), String> {
            Err("Fixture never opens external links".into())
        }
        fn music_unpin(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![island::screen_island])
        .setup(|app| {
            app.add_capability(
                CapabilityBuilder::new("mac-overlay-fixture")
                    .local(true)
                    .window(Surface::Island.label())
                    .permission("allow-screen-island"),
            )?;
            island::setup(
                app.handle(),
                Arc::new(Fixture {
                    state: Mutex::new(IslandView {
                        tool: Tool::None,
                        shape: Shape::Free,
                        mic: false,
                        silent: true,
                        activity: Activity::Ready,
                        clearable: false,
                        help: HelpLevel::Hint,
                        watching: false,
                    }),
                }),
            )
            .map_err(std::io::Error::other)?;
            island::show(app.handle()).map_err(std::io::Error::other)?;
            let shutdown = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(180));
                shutdown.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Mac overlay fixture failed");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This owned-fixture check requires macOS.");
}
