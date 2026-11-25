//! The session window and the key moments (docs/HANDOFF_FEATURE.md §2.1, §4): by default the
//! last 90 minutes, at most 20 moments and 30 snapshots; of the moments, the six that matter most
//! (recent, showing an error or warning, asked about), shown in the order they happened.

use super::timeline::{Event, Moment, Snapshot};

pub const MAX_MOMENTS: usize = 20;
pub const MAX_SNAPSHOTS: usize = 30;
pub const KEY_MOMENTS: usize = 6;
pub const WINDOWS_MIN: [u32; 3] = [30, 90, 180];

const PROBLEM_WORDS: &[&str] = &[
    "error",
    "failed",
    "failure",
    "exception",
    "warning",
    "denied",
    "#ref!",
    "#value!",
    "#name?",
    "traceback",
    "panic",
    "fatal",
    "cannot",
    "can't",
    "not found",
    "undefined",
];

/// The moments and snapshots inside the last `minutes` (newest kept when there are too many).
pub fn session(events: &[Event], now: i64, minutes: u32) -> (Vec<Moment>, Vec<Snapshot>) {
    let from = now - i64::from(minutes) * 60;
    let mut moments: Vec<Moment> = Vec::new();
    let mut snapshots: Vec<Snapshot> = Vec::new();
    for e in events.iter().filter(|e| e.at() >= from && e.at() <= now) {
        match e {
            Event::Moment(m) => moments.push(m.clone()),
            Event::Snapshot(s) => snapshots.push(s.clone()),
        }
    }
    let skip = moments.len().saturating_sub(MAX_MOMENTS);
    let skip_s = snapshots.len().saturating_sub(MAX_SNAPSHOTS);
    (moments.split_off(skip), snapshots.split_off(skip_s))
}

/// Whether a moment shows something going wrong.
pub fn shows_problem(m: &Moment) -> bool {
    let text = format!(
        "{} {} {}",
        m.ocr,
        m.question.as_deref().unwrap_or(""),
        m.explanation.as_deref().unwrap_or("")
    )
    .to_lowercase();
    PROBLEM_WORDS.iter().any(|w| text.contains(w))
}

/// The indexes of the key moments (at most six), in the order they happened.
pub fn key_moments(moments: &[Moment], now: i64) -> Vec<usize> {
    let oldest = moments.iter().map(|m| m.at).min().unwrap_or(now);
    let span = (now - oldest).max(1) as f64;
    let mut scored: Vec<(usize, f64)> = moments
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let recency = 1.0 - (now - m.at) as f64 / span;
            let problem = if shows_problem(m) { 2.0 } else { 0.0 };
            let asked = if m.question.as_deref().is_some_and(|q| !q.trim().is_empty()) {
                1.0
            } else {
                0.0
            };
            (i, recency + problem + asked)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    let mut picked: Vec<usize> = scored
        .into_iter()
        .take(KEY_MOMENTS)
        .map(|(i, _)| i)
        .collect();
    picked.sort_by_key(|&i| moments[i].at);
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn moment(at: i64, ocr: &str, question: Option<&str>) -> Moment {
        Moment {
            at,
            app: "code.exe".into(),
            window: "w".into(),
            jpeg: String::new(),
            width: 10,
            height: 10,
            question: question.map(str::to_owned),
            explanation: None,
            ink: Vec::new(),
            ocr: ocr.into(),
            url: None,
        }
    }

    #[test]
    fn the_window_is_the_last_ninety_minutes_capped() {
        let now = 100_000;
        let mut events: Vec<Event> = (0..30)
            .map(|i| Event::Moment(moment(now - 60 * i, "", None)))
            .collect();
        events.push(Event::Moment(moment(now - 91 * 60, "", None)));
        let (moments, _) = session(&events, now, 90);
        assert_eq!(moments.len(), MAX_MOMENTS);
        assert!(moments.iter().all(|m| m.at >= now - 90 * 60));
    }

    #[test]
    fn errors_and_questions_beat_plain_recency() {
        let now = 10_000;
        let mut ms: Vec<Moment> = (0..10)
            .map(|i| moment(now - 100 * (10 - i), "", None))
            .collect();
        ms[1].ocr = "Exception: duplicate key value violates unique constraint".into();
        ms[2].question = Some("why does it send twice?".into());
        ms[3].ocr = "Sheet1 shows #REF!".into();
        let picked = key_moments(&ms, now);
        assert_eq!(picked.len(), KEY_MOMENTS);
        for i in [1, 2, 3] {
            assert!(picked.contains(&i), "{picked:?}");
        }
        assert!(
            picked.windows(2).all(|w| ms[w[0]].at <= ms[w[1]].at),
            "chronological"
        );
    }
}
