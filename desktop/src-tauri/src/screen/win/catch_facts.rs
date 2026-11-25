//! What CATCH ME's rules need to know about the window in front (docs/CURSOR_MODES.md, G),
//! read with UI Automation on its own thread so the cursor's frames never wait for it.
//!
//! Only what a rule needs, only when a guarded control is on screen, and nothing kept: the
//! number of recipients and attachment chips, whether the draft mentions an attachment, how many
//! files and folders Explorer has selected, and the line being typed in a terminal. The draft's
//! and the terminal's text are read, looked at, and dropped; they never leave this computer and
//! are never logged.

use std::collections::HashSet;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationValuePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ItemTypePropertyId, UIA_NamePropertyId,
    UIA_SelectionItemIsSelectedPropertyId, UIA_TextPatternId, UIA_TreeItemControlTypeId,
    UIA_ValuePatternId,
};

use crate::screen::cursor::catch::{looks_like_attachment, mentions_attachment, Facts, Rule};

/// The most elements looked at for names in one window.
const MAX_ELEMENTS: i32 = 4000;
/// The most draft text read from one field.
const DRAFT_CHARS: i32 = 8000;

/// A request for facts about a window.
pub struct Request {
    pub window: isize,
    pub generation: u64,
    pub rules: Vec<Rule>,
}

/// The latest answer: for which window and collection, and the facts.
#[derive(Debug, Clone, Default)]
pub struct Answer {
    pub window: isize,
    pub generation: u64,
    pub facts: Facts,
}

/// The facts thread. Dropping it ends the thread.
pub struct FactsWorker {
    requests: Sender<Job>,
    latest: Arc<Mutex<Answer>>,
    line: Arc<Mutex<Option<String>>>,
}

enum Job {
    Facts(Request),
    Line,
}

impl FactsWorker {
    pub fn start() -> Option<Self> {
        let (requests, jobs) = mpsc::channel::<Job>();
        let latest = Arc::new(Mutex::new(Answer::default()));
        let line = Arc::new(Mutex::new(None));
        let (out, line_out) = (Arc::clone(&latest), Arc::clone(&line));
        std::thread::Builder::new()
            .name("mew-cursor-facts".into())
            .spawn(move || run(jobs, out, line_out))
            .ok()?;
        Some(Self {
            requests,
            latest,
            line,
        })
    }

    /// Asks for fresh facts (answered on the worker; read with `latest`).
    pub fn ask(&self, request: Request) {
        let _ = self.requests.send(Job::Facts(request));
    }

    pub fn latest(&self) -> Answer {
        self.latest
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Asks for the terminal line being typed (read with `take_line`, never waited for).
    pub fn ask_line(&self) {
        let _ = self.requests.send(Job::Line);
    }

    /// The line read since the last ask, if the focus is in a terminal.
    pub fn take_line(&self) -> Option<String> {
        self.line.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

fn run(jobs: Receiver<Job>, latest: Arc<Mutex<Answer>>, line: Arc<Mutex<Option<String>>>) {
    // SAFETY: COM for this thread, balanced below.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    // SAFETY: in-process COM activation on a thread with COM initialised.
    let client: Option<IUIAutomation> =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok();
    if let Some(client) = client {
        while let Ok(job) = jobs.recv() {
            match job {
                Job::Facts(mut request) => {
                    // Only the newest request matters.
                    let mut wants_line = false;
                    while let Ok(next) = jobs.try_recv() {
                        match next {
                            Job::Facts(r) => request = r,
                            Job::Line => wants_line = true,
                        }
                    }
                    let facts = facts_for(&client, &request);
                    *latest.lock().unwrap_or_else(|p| p.into_inner()) = Answer {
                        window: request.window,
                        generation: request.generation,
                        facts,
                    };
                    if wants_line {
                        *line.lock().unwrap_or_else(|p| p.into_inner()) = terminal_line(&client);
                    }
                }
                Job::Line => {
                    *line.lock().unwrap_or_else(|p| p.into_inner()) = terminal_line(&client);
                }
            }
        }
    }
    if com {
        // SAFETY: balances the successful CoInitializeEx above.
        unsafe { CoUninitialize() };
    }
}

fn facts_for(client: &IUIAutomation, request: &Request) -> Facts {
    let mut facts = Facts::default();
    // SAFETY: plain COM calls; Windows validates the handle; interfaces drop at scope end.
    let Ok(root) = (unsafe { client.ElementFromHandle(HWND(request.window as *mut _)) }) else {
        return facts;
    };
    let wants = |r: Rule| request.rules.contains(&r);
    if wants(Rule::ReplyAll) || wants(Rule::Attachment) {
        let names = all_names(client, &root);
        if wants(Rule::ReplyAll) {
            facts.recipients = recipients(&names);
        }
        if wants(Rule::Attachment) {
            facts.attachments = names
                .iter()
                .filter(|(_, n)| looks_like_attachment(n))
                .count() as u32;
            facts.mentions_attachment =
                drafts(client, &root).iter().any(|t| mentions_attachment(t));
        }
    }
    if wants(Rule::Delete) {
        let (files, folders) = selection(client, &root);
        facts.selected_files = files;
        facts.selected_folders = folders;
    }
    facts
}

/// Every element's control type and name in the window (at most 4000).
fn all_names(client: &IUIAutomation, root: &IUIAutomationElement) -> Vec<(i32, String)> {
    // SAFETY: plain COM calls with a cache request built here.
    unsafe {
        let Ok(cache) = client.CreateCacheRequest() else {
            return Vec::new();
        };
        let _ = cache.AddProperty(UIA_NamePropertyId);
        let _ = cache.AddProperty(UIA_ControlTypePropertyId);
        let Ok(all) = client.CreateTrueCondition() else {
            return Vec::new();
        };
        let Ok(found) = root.FindAllBuildCache(TreeScope_Descendants, &all, &cache) else {
            return Vec::new();
        };
        let n = found.Length().unwrap_or(0).min(MAX_ELEMENTS);
        (0..n)
            .filter_map(|i| {
                let e = found.GetElement(i).ok()?;
                let name = e.CachedName().ok()?.to_string();
                let ty = e.CachedControlType().ok()?.0;
                (!name.trim().is_empty()).then_some((ty, name))
            })
            .collect()
    }
}

/// Distinct recipients: names that hold an address, plus "and 12 others" / "+12".
pub fn recipients(names: &[(i32, String)]) -> u32 {
    let mut addresses = HashSet::new();
    let mut more = 0u32;
    for (_, name) in names {
        for word in name
            .split(|c: char| c.is_whitespace() || matches!(c, ';' | ',' | '<' | '>' | '(' | ')'))
        {
            let w = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.');
            if let Some((user, host)) = w.split_once('@') {
                if !user.is_empty() && host.contains('.') {
                    addresses.insert(w.to_lowercase());
                }
            }
        }
        let lower = name.to_lowercase();
        for marker in [" others", " more", " autres", " জন"] {
            if let Some(at) = lower.find(marker) {
                let digits: String = lower[..at]
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                if let Ok(n) = digits.parse::<u32>() {
                    more = more.max(n);
                }
            }
        }
    }
    addresses.len() as u32 + more
}

/// The text of the window's editable fields (a draft's body and subject), each at most 8000
/// characters, at most five fields.
fn drafts(client: &IUIAutomation, root: &IUIAutomationElement) -> Vec<String> {
    // SAFETY: plain COM calls on live interfaces; patterns checked before use.
    unsafe {
        let edit = client.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_EditControlTypeId.0),
        );
        let doc = client.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_DocumentControlTypeId.0),
        );
        let (Ok(edit), Ok(doc)) = (edit, doc) else {
            return Vec::new();
        };
        let Ok(either) = client.CreateOrCondition(&edit, &doc) else {
            return Vec::new();
        };
        let Ok(found) = root.FindAll(TreeScope_Descendants, &either) else {
            return Vec::new();
        };
        let n = found.Length().unwrap_or(0).min(5);
        (0..n)
            .filter_map(|i| {
                let e = found.GetElement(i).ok()?;
                if e.CurrentIsPassword().is_ok_and(|p| p.as_bool()) {
                    return None;
                }
                text_of(&e)
            })
            .collect()
    }
}

fn text_of(e: &IUIAutomationElement) -> Option<String> {
    // SAFETY: plain COM calls; patterns checked before use.
    unsafe {
        if let Ok(text) = e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            if let Ok(range) = text.DocumentRange() {
                if let Ok(s) = range.GetText(DRAFT_CHARS) {
                    return Some(s.to_string());
                }
            }
        }
        let value: IUIAutomationValuePattern = e.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
        let s = value.CurrentValue().ok()?.to_string();
        Some(s.chars().take(DRAFT_CHARS as usize).collect())
    }
}

/// Files and folders selected in the window's items view (the folder tree's selection is the
/// current folder, not something to delete, so tree rows don't count).
fn selection(client: &IUIAutomation, root: &IUIAutomationElement) -> (u32, u32) {
    // SAFETY: plain COM calls with a cache request built here.
    unsafe {
        let Ok(cache) = client.CreateCacheRequest() else {
            return (0, 0);
        };
        let _ = cache.AddProperty(UIA_ItemTypePropertyId);
        let _ = cache.AddProperty(UIA_ControlTypePropertyId);
        let Ok(selected) = client
            .CreatePropertyCondition(UIA_SelectionItemIsSelectedPropertyId, &VARIANT::from(true))
        else {
            return (0, 0);
        };
        let Ok(found) = root.FindAllBuildCache(TreeScope_Descendants, &selected, &cache) else {
            return (0, 0);
        };
        let (mut files, mut folders) = (0u32, 0u32);
        for i in 0..found.Length().unwrap_or(0).min(10_000) {
            let Ok(e) = found.GetElement(i) else { continue };
            if e.CachedControlType()
                .is_ok_and(|t| t == UIA_TreeItemControlTypeId)
            {
                continue;
            }
            let kind = e
                .CachedItemType()
                .map(|s| s.to_string().to_lowercase())
                .unwrap_or_default();
            if kind.contains("folder") || kind.contains("dossier") || kind.contains("ফোল্ডার")
            {
                folders += 1;
            } else {
                files += 1;
            }
        }
        (files, folders)
    }
}

/// Terminals CATCH ME reads the typed line of.
pub fn is_terminal_app(process: &str) -> bool {
    matches!(
        process,
        "windowsterminal.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "cmd.exe"
            | "conhost.exe"
            | "openconsole.exe"
            | "code.exe"
            | "wsl.exe"
            | "bash.exe"
    )
}

/// The last non-empty visible line of the focused terminal (VS Code: only when its terminal,
/// not its editor, has the focus).
fn terminal_line(client: &IUIAutomation) -> Option<String> {
    // SAFETY: plain COM calls; patterns checked before use.
    unsafe {
        let focused = client.GetFocusedElement().ok()?;
        if focused.CurrentIsPassword().is_ok_and(|p| p.as_bool()) {
            return None;
        }
        let name = focused
            .CurrentName()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let class = focused
            .CurrentClassName()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let vs_code_editor = class.contains("monaco") || name.contains("Editor content");
        if vs_code_editor {
            return None;
        }
        let pattern: IUIAutomationTextPattern = focused
            .GetCurrentPatternAs(UIA_TextPatternId)
            .ok()
            .or_else(|| {
                // Windows Terminal: the focus is on the control, the text is on its text area.
                let child = client
                    .ControlViewWalker()
                    .ok()?
                    .GetFirstChildElement(&focused)
                    .ok()?;
                child.GetCurrentPatternAs(UIA_TextPatternId).ok()
            })?;
        let ranges = pattern.GetVisibleRanges().ok()?;
        let mut text = String::new();
        for i in 0..ranges.Length().unwrap_or(0).min(64) {
            if let Ok(range) = ranges.GetElement(i) {
                if let Ok(s) = range.GetText(16_000) {
                    text.push_str(&s.to_string());
                    text.push('\n');
                }
            }
        }
        text.lines()
            .rev()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(400).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_recipients_from_addresses_and_others() {
        let names: Vec<(i32, String)> = [
            "To: Sam Lee <sam@example.com>; ana@example.org",
            "Cc: team@example.com",
            "sam@example.com",
            "and 12 others",
            "Not an address: @handle or me@localhost",
        ]
        .iter()
        .map(|n| (0, (*n).to_owned()))
        .collect();
        assert_eq!(recipients(&names), 3 + 12);
        assert_eq!(recipients(&[(0, "Reply all".into())]), 0);
    }

    #[test]
    fn knows_terminals() {
        assert!(is_terminal_app("windowsterminal.exe") && is_terminal_app("pwsh.exe"));
        assert!(!is_terminal_app("outlook.exe"));
    }
}

#[cfg(test)]
mod idle {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    use super::super::uia_targets::TargetWatcher;
    use super::*;

    fn cpu_ms() -> f64 {
        let (mut a, mut b, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        // SAFETY: valid out pointers for our own process.
        unsafe {
            GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut kernel, &mut user).unwrap()
        };
        let t = |f: FILETIME| {
            ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 10_000.0
        };
        t(kernel) + t(user)
    }

    /// Live (ignored by default): CATCH ME idling on this desktop for 10 s, as the engine thread
    /// does it (the UI Automation watcher, the facts worker, a tick every 250 ms). Prints the
    /// share of one core used.
    #[test]
    #[ignore]
    fn catch_me_idles_under_one_percent() {
        let watcher = TargetWatcher::start(Arc::new(|_: &str| true)).unwrap();
        let targets = watcher.targets();
        let facts = FactsWorker::start().unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let (cpu0, wall0) = (cpu_ms(), Instant::now());
        let rules = crate::screen::cursor::catch::Rule::ALL;
        while wall0.elapsed() < Duration::from_secs(10) {
            let set = targets.latest();
            let guarded = crate::screen::cursor::catch::guarded(&set, &rules);
            if !guarded.is_empty() && is_terminal_app(&set.process) {
                facts.ask_line();
            }
            let _ = facts.take_line();
            std::thread::sleep(Duration::from_millis(250));
        }
        let used = (cpu_ms() - cpu0) / wall0.elapsed().as_secs_f64() / 1000.0 * 100.0;
        println!("CATCH ME idle: {used:.3} % of one core over 10 s");
        assert!(used < 1.0, "{used}");
    }
}
