//! Installed Mac services. Preferences are real; unavailable capture/voice services fail closed.
use super::{drawing, island, media};
use crate::screen::{
    config::{self, HelpLevel, ScreenConfig},
    island::{Activity, IslandView, Shape, Tool},
    music::Control,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager};

pub const CAPTURE_BLOCKER: &str = "Screen reading is not ready on this Mac. The privacy checks and capture flow are still being connected, so Neb will not read your screen.";
pub const DRAW_BLOCKER: &str =
    "Drawing and selection are unavailable until the Mac drawing session is connected.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    tool: Tool,
    shape: Shape,
}
struct State {
    config: ScreenConfig,
    reset: bool,
    preferences: Preferences,
}
#[path = "runtime_controls.rs"]
mod controls;
pub struct Runtime {
    app: Option<AppHandle>,
    path: PathBuf,
    preferences_path: PathBuf,
    state: Mutex<State>,
    pub generation: AtomicU64,
    catch_paused: AtomicBool,
}
impl Runtime {
    fn new(path: PathBuf) -> Self {
        let loaded = config::load(&path);
        let reset = matches!(loaded, config::Loaded::Reset(_));
        let preferences_path = path.with_file_name("mac-island.json");
        let preferences = std::fs::File::open(&preferences_path)
            .and_then(|file| {
                use std::io::Read;
                let mut text = String::new();
                file.take(4097).read_to_string(&mut text)?;
                Ok(text)
            })
            .ok()
            .filter(|text| text.len() <= 4096)
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            app: None,
            path,
            preferences_path,
            state: Mutex::new(State {
                config: loaded.into_config(),
                reset,
                preferences,
            }),
            generation: AtomicU64::new(1),
            catch_paused: AtomicBool::new(false),
        }
    }
    pub fn snapshot(&self) -> (ScreenConfig, bool) {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        (state.config.clone(), state.reset)
    }
    /// A failed save never changes the running configuration; the mutex serializes file writes.
    pub fn update(
        &self,
        edit: impl FnOnce(&mut ScreenConfig) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = state.config.clone();
        edit(&mut next)?;
        next.privacy = next.privacy.normalized()?;
        next.cursor = next.cursor.normalized()?;
        next.handoff = next.handoff.normalized();
        config::save(&self.path, &next)
            .map_err(|_| "Couldn't save Screen Coach settings.".to_owned())?;
        self.generation.fetch_add(1, Ordering::AcqRel);
        state.config = next;
        state.reset = false;
        Ok(())
    }
    fn media_app(&self) -> Result<&AppHandle, String> {
        let (config, _) = self.snapshot();
        if config.paused || !config.privacy.show_in_captures {
            return Err("Mac overlays are paused or disabled.".into());
        }
        self.app.as_ref().ok_or_else(|| DRAW_BLOCKER.into())
    }
    fn preference(&self, edit: impl FnOnce(&mut Preferences)) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = state.preferences.clone();
        edit(&mut next);
        let bytes = serde_json::to_vec(&next).map_err(|_| "Couldn't save tool preferences.")?;
        let temp = self.preferences_path.with_extension("json.tmp");
        std::fs::write(&temp, bytes)
            .and_then(|_| std::fs::rename(&temp, &self.preferences_path))
            .map_err(|_| "Couldn't save tool preferences.")?;
        state.preferences = next;
        Ok(())
    }
}

/// No screen permissions or microphone prompts occur during installation.
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Couldn't locate local settings.")?;
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't create local settings.")?;
    let mut runtime = Runtime::new(config::path_in(&dir));
    runtime.app = Some(app.clone());
    let runtime = Arc::new(runtime);
    drawing::setup(app)?;
    super::capture_session::setup(app)?;
    super::ask::setup(app)?;
    super::study::setup(app)?;
    super::annotate::setup(app)?;
    super::handoff_runtime::setup(app)?;
    super::clip::setup(app)?;
    super::circle::setup(app)?;
    super::hand::setup(app)?;
    super::chores::setup(app);
    super::cursor_runtime::setup(app)?;
    super::pointer::setup(app)?;
    super::note_scroll::setup(app)?;
    super::annotate::set_save_handler(app, Arc::new(super::clip::from_ink))?;
    super::media_pins::setup(app)?;
    media::setup(app)?;
    super::settings::capability(app)?;
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("mac-island")
            .local(true)
            .window(crate::screen::surfaces::Surface::Island.label())
            .permission("allow-screen-island"),
    )
    .map_err(|_| "Couldn't configure Neb tools.")?;
    if !app.manage(runtime.clone()) {
        return Err("Mac services are already initialized.".into());
    }
    island::setup(app, runtime)
}
pub fn of(app: &AppHandle) -> Result<tauri::State<'_, Arc<Runtime>>, String> {
    app.try_state::<Arc<Runtime>>()
        .ok_or_else(|| "Mac services aren't ready.".into())
}
/// Apply preferences to installed services; no unavailable capture service is activated.
pub fn apply(app: &AppHandle) -> Result<(), String> {
    super::ask::cancel(app);
    super::study::stop_all(app);
    super::hand::stop_all(app);
    super::chores::cancel_all(app);
    super::cursor_runtime::stop_all(app);
    super::circle::cancel_all(app);
    super::clip::cancel_all(app);
    super::handoff_runtime::cancel_all(app);
    let _ = super::annotate::clear(app);
    let (config, _) = of(app)?.snapshot();
    if config.paused || !config.privacy.show_in_captures {
        media::close(app)?;
        drawing::close(app)?;
    }
    if island::shown(app) {
        island::refresh(app)?;
    }
    Ok(())
}
/// Native cancellation invalidates all outstanding work before clearing visible surfaces.
pub fn cancel(app: &AppHandle) {
    if let Ok(r) = of(app) {
        r.generation.fetch_add(1, Ordering::AcqRel);
    }
    super::ask::cancel(app);
    super::study::stop_all(app);
    super::hand::stop_all(app);
    super::chores::cancel_all(app);
    super::cursor_runtime::stop_all(app);
    super::circle::cancel_all(app);
    super::clip::cancel_all(app);
    super::handoff_runtime::cancel_all(app);
    let _ = super::annotate::clear(app);
}
pub fn account_changed<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(runtime) = app.try_state::<Arc<Runtime>>() {
        if let Some(handle) = runtime.app.as_ref() {
            cancel(handle);
        }
    }
}
pub fn set_paused(app: &AppHandle, paused: bool) -> Result<(), String> {
    of(app)?.update(|config| {
        config.paused = paused;
        Ok(())
    })?;
    apply(app)
}

/// A temporary CATCH pause leaves the stored opt-in and individual rule choices intact.
pub fn catch_paused(app: &AppHandle) -> bool {
    of(app).is_ok_and(|r| r.catch_paused.load(Ordering::Acquire))
}
pub fn toggle_catch_pause(app: &AppHandle) -> Result<(), String> {
    let r = of(app)?;
    r.catch_paused.fetch_xor(true, Ordering::AcqRel);
    if let Some(window) = app.get_webview_window("screen-mac-catch") {
        let _ = super::overlay::hide(&window);
    }
    Ok(())
}
pub fn pause_for_an_hour(app: &AppHandle) -> Result<(), String> {
    set_paused(app, true)?;
    let generation = of(app)?.generation.load(Ordering::Acquire);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-pause-hour".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3600));
            // Serialize the ownership check with all preference changes. A resumed, re-paused,
            // disabled or otherwise changed session never inherits an earlier timer.
            let Ok(r) = of(&handle) else {
                return;
            };
            let mut state = r.state.lock().unwrap_or_else(|p| p.into_inner());
            if !controls::resume_due(
                generation,
                r.generation.load(Ordering::Acquire),
                state.config.paused,
                state.config.is_on(),
            ) {
                return;
            }
            let mut next = state.config.clone();
            next.paused = false;
            if config::save(&r.path, &next).is_err() {
                return;
            }
            r.generation.fetch_add(1, Ordering::AcqRel);
            state.config = next;
            drop(state);
            let _ = apply(&handle);
        })
        .map_err(|_| "Couldn't start the pause timer.")?;
    Ok(())
}

impl island::Actions for Runtime {
    fn view(&self) -> IslandView {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let (tool, clearable) = self
            .app
            .as_ref()
            .map(drawing::view)
            .unwrap_or((Tool::None, false));
        IslandView {
            tool,
            shape: state.preferences.shape,
            mic: self.app.as_ref().is_some_and(super::ask::listening),
            silent: state.config.circle.silent,
            activity: if state.config.paused {
                Activity::Paused
            } else {
                Activity::Ready
            },
            clearable,
            help: state.config.help,
            watching: self.app.as_ref().is_some_and(super::study::watching),
        }
    }
    fn set_tool(&self, tool: Tool) -> Result<(), String> {
        let (config, _) = self.snapshot();

        if tool.draws() && (config.paused || !config.privacy.show_in_captures) {
            return Err("Enable visible Mac annotations in local settings before drawing. Mac cannot guarantee hiding annotations from other screen recordings.".into());
        }
        self.preference(|preferences| preferences.tool = tool)?;
        let shape = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .shape;
        let app = self.app.as_ref().ok_or(DRAW_BLOCKER)?;
        if let Err(error) = drawing::set_tool(app, tool, shape) {
            let _ = drawing::close(app);
            return Err(error);
        }
        Ok(())
    }
    fn set_shape(&self, shape: Shape) -> Result<(), String> {
        self.preference(|preferences| preferences.shape = shape)?;
        let Some(app) = self.app.as_ref() else {
            return Ok(());
        };
        let tool = drawing::view(app).0;
        if tool.draws() {
            drawing::set_tool(app, tool, shape)?;
        }
        Ok(())
    }
    fn toggle_mic(&self) -> Result<(), String> {
        super::ask::toggle_mic(self.app.as_ref().ok_or(DRAW_BLOCKER)?)
    }
    fn toggle_watch(&self) -> Result<(), String> {
        super::study::toggle_watch(self.app.as_ref().ok_or(DRAW_BLOCKER)?)
    }
    fn set_help(&self, level: HelpLevel) -> Result<(), String> {
        self.update(|config| {
            config.help = level;
            Ok(())
        })
    }
    fn clear(&self) -> Result<(), String> {
        drawing::clear(self.app.as_ref().ok_or(DRAW_BLOCKER)?)
    }
    fn close(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let app = self.app.as_ref().ok_or(DRAW_BLOCKER)?;
        cancel(app);
        media::close(app)?;
        drawing::close(app)?;
        self.preference(|preferences| preferences.tool = Tool::None)
    }
    fn music_panel(&self, open: bool) -> Result<(), String> {
        let (config, _) = self.snapshot();
        if open && (config.paused || !config.privacy.show_in_captures) {
            return Err(
                "Enable visible Mac overlays in local settings before showing music details."
                    .into(),
            );
        }
        media::panel(self.app.as_ref().ok_or(DRAW_BLOCKER)?, open)
    }
    fn music_control(&self, control: Control) -> Result<(), String> {
        let (config, _) = self.snapshot();
        if config.paused || !config.privacy.show_in_captures {
            return Err("Mac overlays are paused or disabled.".into());
        }
        media::control(self.app.as_ref().ok_or(DRAW_BLOCKER)?, control)
    }
    fn music_pin(&self) -> Result<(), String> {
        media::pin(self.media_app()?)
    }
    fn music_open(&self, id: &str) -> Result<(), String> {
        media::open_pin(self.media_app()?, id)
    }
    fn music_unpin(&self, id: &str) -> Result<(), String> {
        media::unpin(self.media_app()?, id)
    }
}

pub fn toggle_island(app: &AppHandle) -> Result<(), String> {
    if island::shown(app) {
        use island::Actions;
        of(app)?.close()?;
        island::hide(app)
    } else {
        island::show(app)
    }
}

#[cfg(test)]
mod tests {
    use super::island::Actions;
    use super::*;
    fn fixture() -> (Runtime, PathBuf) {
        let dir = std::env::temp_dir().join(format!("neb-mac-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (Runtime::new(config::path_in(&dir)), dir)
    }
    #[test]
    fn saves_preferences_without_erasing_other_settings() {
        let (runtime, dir) = fixture();
        runtime
            .update(|c| {
                c.circle.silent = true;
                c.handoff.sender_name = "Student".into();
                Ok(())
            })
            .unwrap();
        runtime.set_help(HelpLevel::Answer).unwrap();
        runtime.set_shape(Shape::Ellipse).unwrap();
        let reloaded = Runtime::new(config::path_in(&dir));
        assert!(reloaded.snapshot().0.circle.silent);
        assert_eq!(reloaded.snapshot().0.handoff.sender_name, "Student");
        assert_eq!(reloaded.view().help, HelpLevel::Answer);
        assert_eq!(reloaded.view().shape, Shape::Ellipse);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn absent_services_never_report_running() {
        let (runtime, dir) = fixture();
        assert!(runtime.toggle_mic().is_err());
        assert!(runtime.toggle_watch().is_err());
        assert!(runtime.set_tool(Tool::Pen).is_err());
        assert!(!runtime.view().mic && !runtime.view().watching && !runtime.view().clearable);
        assert_eq!(runtime.view().tool, Tool::None);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_save_keeps_memory_and_generation_unchanged() {
        let (runtime, dir) = fixture();
        std::fs::write(&runtime.path, b"original").unwrap();
        std::fs::create_dir(runtime.path.with_extension("json.tmp")).unwrap();
        let before = runtime.snapshot().0;
        assert!(runtime
            .update(|c| {
                c.paused = true;
                Ok(())
            })
            .is_err());
        assert_eq!(runtime.snapshot().0, before);
        assert_eq!(runtime.generation.load(Ordering::Acquire), 1);
        assert_eq!(std::fs::read(&runtime.path).unwrap(), b"original");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
