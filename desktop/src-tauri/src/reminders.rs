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
}

/// The text of a reminder, or None when there's nothing to say. `first` comes from a web page,
/// so it is treated as data: control characters dropped, length capped.
pub fn reminder_text(count: u32, first: Option<&str>) -> Option<String> {
    if count == 0 {
        return None;
    }
    let first: String = first
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_owned();
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
