//! Native voice intent owns each request. The hosted page can return words only while a
//! short-lived native microphone gesture is pending; it cannot request arbitrary captures.
use super::{capture_session, pipeline, runtime, service_call, study};
use crate::screen::{
    mac_auth, page,
    protocol::{self, LineSplitter, StreamEvent},
    sign_in::SignIn,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Default)]
struct Voice {
    pending: Option<Instant>,
    listening: bool,
}
#[derive(Default)]
struct Asking {
    voice: Mutex<Voice>,
    busy: AtomicBool,
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    if !app.manage(Asking::default()) {
        return Err("Voice services already initialized.".into());
    }
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-voice-expiry".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let expired = handle.try_state::<Asking>().is_some_and(|s| {
                let mut voice = s.voice.lock().unwrap_or_else(|p| p.into_inner());
                if voice.pending.is_some() && !timely(voice.pending, Instant::now()) {
                    *voice = Voice::default();
                    true
                } else {
                    false
                }
            });
            if expired {
                page::dispatch(&handle, page::CANCEL, serde_json::Value::Null);
                let _ = super::island::refresh(&handle);
            }
        })
        .map_err(|_| "Couldn't start voice expiry.")?;
    Ok(())
}
pub fn engaged(app: &AppHandle) -> bool {
    app.try_state::<Asking>().is_some_and(|s| {
        s.busy.load(Ordering::Acquire)
            || s.voice
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .pending
                .is_some()
    })
}
pub fn listening(app: &AppHandle) -> bool {
    app.try_state::<Asking>()
        .is_some_and(|s| s.voice.lock().unwrap_or_else(|p| p.into_inner()).listening)
}
fn authorized(app: &AppHandle) -> Result<(), String> {
    let sign = app
        .try_state::<SignIn>()
        .ok_or("Account services aren't ready.")?;
    let main = app
        .get_webview_window(crate::MAIN)
        .ok_or("Open your Neb notebook first.")?;
    page::require_app_page(&main, sign.app_url())?;
    let (c, _) = runtime::of(app)?.snapshot();
    if !c.is_on() || c.paused || !c.privacy.show_in_captures {
        return Err("Enable Screen Coach and visible overlays in local settings first.".into());
    }
    Ok(())
}
pub fn toggle_mic(app: &AppHandle) -> Result<(), String> {
    authorized(app)?;
    let s = app
        .try_state::<Asking>()
        .ok_or("Voice services aren't ready.")?;
    if s.busy.load(Ordering::Acquire) {
        return Err("Neb is answering. Cancel or wait before asking again.".into());
    }
    let mut voice = s.voice.lock().unwrap_or_else(|p| p.into_inner());
    if voice.listening {
        voice.listening = false;
        drop(voice);
        page::dispatch(app, page::RELEASE, serde_json::Value::Null);
    } else {
        voice.pending = Some(Instant::now());
        voice.listening = true;
        drop(voice);
        if !super::circle::has_session(app) && !study::takes_words(app) {
            runtime::of(app)?.generation.fetch_add(1, Ordering::AcqRel);
        }
        crate::mac_shortcut::reserve_escape(app)?;
        page::dispatch(app, page::LISTEN, serde_json::Value::Null);
    }
    super::island::refresh(app)
}
pub fn cancel(app: &AppHandle) {
    if let Some(s) = app.try_state::<Asking>() {
        *s.voice.lock().unwrap_or_else(|p| p.into_inner()) = Voice::default();
    }
    page::dispatch(app, page::CANCEL, serde_json::Value::Null);
    page::dispatch(app, page::HUSH, serde_json::Value::Null);
}
fn owner(app: &AppHandle) -> Option<[u8; 32]> {
    let sign = app.try_state::<SignIn>()?;
    Some(Sha256::digest(mac_auth::load_token(sign.app_url()).ok()??.as_slice()).into())
}
fn timely(start: Option<Instant>, now: Instant) -> bool {
    start.is_some_and(|s| now.saturating_duration_since(s) < Duration::from_secs(60))
}
#[tauri::command]
pub fn screen_coach_ask(window: WebviewWindow, transcript: String) -> Result<(), String> {
    let app = window.app_handle();
    let sign = app
        .try_state::<SignIn>()
        .ok_or("Account services aren't ready.")?;
    page::require_app_page(&window, sign.app_url())?;
    authorized(app)?;
    let s = app
        .try_state::<Asking>()
        .ok_or("Voice services aren't ready.")?;
    let mut voice = s.voice.lock().unwrap_or_else(|p| p.into_inner());
    if !timely(voice.pending.take(), Instant::now()) {
        voice.listening = false;
        return Err("Start a question from Neb's microphone first.".into());
    }
    voice.listening = false;
    drop(voice);
    let text = protocol::clean_transcript(&transcript);
    if text.is_empty() && !study::takes_words(app) {
        return Ok(());
    }
    if s.busy.swap(true, Ordering::AcqRel) {
        return Err("Neb is already answering.".into());
    }
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    let handle = app.clone();
    if std::thread::Builder::new()
        .name("neb-mac-ask".into())
        .spawn(move || {
            let ui = UiTicket {
                generation,
                account: owner(&handle),
            };
            let result = ask(&handle, &text, generation);
            if let Err(message) = result {
                deliver(
                    &handle,
                    page::SAY,
                    json!({"text":message.chars().take(300).collect::<String>()}),
                    ui,
                );
            }
            if let Some(s) = handle.try_state::<Asking>() {
                s.busy.store(false, Ordering::Release);
            }
            let _ = super::island::refresh(&handle);
        })
        .is_err()
    {
        s.busy.store(false, Ordering::Release);
        return Err("Couldn't start your question.".into());
    }
    Ok(())
}
#[derive(Clone, Copy)]
struct UiTicket {
    generation: u64,
    account: Option<[u8; 32]>,
}
impl UiTicket {
    fn matches(self, generation: u64, account: Option<[u8; 32]>) -> bool {
        self.generation == generation && self.account == account
    }
}
fn deliver(app: &AppHandle, event: &'static str, value: serde_json::Value, ticket: UiTicket) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(runtime) = runtime::of(&handle) else {
            return;
        };
        if !ticket.matches(runtime.generation.load(Ordering::Acquire), owner(&handle)) {
            return;
        }
        let Some(sign) = handle.try_state::<SignIn>() else {
            return;
        };
        let Some(main) = handle.get_webview_window(crate::MAIN) else {
            return;
        };
        if page::require_app_page(&main, sign.app_url()).is_ok() {
            page::dispatch(&handle, event, value);
        }
    });
}
#[derive(Debug, PartialEq, Eq)]
enum InitialRoute {
    Pause,
    Quiz,
    Other,
}
fn initial_route(text: &str, coaching: bool, quiz: bool) -> InitialRoute {
    if crate::screen::intent::intent_of(text, coaching) == crate::screen::intent::Intent::Pause {
        InitialRoute::Pause
    } else if quiz {
        InitialRoute::Quiz
    } else {
        InitialRoute::Other
    }
}
fn ask(app: &AppHandle, text: &str, generation: u64) -> Result<(), String> {
    match initial_route(text, study::is_coaching(app), study::takes_words(app)) {
        InitialRoute::Pause => return runtime::set_paused(app, true),
        InitialRoute::Quiz => {
            study::route_words(app, text)?;
            return Ok(());
        }
        InitialRoute::Other => {}
    }
    if let Some(hint) = crate::screen::handoff::hand_off_phrase(text) {
        return super::handoff_runtime::start(app, hint);
    }
    if super::circle::has_session(app) {
        return super::circle::ask_voice(app, text);
    }
    if crate::screen::intent::intent_of(text, study::is_coaching(app))
        == crate::screen::intent::Intent::Reannotate
    {
        return super::annotate::reannotate(app);
    }
    if crate::screen::intent::intent_of(text, study::is_coaching(app))
        == crate::screen::intent::Intent::Clip
    {
        return super::clip::save_request(app, text);
    }
    if crate::screen::destination::save_to_phrase(text).is_some() {
        return super::clip::save_request(app, text);
    }
    let account = owner(app).ok_or(service_call::NOT_CONNECTED)?;
    let fixed = crate::screen::intent::intent_of(text, study::is_coaching(app));
    let requested = if study::takes_words(app) {
        fixed
    } else {
        let body = crate::screen::intent::intent_body(
            text,
            study::is_coaching(app),
            super::annotate::visible(app),
        );
        let cancelled = || {
            !runtime::of(app).is_ok_and(|r| r.generation.load(Ordering::Acquire) == generation)
                || owner(app) != Some(account)
        };
        service_call::post_bound(app, "api/screen/intent", &body, &account, &cancelled)
            .ok()
            .and_then(|bytes| {
                crate::screen::intent::parse_intent_reply(
                    bytes.as_slice(),
                    study::is_coaching(app),
                    super::annotate::visible(app),
                )
            })
            .unwrap_or(fixed)
    };
    if requested == crate::screen::intent::Intent::Pause {
        return runtime::set_paused(app, true);
    }
    if requested == crate::screen::intent::Intent::Reannotate {
        return super::annotate::reannotate(app);
    }
    if requested == crate::screen::intent::Intent::Clip {
        return super::clip::save_request(app, text);
    }
    if study::route_intent(app, text, requested)? {
        return Ok(());
    }
    if super::cursor_runtime::route_intent(app, text, requested)? {
        return Ok(());
    }
    if super::chores::route_intent(app, text, requested)? {
        return Ok(());
    }
    if super::hand::route_intent(app, text, requested)? {
        return Ok(());
    }
    let ui = UiTicket {
        generation,
        account: Some(account),
    };
    let frame = capture_session::capture_window(app, pipeline::Intent::Ask, generation)?;
    let stale = || owner(app) != Some(account) || !capture_session::is_current(app, &frame);
    let (config, _) = runtime::of(app)?.snapshot();
    let meta = frame.server_meta();
    let body = protocol::ask_body(
        text,
        &meta,
        None,
        study::active_walkthrough(app).as_deref(),
        Some(config.help),
        frame.captured.jpeg.as_slice(),
    );
    let mut lines = LineSplitter::default();
    let mut final_reply = None;
    let mut consume = |line: String| {
        if stale() {
            return;
        }
        match protocol::parse_event(&line) {
            Some(StreamEvent::Speech { text }) => {
                deliver(app, page::SPEECH, json!({"text":text}), ui)
            }
            Some(StreamEvent::Response { response, turn_id }) => {
                final_reply = Some((response, turn_id))
            }
            Some(StreamEvent::Error { message }) => {
                deliver(app, page::SAY, json!({"text":message}), ui)
            }
            _ => {}
        }
    };
    service_call::post_stream_bound(
        app,
        "api/screen/ask",
        body.as_slice(),
        &account,
        &stale,
        |chunk| {
            for line in lines.push(chunk) {
                consume(line);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    if let Some(line) = lines.finish() {
        consume(line);
    }
    if stale() {
        return Ok(());
    }
    let (reply, id) = final_reply.ok_or("Neb's answer was incomplete. Try again.")?;
    deliver(app, page::ANSWER, json!({"turnId":id,"response":reply}), ui);
    if reply.draws() {
        super::annotate::show_owned_actions(app, frame, &id, reply.actions, false)?;
    }
    Ok(())
}
#[tauri::command]
pub fn screen_coach_spoken(window: WebviewWindow, token: u64) -> Result<(), String> {
    let app = window.app_handle();
    let sign = app
        .try_state::<SignIn>()
        .ok_or("Account services aren't ready.")?;
    page::require_app_page(&window, sign.app_url())?;
    super::circle::spoken(app, token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiz_answers_keep_command_like_words_and_global_pause_still_wins() {
        for words in [
            "save this",
            "show that again",
            "save this to Physics",
            "hand this off to Alex",
        ] {
            assert_eq!(initial_route(words, false, true), InitialRoute::Quiz);
        }
        assert_eq!(
            initial_route("Neb, pause", false, true),
            InitialRoute::Pause
        );
        assert_eq!(
            initial_route("save this", false, false),
            InitialRoute::Other
        );
    }
    #[test]
    fn queued_delivery_rechecks_account_and_cancellation_at_execution() {
        let pending = UiTicket {
            generation: 7,
            account: Some([1; 32]),
        };
        assert!(pending.matches(7, Some([1; 32])));
        assert!(!pending.matches(8, Some([1; 32])));
        assert!(!pending.matches(7, Some([2; 32])));
        assert!(!pending.matches(7, None));
    }
    #[test]
    fn expired_or_missing_gesture_cannot_request_a_capture() {
        let now = Instant::now();
        assert!(!timely(None, now));
        assert!(!timely(Some(now - Duration::from_secs(60)), now));
        assert!(timely(Some(now - Duration::from_secs(59)), now));
    }
}
