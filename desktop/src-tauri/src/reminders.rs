//! Review reminders: the web app reports what's due, Windows shows a notification.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

/// At most one reminder this often, whatever the page asks.
const MIN_GAP: Duration = Duration::from_secs(30 * 60);
const MAX_TITLE_CHARS: usize = 80;

#[derive(Default)]
pub struct Reminders {
    last: Mutex<Option<Instant>>,
    /// Saved moments' checks (K8), reminded apart from concepts: opt-in, at most twice a day.
    last_checks: Mutex<Option<Instant>>,
    /// Coach mode's skills due for a re-check (S5): at most twice a day too.
    last_skills: Mutex<Option<Instant>>,
}

/// Saved moments' check reminders (K8 §4.7: desktop notifications are opt-in) come this rarely.
const CHECKS_GAP: Duration = Duration::from_secs(12 * 60 * 60);

/// "2 checks from what you saved are due", or None when there are none.
pub fn checks_text(count: u32) -> Option<String> {
    match count.min(999) {
        0 => None,
        1 => Some("A check from something you saved is due.".to_owned()),
        n => Some(format!("{n} checks from things you saved are due.")),
    }
}

/// Called by the web app (only its origin may), when the student turned these reminders on.
#[tauri::command]
pub fn notify_checks(
    app: AppHandle,
    reminders: State<'_, Reminders>,
    count: u32,
) -> Result<bool, String> {
    let Some(body) = checks_text(count) else {
        return Ok(false);
    };
    let mut last = reminders
        .last_checks
        .lock()
        .map_err(|_| "reminder state unavailable")?;
    if last.is_some_and(|at| at.elapsed() < CHECKS_GAP) {
        return Ok(false);
    }
    app.notification()
        .builder()
        .title("Quick check")
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    *last = Some(Instant::now());
    Ok(true)
}

/// Skills due for a re-check (S5) come as rarely as saved moments' checks.
const SKILLS_GAP: Duration = Duration::from_secs(12 * 60 * 60);

/// "Time to try “Pivot tables” on your own", or None when none is due. `first` comes from a web
/// page: data, cleaned like a concept's title.
pub fn skills_text(count: u32, first: Option<&str>) -> Option<String> {
    if count == 0 {
        return None;
    }
    let first = clean_title(first);
    Some(match (count.min(999), first.is_empty()) {
        (1, false) => format!("Time to try “{first}” on your own."),
        (1, true) => "A skill is ready to try on your own.".to_owned(),
        (n, false) => format!("{n} skills are ready to try on your own, starting with “{first}”."),
        (n, true) => format!("{n} skills are ready to try on your own."),
    })
}

/// Called by the web app (only its origin may) with the coach-mode skills due for a re-check.
#[tauri::command]
pub fn notify_skills(
    app: AppHandle,
    reminders: State<'_, Reminders>,
    count: u32,
    first: Option<String>,
) -> Result<bool, String> {
    let Some(body) = skills_text(count, first.as_deref()) else {
        return Ok(false);
    };
    let mut last = reminders
        .last_skills
        .lock()
        .map_err(|_| "reminder state unavailable")?;
    if last.is_some_and(|at| at.elapsed() < SKILLS_GAP) {
        return Ok(false);
    }
    app.notification()
        .builder()
        .title("Try it on your own")
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    *last = Some(Instant::now());
    Ok(true)
}

/// A title from a web page, as data: control characters dropped, length capped.
fn clean_title(title: Option<&str>) -> String {
    title
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The text of a reminder, or None when there's nothing to say. `first` comes from a web page,
/// so it is treated as data: control characters dropped, length capped.
pub fn reminder_text(count: u32, first: Option<&str>) -> Option<String> {
    if count == 0 {
        return None;
    }
    let first = clean_title(first);
    Some(match (count.min(999), first.is_empty()) {
        (1, false) => format!("“{first}” is ready for review."),
        (1, true) => "A concept is ready for review.".to_owned(),
        (n, false) => format!("{n} concepts are ready for review, starting with “{first}”."),
        (n, true) => format!("{n} concepts are ready for review."),
    })
}

/// Called by the web app (only its origin may, see `lib.rs`) with the number of concepts due.
#[tauri::command]
pub fn notify_due(
    app: AppHandle,
    reminders: State<'_, Reminders>,
    count: u32,
    first: Option<String>,
) -> Result<bool, String> {
    let Some(body) = reminder_text(count, first.as_deref()) else {
        return Ok(false);
    };
    let mut last = reminders
        .last
        .lock()
        .map_err(|_| "reminder state unavailable")?;
    if last.is_some_and(|at| at.elapsed() < MIN_GAP) {
        return Ok(false);
    }
    app.notification()
        .builder()
        .title("Time for a review")
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    *last = Some(Instant::now());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_many_checks_are_due() {
        assert_eq!(checks_text(0), None);
        assert_eq!(
            checks_text(1).as_deref(),
            Some("A check from something you saved is due.")
        );
        assert_eq!(
            checks_text(4).as_deref(),
            Some("4 checks from things you saved are due.")
        );
    }

    #[test]
    fn says_which_skill_to_try_alone() {
        assert_eq!(skills_text(0, Some("Pivot tables")), None);
        assert_eq!(
            skills_text(1, Some("Pivot tables")).as_deref(),
            Some("Time to try “Pivot tables” on your own.")
        );
        assert_eq!(
            skills_text(2, Some("Pivot\ntables")).as_deref(),
            Some("2 skills are ready to try on your own, starting with “Pivottables”.")
        );
        assert_eq!(
            skills_text(3, None).as_deref(),
            Some("3 skills are ready to try on your own.")
        );
    }

    #[test]
    fn says_what_is_due() {
        assert_eq!(reminder_text(0, Some("Friction")), None);
        assert_eq!(
            reminder_text(1, Some("Friction")).as_deref(),
            Some("“Friction” is ready for review.")
        );
        assert_eq!(
            reminder_text(3, Some("Friction")).as_deref(),
            Some("3 concepts are ready for review, starting with “Friction”.")
        );
        assert_eq!(
            reminder_text(2, None).as_deref(),
            Some("2 concepts are ready for review.")
        );
    }

    #[test]
    fn treats_the_title_as_untrusted_data() {
        let long = "x".repeat(500);
        let text = reminder_text(1, Some(&format!("Fric\u{0}tion\n{long}"))).unwrap();
        assert!(!text.contains('\n') && !text.contains('\u{0}'));
        assert!(text.chars().count() < 120);
        assert_eq!(
            reminder_text(5000, None).as_deref(),
            Some("999 concepts are ready for review.")
        );
    }
}
