//! DO IT at run time (docs/CURSOR_MODES.md, F): one allowlisted chore, then a replay.
//!
//! 1. What to do: the plain chores are recognised on the device (`doit::local_action`, no
//!    question spent); then the chore the intent route chose along with `do_it`, if it chose
//!    one (no second call); anything else is one plan (`POST /api/screen/plan`, mode "do"), whose
//!    action is checked against the allowlist (`plan::parse_plan`). Off the list, Neb offers a
//!    SHOW ME lesson instead: it never improvises.
//! 2. The chore: find a file (and open it, asking which when unsure), open a Settings page, save
//!    the recipe on the page (from its JSON-LD with no model call when it has one), or rename
//!    photos by date (a before → after table first, an undo log, one-step undo).
//! 3. The replay: Neb's ghost cursor and a caption show where things are ("Found lease.pdf in
//!    Documents → Housing → 2026"). "Show me how" within two minutes turns it into a lesson.
//!
//! No chore sends a key or a click (the input check in `cursor/doit.rs`).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use super::clip;
use super::coach;
use super::cursor::doit::{executor_for, local_action};
use super::cursor::find::{self, breadcrumb, choose, Choice};
use super::cursor::plan::{parse_plan, plan_body, DoAction, FileKind, Mode};
use super::cursor::recipe::{self, Recipe};
use super::cursor::rename::{self, UNDO_FILE};
use super::cursor::rename_rule::{self, RenameRule};
use super::cursor::settings_uri;
use super::cursor_run;
use super::destination::{parse_places, DestinationOut, Page, Place};
use super::device_call::{self, CallError};
use super::page;
use super::pipeline::Captured;
use super::win::{chores, http, input, uia};

/// "Show me how" turns the last chore into a lesson within this long.
const SHOW_ME_HOW_WITHIN: Duration = Duration::from_secs(120);
/// The most of a recipe page read (bytes).
const PAGE_MAX: usize = 3_000_000;
const RECIPE_BOOK: &str = "Recipe Book";

static RECENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// The last chore's request, if it was within two minutes ("show me how").
pub fn recent_goal() -> Option<String> {
    let recent = RECENT.lock().unwrap_or_else(|p| p.into_inner());
    recent
        .as_ref()
        .filter(|(_, at)| at.elapsed() < SHOW_ME_HOW_WITHIN)
        .map(|(g, _)| g.clone())
}

fn remember(goal: &str) {
    *RECENT.lock().unwrap_or_else(|p| p.into_inner()) = Some((goal.to_owned(), Instant::now()));
}

/// What a finished chore shows in its replay.
struct Done {
    verb: String,
    crumbs: Vec<String>,
}

/// Starts DO IT for `goal` on its own thread (searching and fetching take a moment).
/// `chore`: what the intent route already chose (checked), so no plan is needed.
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    goal: String,
    chore: Option<DoAction>,
    captured: Captured,
) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mew-cursor-do".into())
        .spawn(move || {
            // SAFETY: COM for this thread (UI Automation, the dialogs); balanced below.
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            run(&handle, &goal, chore, captured);
            if com {
                // SAFETY: balances the successful CoInitializeEx above.
                unsafe { CoUninitialize() };
            }
        });
    if spawned.is_err() {
        coach::notify(app, "I couldn't start that just now.");
    }
}

fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    page::dispatch(app, page::SAY, json!({ "text": text }));
}

/// "Undo the rename", "undo that rename".
pub fn is_undo(goal: &str) -> bool {
    let g = goal.to_lowercase();
    g.contains("undo") && g.contains("rename")
}

fn run<R: Runtime>(app: &AppHandle<R>, goal: &str, chore: Option<DoAction>, captured: Captured) {
    if is_undo(goal) {
        drop(captured);
        undo_rename(app);
        return;
    }
    // The device's own reading first (free), then what the intent route chose (already paid
    // for), and only then a plan.
    let started = Instant::now();
    let local = local_action(goal);
    let from = if local.is_some() {
        "the device's rules"
    } else if chore.is_some() {
        "the meaning call"
    } else {
        "a plan call"
    };
    let (action, speech) = match local.or(chore) {
        Some(action) => (action, None),
        None => match plan(app, goal) {
            Ok((action, speech)) => (action, Some(speech)),
            Err(message) => {
                coach::notify(app, &message);
                return;
            }
        },
    };
    let Some(_executor) = executor_for(&action) else {
        // Not one of Neb's chores: it never improvises, it shows how.
        drop(captured);
        say(
            app,
            speech
                .as_deref()
                .unwrap_or("That one's yours to do, but I can show you how."),
        );
        if !cursor_run::show_me(app, goal) {
            coach::notify(
                app,
                "That's not one I do for you. Ask me how, and I'll show you where to click.",
            );
        }
        return;
    };
    let window = captured.meta.window;
    // The action's kind only (a find's words, a page's name stay out of the log).
    let kind = match &action {
        DoAction::FindFile { .. } => "find_file",
        DoAction::OpenSetting { .. } => "open_setting",
        DoAction::SetTheme { .. } => "set_theme",
        DoAction::SaveRecipe => "save_recipe",
        DoAction::BatchRename => "batch_rename",
        DoAction::RenameFiles { .. } => "rename_files",
        DoAction::ShowMe => "show_me",
    };
    eprintln!(
        "[timing] do it: {kind}, chosen by {from} in {} ms",
        started.elapsed().as_millis()
    );
    let outcome = match action {
        DoAction::FindFile { query, kind, since } => {
            drop(captured);
            find_file(&query, kind, since.as_deref())
        }
        DoAction::OpenSetting { page } => {
            drop(captured);
            open_setting(&page)
        }
        DoAction::SetTheme { dark } => {
            drop(captured);
            set_theme(app, dark)
        }
        DoAction::SaveRecipe => save_recipe(app, captured),
        DoAction::BatchRename => {
            drop(captured);
            batch_rename(app, window)
        }
        DoAction::RenameFiles { rule, which } => {
            drop(captured);
            rename_files(app, window, &rule, which.as_deref())
        }
        DoAction::ShowMe => return,
    };
    eprintln!(
        "[timing] do it: {kind} {} in {} ms",
        match &outcome {
            Ok(_) => "done",
            Err(m) if m.is_empty() => "cancelled",
            Err(_) => "failed",
        },
        started.elapsed().as_millis()
    );
    match outcome {
        Ok(done) => {
            remember(goal);
            // Nothing opened (a switch flipped): there's no path to replay.
            if !done.crumbs.is_empty() {
                let from =
                    input::cursor().map_or((0.0, 0.0), |(x, y)| (f64::from(x), f64::from(y)));
                cursor_run::replay(app, done.crumbs, done.verb, from);
            }
            cursor_run::count(app, "do_it_done");
        }
        Err(message) if message.is_empty() => {} // cancelled by the student
        Err(message) => coach::notify(app, &message),
    }
}

/// One plan for a chore the device didn't recognise: its action, and what to say.
fn plan<R: Runtime>(app: &AppHandle<R>, goal: &str) -> Result<(DoAction, String), String> {
    let body = plan_body(Mode::Do, goal, None, &[], None, None);
    let bytes = device_call::post(app, "api/screen/plan", "plan", &body).map_err(|e| match e {
        CallError::Account(m) | CallError::Limited(m) => m,
        CallError::Busy => "Lots of questions right now. Try again in a moment.".into(),
        CallError::Failed => "I couldn't work that out just now. Try again in a moment.".into(),
    })?;
    let plan = parse_plan(&bytes).ok_or("Neb sent an unexpected reply.")?;
    Ok((plan.action.unwrap_or(DoAction::ShowMe), plan.speech))
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_owned()
}

fn find_file(query: &str, kind: FileKind, since: Option<&str>) -> Result<Done, String> {
    let terms = find::terms(query);
    let sql =
        find::search_sql(&terms, kind, since).ok_or("Tell me a word from the file's name.")?;
    let found = chores::search_index(&sql);
    let index = match choose(&found, &terms) {
        Choice::Nothing => {
            return Err("I couldn't find that file. If it's in a folder Windows doesn't search, open it yourself and I'll remember where it is next time.".into())
        }
        Choice::Certain(i) => i,
        Choice::Ask(options) => {
            let profile = std::env::var("USERPROFILE").ok();
            let labels: Vec<String> = options
                .iter()
                .map(|&i| {
                    let f = &found[i];
                    format!("{}\n{}", file_name(&f.path), breadcrumb(&f.path, profile.as_deref()))
                })
                .collect();
            let picked = chores::dialog(
                "Which one did you mean?",
                "I found a few that match.",
                None,
                &labels,
                "Open",
            )
            .ok_or(String::new())?;
            options[picked]
        }
    };
    let path = &found[index].path;
    if !chores::open_document(path) {
        return Err("I found it but Windows wouldn't open it.".into());
    }
    let profile = std::env::var("USERPROFILE").ok();
    let crumb = breadcrumb(path, profile.as_deref());
    Ok(Done {
        verb: format!("Found {} in", file_name(path)),
        crumbs: crumb.split(" → ").map(str::to_owned).collect(),
    })
}

fn open_setting(page: &str) -> Result<Done, String> {
    let uri = settings_uri::uri_for(page).ok_or("I don't know that Settings page.")?;
    if !chores::open_settings(uri) {
        return Err("Windows wouldn't open Settings just now.".into());
    }
    let crumbs = std::iter::once("Settings".to_owned())
        .chain(
            settings_uri::breadcrumb_for(page)
                .unwrap_or_default()
                .split(" → ")
                .map(str::to_owned),
        )
        .collect();
    Ok(Done {
        verb: "Opened".into(),
        crumbs,
    })
}

/// Dark or light mode, switched (not just its page opened). Asked again when it's already that
/// way, nothing opens: Neb just says so.
fn set_theme<R: Runtime>(app: &AppHandle<R>, dark: bool) -> Result<Done, String> {
    let name = if dark { "Dark mode" } else { "Light mode" };
    let said = if chores::dark_mode() == dark {
        format!("{name} is already on.")
    } else if chores::set_dark_mode(dark) {
        format!("{name} is on.")
    } else {
        return Err(format!(
            "Windows wouldn't switch to {} just now.",
            name.to_lowercase()
        ));
    };
    say(app, &said);
    coach::notify(app, &said);
    Ok(Done {
        verb: String::new(),
        crumbs: Vec::new(),
    })
}

fn save_recipe<R: Runtime>(app: &AppHandle<R>, captured: Captured) -> Result<Done, String> {
    let window = captured.meta.window.map(|w| HWND(w as *mut _));
    let url = window.and_then(|w| uia::Automation::new().ok()?.address_bar(w));
    let url = url
        .and_then(|u| super::source::sanitize_url(&u))
        .filter(|u| u.scheme() == "https");
    let title = window.map(super::win::target::window_title);
    let html = url.as_ref().and_then(|u| {
        let mut body = Vec::new();
        let status = http::get(u, |chunk| {
            if body.len() < PAGE_MAX {
                body.extend_from_slice(chunk);
            }
        });
        matches!(status, Ok(200)).then(|| String::from_utf8_lossy(&body).into_owned())
    });
    let page_url = url.as_ref().map(|u| u.to_string());
    // The page's own markup first: no model call. Otherwise the page's text (or, when it
    // couldn't be read, what's on the screen, redacted on the device) is structured.
    let rules = coach::privacy_of(app).redaction;
    let recipe = recipe::read_or_structure(
        html.as_deref(),
        page_url.as_deref(),
        || captured.detail.text.text_in(captured.meta.bounds, &rules),
        |text| structure_recipe(app, page_url.as_deref(), title.as_deref(), text),
    )?;
    let destination = recipe_book(app);
    let text = recipe.to_text(8_000);
    let saved_title = recipe.title.clone();
    clip::save_capture_with_text(app, captured, &text, title, page_url, destination)?;
    Ok(Done {
        verb: "Saved to".into(),
        crumbs: vec!["Notebooks".into(), RECIPE_BOOK.into(), saved_title],
    })
}

/// The server's structuring of a page's text (one question), checked.
fn structure_recipe<R: Runtime>(
    app: &AppHandle<R>,
    url: Option<&str>,
    title: Option<&str>,
    text: &str,
) -> Result<Recipe, String> {
    let text: String = text.chars().take(recipe::TEXT_MAX).collect();
    let body = json!({ "url": url, "title": title.map(|t| t.chars().take(300).collect::<String>()), "text": text });
    let bytes = device_call::post(
        app,
        "api/screen/recipe",
        "recipe",
        body.to_string().as_bytes(),
    )
    .map_err(|e| match e {
        CallError::Account(m) | CallError::Limited(m) => m,
        _ => "I couldn't read the recipe just now. Try again in a moment.".into(),
    })?;
    parse_structured(&bytes, url).ok_or_else(|| "I couldn't find a recipe on this page.".into())
}

pub fn parse_structured(bytes: &[u8], url: Option<&str>) -> Option<Recipe> {
    #[derive(serde::Deserialize)]
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
    if !r.found || r.ingredients.len() > recipe::MAX_ITEMS || r.steps.len() > recipe::MAX_ITEMS {
        return None;
    }
    Some(Recipe {
        title: plain(&r.title, 200)?,
        original_title: r.original_title.as_deref().and_then(|t| plain(t, 200)),
        ingredients: r.ingredients.iter().filter_map(|i| plain(i, 400)).collect(),
        steps: r.steps.iter().filter_map(|s| plain(s, 400)).collect(),
        servings: r.servings.as_deref().and_then(|s| plain(s, 60)),
        time: r.time.as_deref().and_then(|s| plain(s, 60)),
        source_url: url.map(str::to_owned),
        thumbnail: None,
    })
}

/// The "Recipe Book" notebook, or a new one (made when the clip is saved; Unsorted if it
/// can't be). None when the notebooks can't be read (the server files the clip itself).
fn recipe_book<R: Runtime>(app: &AppHandle<R>) -> Option<DestinationOut> {
    let bytes = device_call::post(app, "api/screen/destinations", "destinations", b"{}").ok()?;
    let places = parse_places(&bytes)?;
    if let Some(book) = places
        .iter()
        .find(|p| p.path.len() == 1 && p.path[0].trim().eq_ignore_ascii_case(RECIPE_BOOK))
    {
        return Some(DestinationOut::from(book));
    }
    let unsorted = places
        .iter()
        .find(|p| p.path.len() == 1 && p.path[0].eq_ignore_ascii_case("Unsorted"))?;
    Some(DestinationOut::from(&Place {
        node_id: unsorted.node_id.clone(),
        path: unsorted.path.clone(),
        page: Page::FromScreen,
        create: Some(RECIPE_BOOK.into()),
        root: true,
    }))
}

fn undo_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(UNDO_FILE))
}

fn batch_rename<R: Runtime>(app: &AppHandle<R>, window: Option<isize>) -> Result<Done, String> {
    let window =
        window.filter(|w| super::win::uia_targets::class_of(HWND(*w as *mut _)) == "CabinetWClass");
    let Some(window) = window else {
        return Err(
            "Open the folder with the photos in File Explorer, select them, and ask me again."
                .into(),
        );
    };
    let photos = chores::explorer_photos(window);
    let renames = rename::plan(&photos);
    if renames.is_empty() {
        return Err(
            "Those photos already have their dates as names (or none of them are photos).".into(),
        );
    }
    let n = renames.len();
    let picked = chores::dialog(
        &format!(
            "Rename {n} photo{} by the date taken?",
            if n == 1 { "" } else { "s" }
        ),
        &rename::preview(&renames, 8),
        Some(&rename::preview(&renames, rename::MAX_FILES)),
        &[],
        "Rename",
    );
    if picked.is_none() {
        return Err(String::new());
    }
    let log = undo_path(app).ok_or("I couldn't keep an undo note, so I didn't rename anything.")?;
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|_| "I couldn't keep an undo note, so I didn't rename anything.")?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let count = rename::apply(&renames, &log, now)
        .map_err(|_| "I couldn't keep an undo note, so I didn't rename anything.")?;
    let folder = renames[0]
        .0
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    coach::notify(app, &format!(
        "Renamed {count} photos. To put the names back, say \"undo the rename\" or use Undo rename in the tray menu."
    ));
    Ok(Done {
        verb: format!("Renamed {count} in"),
        crumbs: vec![folder],
    })
}

/// The files selected in File Explorer, renamed the way the student said (`rename_rule`): a
/// before → after table first (Cancel is the default), then the renames, logged for undo.
fn rename_files<R: Runtime>(
    app: &AppHandle<R>,
    window: Option<isize>,
    rule: &RenameRule,
    which: Option<&str>,
) -> Result<Done, String> {
    // A File Explorer window, or the desktop (its files are renamed the same way).
    let window = window.and_then(|w| {
        let class = super::win::uia_targets::class_of(HWND(w as *mut _));
        if class == "CabinetWClass" {
            Some(w)
        } else {
            chores::is_desktop_class(&class).then_some(chores::DESKTOP)
        }
    });
    let Some(window) = window else {
        return Err(
            "Select what to rename in File Explorer or on the desktop, then ask me again.".into(),
        );
    };
    let items = chores::explorer_items(window);
    let selected: Vec<PathBuf> = items
        .iter()
        .filter(|(_, s)| *s)
        .map(|(p, _)| p.clone())
        .collect();
    // A file named aloud ("rename the file called notes to …") is the one renamed, selected or
    // not; when the name doesn't single one out, the selection is (the table shows which).
    let named = which.and_then(|which| {
        let all: Vec<PathBuf> = items.iter().map(|(p, _)| p.clone()).collect();
        rename_rule::named_item(&all, which).cloned()
    });
    let selected = match named {
        Some(item) => vec![item],
        None if !selected.is_empty() => selected,
        None if which.is_some() => return Err(
            "I couldn't tell which file you meant. Select it and ask me again."
                .into(),
        ),
        None => {
            return Err(
                "Select the files to rename first (in File Explorer or on the desktop), then ask me again.".into(),
            )
        }
    };
    let renames = rename_rule::plan(&selected, rule, |p| p.exists())?;
    let n = renames.len();
    let picked = chores::dialog(
        &format!("Rename {n} item{}?", if n == 1 { "" } else { "s" }),
        &rename::preview(&renames, 8),
        (n > 8)
            .then(|| rename::preview(&renames, rename::MAX_FILES))
            .as_deref(),
        &[],
        "Rename",
    );
    if picked.is_none() {
        return Err(String::new());
    }
    let log = undo_path(app).ok_or("I couldn't keep an undo note, so I didn't rename anything.")?;
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|_| "I couldn't keep an undo note, so I didn't rename anything.")?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let count = rename::apply(&renames, &log, now)
        .map_err(|_| "I couldn't keep an undo note, so I didn't rename anything.")?;
    if count == 0 {
        return Err("Windows wouldn't rename those (they may be open in another app).".into());
    }
    let folder = renames[0]
        .0
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // Counts only: a notification is logged, and file names never go in the log.
    let skipped = n - count;
    coach::notify(
        app,
        &format!(
            "Renamed {count} item{}{}. To put the names back, say \"undo the rename\" or use Undo rename in the tray menu.",
            if count == 1 { "" } else { "s" },
            if skipped > 0 {
                format!(" ({skipped} couldn't be: open in another app, or the name was taken)")
            } else {
                String::new()
            }
        ),
    );
    Ok(Done {
        verb: format!("Renamed {count} in"),
        crumbs: vec![folder],
    })
}

/// Puts the last rename back (the tray's "Undo rename", or "undo the rename").
pub fn undo_rename<R: Runtime>(app: &AppHandle<R>) {
    let Some(log) = undo_path(app) else {
        return;
    };
    match rename::undo(&log) {
        Ok(0) => coach::notify(app, "There's no rename to undo."),
        Ok(n) => {
            coach::notify(
                app,
                &format!("Put back {n} name{}.", if n == 1 { "" } else { "s" }),
            );
            cursor_run::count(app, "do_it_undone");
        }
        Err(_) => coach::notify(app, "I couldn't put the names back."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_structured_recipe_is_checked() {
        let ok = r#"{"found":true,"title":"Spiced rice","originalTitle":"ভুনা","ingredients":["1 cup rice"],"steps":["Wash."],"servings":null,"time":"40 min"}"#.as_bytes();
        let r = parse_structured(ok, Some("https://x.example/r")).unwrap();
        assert_eq!(r.original_title.as_deref(), Some("ভুনা"));
        assert_eq!(r.source_url.as_deref(), Some("https://x.example/r"));
        assert!(parse_structured(br#"{"found":false,"title":"","originalTitle":null,"ingredients":[],"steps":[],"servings":null,"time":null}"#, None).is_none());
        assert!(parse_structured(br#"{"found":true,"title":"a\u0007","originalTitle":null,"ingredients":[],"steps":[],"servings":null,"time":null}"#, None).is_none());
        assert!(is_undo("undo the rename") && is_undo("Undo that rename please"));
        assert!(!is_undo("rename these photos by date"));
    }
}
