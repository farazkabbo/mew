//! Mac overlay windows share the bundled pages and surface identities with Windows.
//! All AppKit calls run on the main thread. Coordinates are Quartz points, never global pixels.
//! This layer does not claim exclusion from another application's screen sharing.

use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::target::{self, Rect};
pub use crate::screen::surfaces::Surface;

#[derive(Default)]
struct PageQueue {
    ready: bool,
    events: std::collections::VecDeque<(String, Value)>,
}
#[derive(Default)]
struct Pages(std::sync::Mutex<std::collections::BTreeMap<String, PageQueue>>);
pub(crate) fn page_loaded<R: Runtime>(window: &WebviewWindow<R>) {
    if let Some(pages) = window.app_handle().try_state::<Pages>() {
        let mut pages = pages.0.lock().unwrap_or_else(|p| p.into_inner());
        let page = pages.entry(window.label().into()).or_default();
        page.ready = true;
        for (name, detail) in page.events.drain(..) {
            let _ = emit(window, &name, &detail);
        }
    }
}
fn emit<R: Runtime>(window: &WebviewWindow<R>, name: &str, detail: &Value) -> tauri::Result<()> {
    let name = serde_json::to_string(name)?;
    let detail = serde_json::to_string(detail)?;
    window.eval(format!(
        "window.dispatchEvent(new CustomEvent({name}, {{ detail: {detail} }}))"
    ))
}
pub(crate) fn track<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if app.try_state::<Pages>().is_none() {
        app.manage(Pages::default());
    }
    if let Some(pages) = app.try_state::<Pages>() {
        pages
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(label.into(), PageQueue::default());
    }
}
pub(crate) fn dispatch_window<R: Runtime>(
    window: &WebviewWindow<R>,
    name: &str,
    detail: &Value,
) -> tauri::Result<()> {
    if let Some(pages) = window.app_handle().try_state::<Pages>() {
        let mut pages = pages.0.lock().unwrap_or_else(|p| p.into_inner());
        let page = pages.entry(window.label().into()).or_default();
        if !page.ready {
            if page.events.len() >= 32 {
                page.events.pop_front();
            }
            page.events.push_back((name.into(), detail.clone()));
            return Ok(());
        }
        return emit(window, name, detail);
    }
    emit(window, name, detail)
}
/// Only these surfaces take keyboard focus after a deliberate click, never when first shown.
fn accepts_keyboard(surface: Surface) -> bool {
    matches!(
        surface,
        Surface::Clip | Surface::Card | Surface::Quiz | Surface::Notes | Surface::Draw
    )
}

fn initial_size(surface: Surface) -> (f64, f64) {
    match surface {
        Surface::Island => crate::screen::island::ISLAND_SIZE,
        Surface::Pill => crate::screen::surfaces::PILL_SIZE,
        Surface::Coach => crate::screen::walkthrough::PILL_SIZE,
        Surface::Card => crate::screen::surfaces::CARD_SIZE,
        Surface::Quiz => crate::screen::quiz::CARD_SIZE,
        Surface::Clip => (640., 480.),
        Surface::Notes => (420., 500.),
        Surface::Capsule => crate::screen::surfaces::CAPSULE_SIZE,
        Surface::Keys => crate::screen::surfaces::KEYS_SIZE,
        Surface::Ink | Surface::Draw => (800., 600.),
        Surface::Pointer | Surface::Hand => (48., 48.),
    }
}

/// Create on the main thread. No remote content or popups can enter an overlay window.
/// The caller supplies a surface-specific IPC capability before loading it.
pub fn ensure<R: Runtime>(app: &AppHandle<R>, surface: Surface) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(surface.label()) {
        return Ok(window);
    }
    if objc2::MainThreadMarker::new().is_none() {
        return Err(
            std::io::Error::other("Mac overlays must be created on the main thread").into(),
        );
    }
    track(app, surface.label());
    let dev_url = app.config().build.dev_url.clone();
    let size = initial_size(surface);
    let preview = surface == Surface::Clip;
    let window =
        WebviewWindowBuilder::new(app, surface.label(), WebviewUrl::App(surface.page().into()))
            .title("Neb")
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    page_loaded(&window);
                }
            })
            .on_navigation(move |url| crate::screen::is_local_page(url, dev_url.as_ref()))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .disable_drag_drop_handler()
            .visible(false)
            .focused(false)
            // A non-key panel must deliver the first deliberate click while another app is key.
            .accept_first_mouse(true)
            .focusable(accepts_keyboard(surface))
            .transparent(!preview)
            .decorations(preview)
            .shadow(preview)
            .always_on_top(!preview)
            .resizable(preview)
            .initialization_script(
                "Object.defineProperty(window, '__NEB_MAC_HOST__', { value: true });",
            )
            .initialization_script(if surface == Surface::Draw {
                "Object.defineProperty(window, '__NEB_MAC_DRAW_HOST__', { value: true });"
            } else if surface == Surface::Ink {
                "Object.defineProperty(window, '__NEB_MAC_INK_HOST__', { value: true });"
            } else if surface == Surface::Card {
                "Object.defineProperty(window, '__NEB_MAC_CARD_HOST__', { value: true });"
            } else {
                ""
            })
            .inner_size(size.0, size.1)
            .build()?;
    if !preview {
        super::panel::attach(&window, accepts_keyboard(surface))?;
    }
    set_click_through(
        &window,
        matches!(
            surface,
            Surface::Ink
                | Surface::Pointer
                | Surface::Draw
                | Surface::Hand
                | Surface::Capsule
                | Surface::Keys
        ),
    )?;
    Ok(window)
}

/// Place directly through AppKit, avoiding Tauri's global-pixel positioning on mixed-scale Macs.
/// Both input and screen origin use Quartz global points. The result is sent on the main queue.
pub fn place<R: Runtime>(window: &WebviewWindow<R>, rect: Rect) -> tauri::Result<()> {
    let rect = Rect::new(rect.x, rect.y, rect.width, rect.height)
        .ok_or_else(|| std::io::Error::other("Invalid overlay rectangle"))?;
    let owned = window.clone();
    window.run_on_main_thread(move || {
        let Some(primary) = target::main_display() else {
            return;
        };
        let Some(frame) = rect.to_appkit(primary.points.height) else {
            return;
        };
        super::panel::with_window(&owned, |native| {
            native.setFrame_display(
                NSRect::new(
                    NSPoint::new(frame.x, frame.y),
                    NSSize::new(frame.width, frame.height),
                ),
                true,
            )
        });
    })
}

/// Orders a window without activating Neb or changing the student's key window.
pub fn show_quietly<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let owned = window.clone();
    window.run_on_main_thread(move || {
        super::panel::with_window(&owned, |native| native.orderFrontRegardless());
    })
}

pub fn hide<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    if let Some(pages) = window.app_handle().try_state::<Pages>() {
        if let Some(page) = pages
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(window.label())
        {
            page.events.clear();
        }
    }
    let owned = window.clone();
    window.run_on_main_thread(move || {
        super::panel::with_window(&owned, |native| native.orderOut(None))
    })
}
pub fn set_click_through<R: Runtime>(
    window: &WebviewWindow<R>,
    through: bool,
) -> tauri::Result<()> {
    let owned = window.clone();
    window.run_on_main_thread(move || {
        super::panel::with_window(&owned, |native| native.setIgnoresMouseEvents(through))
    })
}
pub fn set_activatable<R: Runtime>(window: &WebviewWindow<R>, active: bool) -> tauri::Result<()> {
    let label = window.label().to_owned();
    window.run_on_main_thread(move || super::panel::keyboard(&label, active))
}

/// No content can be supplied as executable JavaScript: both the event and data are serialized.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    surface: Surface,
    name: &str,
    detail: &Value,
) -> tauri::Result<()> {
    let window = app
        .get_webview_window(surface.label())
        .ok_or_else(|| std::io::Error::other("Overlay window is not open"))?;
    dispatch_window(&window, name, detail)
}

/// Local surface commands must be called from that window and its exact bundled page.
pub fn require_surface<R: Runtime>(
    window: &WebviewWindow<R>,
    surface: Surface,
) -> Result<(), String> {
    let dev_url = window.app_handle().config().build.dev_url.clone();
    if window
        .url()
        .is_ok_and(|url| allowed_surface(window.label(), &url, dev_url.as_ref(), surface))
    {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}

fn allowed_surface(
    label: &str,
    url: &tauri::Url,
    dev: Option<&tauri::Url>,
    surface: Surface,
) -> bool {
    label == surface.label()
        && crate::screen::is_local_page(url, dev)
        && url.path() == format!("/{}", surface.page())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_ipc_requires_the_correct_window_origin_and_page() {
        let allowed = |label, url: &str| {
            allowed_surface(
                label,
                &tauri::Url::parse(url).unwrap(),
                None,
                Surface::Island,
            )
        };
        assert!(allowed("screen-island", "tauri://localhost/island.html"));
        assert!(!allowed("main", "tauri://localhost/island.html"));
        assert!(!allowed(
            "screen-island",
            "http://localhost:3000/island.html"
        ));
        assert!(!allowed(
            "screen-island",
            "tauri://localhost/clip-preview.html"
        ));
        assert!(!allowed(
            "screen-island",
            "https://tauri.localhost.evil/island.html"
        ));
    }
    #[test]
    fn visual_surfaces_never_take_keyboard_focus() {
        for surface in Surface::OVERLAYS {
            assert_eq!(
                accepts_keyboard(surface),
                matches!(
                    surface,
                    Surface::Card | Surface::Quiz | Surface::Notes | Surface::Draw
                )
            );
        }
        assert!(accepts_keyboard(Surface::Clip));
    }
}
