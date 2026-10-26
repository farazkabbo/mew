//! The hold gesture's reader (K2, docs/NOTEBOOKS_K.md §11.1): one thread for as long as the app
//! runs, polling left Ctrl and left Alt (`win::input`; no keyboard hook, decision 11) and feeding
//! `hold.rs`. While both keys are down it also asks whether any other key is (the AltGr guard),
//! only "yes or no". What a gesture does is `coach::on_hold`'s business: Circle & Ask and talking
//! when Screen Coach is on, summoning Neb's window when it isn't. A gesture that starts while
//! Neb's own window is in front belongs to the notebook page, which has its own hold (decision 5).

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use super::coach;
use super::hold::{HoldEvent, HoldGesture, Keys};
use super::win::input;

/// How often the keys are read while they're up, and while they're down (the guard and taps
/// need finer timing).
const IDLE_POLL: Duration = Duration::from_millis(40);
const DOWN_POLL: Duration = Duration::from_millis(15);

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-hold-keys".into())
        .spawn(move || run(&handle));
    if spawned.is_err() {
        eprintln!("[screen] couldn't start reading the hold keys");
    }
}

fn run<R: Runtime>(app: &AppHandle<R>) {
    let mut gesture = HoldGesture::default();
    let mut were_down = false;
    // This gesture started over Neb's own window: the page handles it, to the end.
    let mut page_has_it = false;
    loop {
        let held = input::hold_keys_held();
        // The first read after the keys go down only clears what earlier typing left behind.
        let other = held && input::other_key_down(!were_down);
        were_down = held;
        if let Some(event) = gesture.step(Keys { held, other }, Instant::now()) {
            if matches!(event, HoldEvent::Started | HoldEvent::DoubleTap) {
                page_has_it = neb_in_front(app);
            }
            if !page_has_it {
                coach::on_hold(app, event);
            }
            if event != HoldEvent::Started {
                page_has_it = false;
            }
        }
        std::thread::sleep(if held || gesture.keys_down() {
            DOWN_POLL
        } else {
            IDLE_POLL
        });
    }
}

/// Neb's main window has the keyboard.
fn neb_in_front<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(crate::MAIN)
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}
