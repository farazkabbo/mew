//! Local scene-only rendering. No OCR values, pixels, drafts or screenshots enter JavaScript.
use crate::screen::cursor::scene::{Scene, Shape};
use crate::screen::mac::{overlay, panel, target};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
pub const LABEL: &str = "screen-mac-cursor";
pub const CATCH: &str = "screen-mac-catch";
fn ensure(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let page = if label == CATCH {
        "mac-catch.html"
    } else {
        "mac-cursor.html"
    };
    overlay::track(app, label);
    let dev = app.config().build.dev_url.clone();
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                overlay::page_loaded(&window);
            }
        })
        .on_navigation(move |url| {
            crate::screen::is_local_page(url, dev.as_ref()) && url.path() == format!("/{page}")
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .disable_drag_drop_handler()
        .title("Neb guidance")
        .visible(false)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .inner_size(360., 100.)
        .build()
        .map_err(|_| "Couldn't create native cursor guidance.")?;
    panel::attach(&w, false).map_err(|_| "Couldn't attach native cursor guidance.")?;
    overlay::set_click_through(&w, label != CATCH)
        .map_err(|_| "Couldn't configure cursor guidance.")?;
    Ok(w)
}
fn dispatch(w: &WebviewWindow, name: &str, detail: Value) {
    let _ = overlay::dispatch_window(w, name, &detail);
}
pub fn hide(app: &AppHandle) {
    for label in [LABEL, CATCH] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = overlay::hide(&w);
        }
    }
}
pub fn scene(app: &AppHandle, scene: &Scene, valid: impl Fn(&AppHandle) -> bool + Send + 'static) {
    let shapes = scene.shapes.clone();
    let handle = app.clone();
    let _=app.run_on_main_thread(move||{
 if !valid(&handle){return;}
 if shapes.is_empty(){if let Some(w)=handle.get_webview_window(LABEL){let _=overlay::hide(&w);}return;}
 let Some(displays)=target::displays()else{return;};
 let Some(first)=displays.first()else{return;};
 let mut r=first.points;for d in displays.iter().skip(1){let right=(r.x+r.width).max(d.points.x+d.points.width);let bottom=(r.y+r.height).max(d.points.y+d.points.height);r.x=r.x.min(d.points.x);r.y=r.y.min(d.points.y);r.width=right-r.x;r.height=bottom-r.y;}
 let value=shapes.into_iter().map(|s|match s{
 Shape::GhostPath{from,control,to,alpha}=>json!({"type":"path","from":[from.0-r.x,from.1-r.y],"control":[control.0-r.x,control.1-r.y],"to":[to.0-r.x,to.1-r.y],"alpha":alpha}),
 Shape::Glow{rect,scale,alpha,warn}=>json!({"type":"glow","x":rect.left as f64-r.x,"y":rect.top as f64-r.y,"w":rect.width(),"h":rect.height(),"scale":scale,"alpha":alpha,"warn":warn}),
 Shape::Caption{at,text,warn,..}=>json!({"type":"caption","x":at.0-r.x,"y":at.1-r.y,"text":text,"warn":warn}),
 Shape::Dot{at,radius,alpha}=>json!({"type":"dot","x":at.0-r.x,"y":at.1-r.y,"radius":radius,"alpha":alpha}),
 Shape::Ring{at,radius}=>json!({"type":"ring","x":at.0-r.x,"y":at.1-r.y,"radius":radius}),
 }).collect::<Vec<_>>();
 if let Ok(w)=ensure(&handle,LABEL){let _=overlay::place(&w,r);dispatch(&w,"mew:mac-cursor-scene",json!({"shapes":value}));let _=overlay::show_quietly(&w);}
 });
}
pub fn catch(
    app: &AppHandle,
    message: &str,
    at: target::Point,
    valid: impl Fn(&AppHandle) -> bool + Send + 'static,
) {
    let handle = app.clone();
    let message = message.to_owned();
    let _ = app.run_on_main_thread(move || {
        if !valid(&handle) {
            return;
        }
        if let Ok(w) = ensure(&handle, CATCH) {
            if let Some(r) = target::Rect::new(at.x + 20., at.y + 20., 360., 110.) {
                let _ = overlay::place(&w, r);
            }
            dispatch(&w, "mew:mac-catch", json!({"message":message}));
            let _ = overlay::show_quietly(&w);
        }
    });
}
