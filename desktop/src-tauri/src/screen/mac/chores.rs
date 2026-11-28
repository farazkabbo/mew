//! Four allowlisted DO IT chores. No input injection. Files are searched only in ordinary
//! user folders, executable-like results are revealed, and photo renames require a native
//! before/after confirmation and the existing atomic no-replace undo implementation.
use super::{capture_session, clip, pipeline::Intent, runtime, service_call};
use crate::screen::{
    cursor::{
        doit,
        find::{self, Choice, Found},
        plan::{self, DoAction, FileKind, Mode},
        recipe::{self, Recipe},
        rename,
    },
    destination::{self, Page, Place},
    intent, page,
    secret::SecretBytes,
};
use serde::Deserialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
const SCRIPT: &str = include_str!("chores.js");
#[derive(Default)]
struct Chores {
    serial: AtomicU64,
    busy: Mutex<bool>,
    recent: Mutex<Option<(String, Instant)>>,
}
fn state(app: &AppHandle) -> Result<tauri::State<'_, Chores>, String> {
    app.try_state().ok_or_else(|| "DO IT is not ready.".into())
}
pub fn setup(app: &AppHandle) {
    app.manage(Chores::default());
}
pub fn cancel_all(app: &AppHandle) {
    if let Ok(s) = state(app) {
        s.serial.fetch_add(1, Ordering::AcqRel);
    }
}
pub fn recent_goal(app: &AppHandle) -> Option<String> {
    state(app)
        .ok()?
        .recent
        .lock()
        .ok()?
        .as_ref()
        .filter(|(_, at)| at.elapsed() < Duration::from_secs(120))
        .map(|(s, _)| s.clone())
}
fn live(app: &AppHandle, generation: u64, serial: u64) -> bool {
    let Ok(r) = runtime::of(app) else {
        return false;
    };
    let (c, reset) = r.snapshot();
    !reset
        && c.is_on()
        && !c.paused
        && r.generation.load(Ordering::Acquire) == generation
        && state(app).is_ok_and(|s| s.serial.load(Ordering::Acquire) == serial)
}
fn say(app: &AppHandle, text: &str) {
    page::dispatch(app, page::SAY, serde_json::json!({"text":text}));
}
pub fn route_words(app: &AppHandle, text: &str) -> Result<bool, String> {
    route_intent(app, text, intent::intent_of(text, false))
}
pub fn route_intent(
    app: &AppHandle,
    text: &str,
    requested: intent::Intent,
) -> Result<bool, String> {
    let undo = text.to_lowercase().contains("undo") && text.to_lowercase().contains("rename");
    if !undo && doit::local_action(text).is_none() && requested != intent::Intent::DoIt {
        return Ok(false);
    }
    let s = state(app)?;
    let mut busy = s.busy.lock().unwrap_or_else(|p| p.into_inner());
    if *busy {
        return Err("Finish the current chore first.".into());
    }
    *busy = true;
    let serial = s.serial.fetch_add(1, Ordering::AcqRel) + 1;
    let generation = runtime::of(app)?.generation.load(Ordering::Acquire);
    let text = text.to_owned();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("neb-mac-do-it".into())
        .spawn(move || {
            let current = || live(&handle, generation, serial);
            let result = if undo {
                undo_rename(&handle, &current)
            } else {
                execute(&handle, &text, generation, &current)
            };
            if current() {
                match result {
                    Ok(message) => {
                        super::counts::add(
                            &handle,
                            if undo { "do_it_undone" } else { "do_it_done" },
                        );
                        say(&handle, &message);
                        super::cursor_runtime::replay(&handle, vec![], message.clone());
                        if let Ok(s) = state(&handle) {
                            *s.recent.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some((text, Instant::now()));
                        }
                    }
                    Err(error) if !error.is_empty() => say(&handle, &error),
                    _ => {}
                }
            }
            if let Ok(s) = state(&handle) {
                *s.busy.lock().unwrap_or_else(|p| p.into_inner()) = false;
            }
        })
        .map_err(|_| {
            *busy = false;
            "Couldn't start DO IT.".to_owned()
        })?;
    Ok(true)
}
fn execute(
    app: &AppHandle,
    goal: &str,
    generation: u64,
    current: &dyn Fn() -> bool,
) -> Result<String, String> {
    if !current() {
        return Err("The chore was cancelled.".into());
    }
    let action = if let Some(a) = doit::local_action(goal) {
        a
    } else {
        let body = SecretBytes::from_vec(plan::plan_body(Mode::Do, goal, None, &[], None, None));
        let reply = service_call::post(app, "api/screen/plan", "do-it", body.as_slice(), &|| {
            !current()
        })
        .map_err(|e| e.to_string())?;
        plan::parse_plan(reply.as_slice())
            .ok_or("Neb sent an invalid chore.")?
            .action
            .unwrap_or(DoAction::ShowMe)
    };
    if !current() {
        return Err("The chore was cancelled.".into());
    }
    match action {
        DoAction::FindFile { query, kind, since } => {
            find_file(&query, kind, since.as_deref(), current)
        }
        DoAction::OpenSetting { page } => open_setting(&page, current),
        DoAction::SaveRecipe => save_recipe(app, generation, current),
        DoAction::BatchRename => batch_rename(app, current),
        DoAction::ShowMe => {
            let _ = super::hand::route_words(app, &format!("show me {goal}"));
            Ok("That task needs your actions. I'll show you how.".into())
        }
    }
}
pub(super) fn native(
    argv: &[String],
    current: &dyn Fn() -> bool,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    if !current() {
        return Err("The chore was cancelled.".into());
    }
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT, "--"])
        .args(argv)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Couldn't open the Mac service.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The Mac service was unavailable.")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let started = Instant::now();
    let mut output = None;
    let result = loop {
        if !current() {
            break Err("The chore was cancelled.".into());
        }
        if started.elapsed() >= timeout {
            break Err("The Mac service took too long.".into());
        }
        if output.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) if bytes.len() > 1024 * 1024 => {
                    break Err("The Mac service reply was too large.".into())
                }
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => {
                    break Err("Couldn't read the Mac service reply.".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait(){Ok(Some(exit))if !exit.success()=>break Err("The Mac service was cancelled or unavailable. Allow Finder automation in System Settings if asked.".into()),Ok(Some(_))if output.is_some()=>break Ok(output.take().unwrap()),Err(_)=>break Err("The Mac service stopped.".into()),_=>std::thread::sleep(Duration::from_millis(10))}
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| "Couldn't locate your home folder.".into())
}
fn kind_matches(path: &Path, kind: FileKind) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match kind {
        FileKind::Any => true,
        FileKind::Pdf => ext == "pdf",
        FileKind::Document => {
            ["docx", "doc", "odt", "rtf", "txt", "pdf", "md", "pages"].contains(&ext.as_str())
        }
        FileKind::Spreadsheet => ["xlsx", "xls", "csv", "ods", "numbers"].contains(&ext.as_str()),
        FileKind::Presentation => ["pptx", "ppt", "odp", "key"].contains(&ext.as_str()),
        FileKind::Image => [
            "jpg", "jpeg", "png", "heic", "gif", "webp", "bmp", "tif", "tiff",
        ]
        .contains(&ext.as_str()),
    }
}
fn search(
    roots: Vec<PathBuf>,
    terms: &[String],
    kind: FileKind,
    since: Option<&str>,
    current: &dyn Fn() -> bool,
) -> Vec<Found> {
    let start = Instant::now();
    let mut queue = roots.into_iter().map(|p| (p, 0)).collect::<Vec<_>>();
    let mut found = vec![];
    let mut seen = 0;
    while let Some((dir, depth)) = queue.pop() {
        if !current() || start.elapsed() > Duration::from_secs(3) || seen >= 30000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen >= 30000 || !current() || start.elapsed() > Duration::from_secs(3) {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name.chars().any(char::is_control) {
                continue;
            }
            let Ok(kind_entry) = entry.file_type() else {
                continue;
            };
            if kind_entry.is_symlink() {
                continue;
            }
            if kind_entry.is_dir() {
                if depth < 8
                    && !matches!(
                        path.extension().and_then(|e| e.to_str()),
                        Some("app" | "bundle" | "framework" | "photoslibrary")
                    )
                {
                    queue.push((path, depth + 1));
                }
                continue;
            }
            if !kind_entry.is_file() || !kind_matches(&path, kind) {
                continue;
            }
            let lower = name.to_lowercase();
            if !terms.iter().all(|t| lower.contains(t)) {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(clip::rfc3339)
                .unwrap_or_default();
            if since.is_some_and(|s| modified.get(..10).is_some_and(|m| m < s)) {
                continue;
            }
            found.push(Found {
                path: path.to_string_lossy().into_owned(),
                modified,
                rank: 1.,
            });
            if found.len() >= find::RESULTS {
                return found;
            }
        }
    }
    found.sort_by(|a, b| b.modified.cmp(&a.modified));
    found
}
fn find_file(
    query: &str,
    kind: FileKind,
    since: Option<&str>,
    current: &dyn Fn() -> bool,
) -> Result<String, String> {
    let terms = find::terms(query);
    if terms.is_empty() {
        return Err("Tell me a word from the file's name.".into());
    }
    let home = home()?;
    let roots = ["Documents", "Downloads", "Desktop", "Pictures"]
        .map(|n| home.join(n))
        .to_vec();
    let found = search(roots, &terms, kind, since, current);
    let chosen=match find::choose(&found,&terms){Choice::Nothing=>return Err("I couldn't find it in Documents, Downloads, Desktop or Pictures. Open the file's folder and try again.".into()),Choice::Certain(i)=>i,Choice::Ask(options)=>{
        let labels=options.iter().map(|i|found[*i].path.strip_prefix(&home.to_string_lossy().to_string()).unwrap_or(&found[*i].path).to_owned()).collect::<Vec<_>>();
        let bytes=native(&["choose".into(),"Which file did you mean?".into(),serde_json::to_string(&labels).map_err(|_|"Invalid choices.")?],current,Duration::from_secs(120))?;
        #[derive(Deserialize)]struct Pick{index:Option<usize>}let i=serde_json::from_slice::<Pick>(&bytes).ok().and_then(|p|p.index).ok_or_else(String::new)?;*options.get(i).ok_or("Invalid file choice.")?
    }};
    let path = PathBuf::from(&found[chosen].path);
    let canonical = path.canonicalize().map_err(|_| "The file moved.")?;
    if !canonical.starts_with(&home) || !canonical.is_file() {
        return Err("The file moved outside your folders.".into());
    }
    let reveal = reveal_only(&canonical);
    let bytes = native(
        &[
            "open".into(),
            canonical.to_string_lossy().into_owned(),
            if reveal { "reveal" } else { "open" }.into(),
        ],
        current,
        Duration::from_secs(5),
    )?;
    let reply: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Couldn't open the file.")?;
    if reply.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err("macOS couldn't open that file.".into());
    }
    Ok(format!(
        "{} {}",
        if reveal { "Revealed" } else { "Opened" },
        canonical
            .strip_prefix(&home)
            .unwrap_or(&canonical)
            .display()
    ))
}
pub(super) fn reveal_only(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    find::runs_something(&path.to_string_lossy())
        || !matches!(
            ext.as_str(),
            "pdf"
                | "txt"
                | "md"
                | "rtf"
                | "doc"
                | "docx"
                | "odt"
                | "pages"
                | "xls"
                | "xlsx"
                | "csv"
                | "ods"
                | "numbers"
                | "ppt"
                | "pptx"
                | "key"
                | "odp"
                | "jpg"
                | "jpeg"
                | "png"
                | "heic"
                | "gif"
                | "webp"
                | "bmp"
                | "tif"
                | "tiff"
                | "mp3"
                | "m4a"
                | "wav"
                | "mp4"
                | "mov"
        )
}
fn settings_uri(page: &str) -> Option<(&'static str, &'static str)> {
    Some(match page {
        "display" | "night_light" => ("com.apple.Displays-Settings.extension", "Displays"),
        "sound" => ("com.apple.Sound-Settings.extension", "Sound"),
        "notifications" => (
            "com.apple.Notifications-Settings.extension",
            "Notifications",
        ),
        "focus" => ("com.apple.Focus-Settings.extension", "Focus"),
        "power" | "battery" => ("com.apple.Battery-Settings.extension", "Battery"),
        "storage" => ("com.apple.settings.Storage", "Storage"),
        "bluetooth" => ("com.apple.BluetoothSettings", "Bluetooth"),
        "printers" => (
            "com.apple.Print-Scan-Settings.extension",
            "Printers & Scanners",
        ),
        "mouse" => ("com.apple.Mouse-Settings.extension", "Mouse"),
        "touchpad" => ("com.apple.Trackpad-Settings.extension", "Trackpad"),
        "network" | "wifi" | "airplane_mode" => ("com.apple.wifi-settings-extension", "Wi-Fi"),
        "vpn" => (
            "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension",
            "VPN",
        ),
        "background" => ("com.apple.Wallpaper-Settings.extension", "Wallpaper"),
        "colors" | "personalization" | "themes" => {
            ("com.apple.Appearance-Settings.extension", "Appearance")
        }
        "lock_screen" => ("com.apple.Lock-Screen-Settings.extension", "Lock Screen"),
        "start" | "taskbar" => ("com.apple.Desktop-Settings.extension", "Desktop & Dock"),
        "apps" | "default_apps" | "startup_apps" => (
            "com.apple.LoginItems-Settings.extension",
            "Login Items & Extensions",
        ),
        "your_info" | "sign_in_options" => (
            "com.apple.Users-Groups-Settings.extension",
            "Users & Groups",
        ),
        "date_time" => ("com.apple.Date-Time-Settings.extension", "Date & Time"),
        "language" | "typing" | "clipboard" => (
            "com.apple.Localization-Settings.extension",
            "Language & Region",
        ),
        "text_size" | "narrator" | "magnifier" | "contrast_themes" | "mouse_pointer" => (
            "com.apple.Accessibility-Settings.extension",
            "Accessibility",
        ),
        "windows_update" => (
            "com.apple.Software-Update-Settings.extension",
            "Software Update",
        ),
        "privacy" | "camera_privacy" | "microphone_privacy" | "location_privacy" => (
            "com.apple.settings.PrivacySecurity.extension",
            "Privacy & Security",
        ),
        "about" => ("com.apple.SystemProfiler.AboutExtension", "About"),
        "multitasking" => ("com.apple.Desktop-Settings.extension", "Desktop & Dock"),
        _ => return None,
    })
}
fn open_setting(page: &str, current: &dyn Fn() -> bool) -> Result<String, String> {
    let (uri, label) = settings_uri(page).ok_or("That Settings page isn't available.")?;
    let bytes = native(
        &[
            "settings".into(),
            format!("x-apple.systempreferences:{uri}"),
        ],
        current,
        Duration::from_secs(5),
    )?;
    let reply: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Couldn't open System Settings.")?;
    if reply.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err("macOS couldn't open System Settings.".into());
    }
    Ok(format!("Opened System Settings → {label}"))
}
fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(rename::UNDO_FILE))
        .map_err(|_| "Couldn't locate the rename undo log.".into())
}
fn batch_rename(app: &AppHandle, current: &dyn Fn() -> bool) -> Result<String, String> {
    let bytes = native(&["photos".into()], current, Duration::from_secs(15))?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Item {
        path: PathBuf,
        taken: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Photos {
        photos: Vec<Item>,
    }
    let items: Photos =
        serde_json::from_slice(&bytes).map_err(|_| "Couldn't read Finder's photo selection.")?;
    if items.photos.len() > rename::MAX_FILES {
        return Err("Select at most 500 photos.".into());
    }
    let home = home()?;
    let mut photos = vec![];
    for item in items.photos {
        if !kind_matches(&item.path, FileKind::Image) {
            continue;
        }
        let metadata =
            std::fs::symlink_metadata(&item.path).map_err(|_| "A selected photo moved.")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Only ordinary photo files can be renamed.".into());
        }
        let path = item
            .path
            .canonicalize()
            .map_err(|_| "A selected photo moved.")?;
        if !path.starts_with(&home) {
            return Err("Keep the selected photos in your own folders.".into());
        }
        photos.push(rename::Photo {
            path,
            taken: item.taken,
            modified: clip::rfc3339(
                metadata
                    .modified()
                    .map_err(|_| "Couldn't read a photo's date.")?,
            ),
        });
    }
    let plan = rename::plan(&photos);
    if plan.is_empty() {
        return Err("Those photos already use their dates, or no photos were selected.".into());
    }
    let preview = rename::preview(&plan, rename::MAX_FILES);
    let bytes = native(
        &[
            "confirm".into(),
            format!(
                "Rename {} photos by date?\n\n{preview}\n\nUndo rename restores these names.",
                plan.len()
            ),
        ],
        current,
        Duration::from_secs(120),
    )?;
    if serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("confirmed").and_then(|b| b.as_bool()))
        != Some(true)
    {
        return Err(String::new());
    }
    if !current() {
        return Err("The rename was cancelled.".into());
    }
    let log = log_path(app)?;
    std::fs::create_dir_all(log.parent().ok_or("Invalid undo log folder.")?)
        .map_err(|_| "Couldn't keep an undo log; no names were changed.")?;
    if rename::read_log(&log).is_some_and(|l| l.entries.iter().any(|e| e.done)) {
        return Err("Undo the previous photo rename before starting another.".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let count = rename::apply_cancellable(&plan, &log, now, current).map_err(|_| {
        "Couldn't complete the rename. Use Undo rename to restore completed changes."
    })?;
    Ok(format!(
        "Renamed {count} photos. Say ‘undo the rename’ to restore their names."
    ))
}
fn undo_rename(app: &AppHandle, current: &dyn Fn() -> bool) -> Result<String, String> {
    if !current() {
        return Err("The undo was cancelled.".into());
    }
    let log = log_path(app)?;
    let n =
        rename::undo_cancellable(&log, current).map_err(|_| "Couldn't restore the photo names.")?;
    Ok(if n == 0 {
        "There's no photo rename to undo.".into()
    } else {
        format!("Restored {n} photo names.")
    })
}
fn parse_recipe(bytes: &[u8]) -> Option<Recipe> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        found: bool,
        title: String,
        original_title: Option<String>,
        ingredients: Vec<String>,
        steps: Vec<String>,
        servings: Option<String>,
        time: Option<String>,
    }
    let r: Reply = serde_json::from_slice(bytes).ok()?;
    let plain = |s: &str, max: usize| {
        let s = s.trim();
        (!s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control))
            .then(|| s.to_owned())
    };
    if !r.found
        || r.ingredients.is_empty()
        || r.steps.is_empty()
        || r.ingredients.len() > recipe::MAX_ITEMS
        || r.steps.len() > recipe::MAX_ITEMS
    {
        return None;
    }
    Some(Recipe {
        title: plain(&r.title, 200)?,
        original_title: r.original_title.as_deref().and_then(|t| plain(t, 200)),
        ingredients: r
            .ingredients
            .iter()
            .map(|i| plain(i, 400))
            .collect::<Option<Vec<_>>>()?,
        steps: r
            .steps
            .iter()
            .map(|s| plain(s, 400))
            .collect::<Option<Vec<_>>>()?,
        servings: r.servings.as_deref().and_then(|s| plain(s, 60)),
        time: r.time.as_deref().and_then(|s| plain(s, 60)),
        source_url: None,
        thumbnail: None,
    })
}
fn save_recipe(
    app: &AppHandle,
    generation: u64,
    current: &dyn Fn() -> bool,
) -> Result<String, String> {
    let frame = capture_session::capture_window(app, Intent::Clip, generation)?;
    let stamp = service_call::credential_stamp(app).map_err(|e| e.to_string())?;
    let meta = frame.server_meta();
    let config = runtime::of(app)?.snapshot().0;
    let text = frame
        .text()
        .text_in(meta.bounds, &config.privacy.redaction)
        .chars()
        .take(recipe::TEXT_MAX)
        .collect::<String>();
    if text.trim().is_empty() {
        return Err("No readable recipe text was found on screen.".into());
    }
    let body = SecretBytes::from_vec(
        serde_json::to_vec(&serde_json::json!({"url":null,"title":null,"text":text}))
            .map_err(|_| "Couldn't prepare the recipe.")?,
    );
    let reply =
        service_call::post_bound(app, "api/screen/recipe", body.as_slice(), &stamp, &|| {
            !current() || !capture_session::is_current(app, &frame)
        })
        .map_err(|e| e.to_string())?;
    let recipe = parse_recipe(reply.as_slice())
        .ok_or("Neb couldn't find a complete recipe in this screen.")?;
    let reply = service_call::post_bound(app, "api/screen/destinations", b"{}", &stamp, &|| {
        !current()
    })
    .map_err(|e| e.to_string())?;
    let places = destination::parse_places(reply.as_slice())
        .ok_or("Couldn't read notebook destinations.")?;
    let place = places
        .iter()
        .find(|p| p.path.len() == 1 && p.path[0].eq_ignore_ascii_case("Recipe Book"))
        .cloned()
        .or_else(|| {
            places
                .iter()
                .find(|p| p.path.len() == 1 && p.path[0].eq_ignore_ascii_case("Unsorted"))
                .map(|p| Place {
                    node_id: p.node_id.clone(),
                    path: p.path.clone(),
                    page: Page::FromScreen,
                    create: Some("Recipe Book".into()),
                    root: true,
                })
        });
    if !current() || service_call::credential_stamp(app).ok() != Some(stamp) {
        return Err("The recipe save was cancelled.".into());
    }
    clip::save_capture_with_text(app, frame, &recipe.to_text(8000), place)?;
    Ok(format!("Saved {} to Recipe Book.", recipe.title))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_files_that_can_run_are_only_revealed() {
        for name in [
            "run.sh",
            "foo.app",
            "script.command",
            "payload.pkg",
            "image.dmg",
            "macro.xlsm",
            "unsafe.html",
        ] {
            assert!(reveal_only(Path::new(name)), "{name}");
        }
        for name in ["notes.pdf", "photo.heic", "draft.pages"] {
            assert!(!reveal_only(Path::new(name)));
        }
    }
    #[test]
    fn every_shared_settings_key_has_a_fixed_mac_destination() {
        for (key, _, _) in crate::screen::cursor::settings_uri::PAGES {
            assert!(settings_uri(key).is_some(), "{key}");
        }
        assert!(settings_uri("https://evil.test").is_none());
    }
    #[test]
    fn recipe_refuses_partial_or_oversized_values() {
        assert!(parse_recipe(br#"{"found":true,"title":"Soup","ingredients":["water"],"steps":["boil"],"originalTitle":null,"servings":null,"time":null}"#).is_some());
        assert!(parse_recipe(br#"{"found":true,"title":"Soup","ingredients":[],"steps":[],"originalTitle":null,"servings":null,"time":null}"#).is_none());
    }
    #[test]
    fn file_search_is_scoped_skips_links_and_respects_cancellation() {
        let root = std::env::temp_dir().join(format!("neb-chores-search-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("synthetic lease.pdf"), b"fixture").unwrap();
        std::fs::write(root.join("lease.sh"), b"fixture").unwrap();
        let terms = vec!["lease".into()];
        let got = search(vec![root.clone()], &terms, FileKind::Pdf, None, &|| true);
        assert_eq!(got.len(), 1);
        assert!(got[0].path.ends_with("synthetic lease.pdf"));
        assert!(search(vec![root.clone()], &terms, FileKind::Any, None, &|| false).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
