//! Where a clip came from (S3 §3.3): the app, its window title, and for browsers the page's
//! link, trimmed so it can't carry a secret (decision 9). Pure: no I/O, fully tested.
//!
//! Titles and links are read only when the student saves a clip, shown to them in the preview,
//! and never logged.

use tauri::Url;

/// Longest window title kept (the server's limit).
pub const TITLE_CHARS: usize = 200;
const URL_CHARS: usize = 2000;
/// Longest video a timestamp may point into (a day).
const MAX_VIDEO_SECONDS: u32 = 86_400;

/// Browsers whose address bar we read (Chromium's omnibox and Firefox's URL bar).
pub fn is_browser(app: &str) -> bool {
    matches!(
        app,
        "msedge.exe"
            | "chrome.exe"
            | "brave.exe"
            | "vivaldi.exe"
            | "opera.exe"
            | "arc.exe"
            | "firefox.exe"
    )
}

/// A window title as stored: no control characters, trimmed, at most `TITLE_CHARS`. Browsers
/// append their own name ("… - Microsoft Edge"), which is dropped.
pub fn clean_title(raw: &str, app: &str) -> Option<String> {
    let mut title: String = raw.chars().filter(|c| !c.is_control()).collect();
    for suffix in [
        " - Microsoft\u{200b} Edge",
        " - Microsoft Edge",
        " - Google Chrome",
        " - Brave",
        " - Vivaldi",
        " - Opera",
        " — Mozilla Firefox",
        " - Mozilla Firefox",
    ] {
        if is_browser(app) {
            if let Some(stripped) = title.strip_suffix(suffix) {
                title = stripped.to_owned();
            }
        }
    }
    let title = title.trim();
    (!title.is_empty()).then(|| title.chars().take(TITLE_CHARS).collect())
}

/// What the address bar shows, as a link we're willing to keep: https only; no user name,
/// password, query or fragment, except a YouTube video's `v` (and the time, set separately).
/// Address bars often hide the scheme ("youtube.com/watch?v=…"), so https is assumed then.
pub fn sanitize_url(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > URL_CHARS || raw.contains(char::is_whitespace) {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&with_scheme).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    // A real domain name: no IP addresses, no intranet single labels, no localhost.
    let is_domain = host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && !host.ends_with(".localhost")
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !is_domain {
        return None;
    }
    if url.port().is_some() {
        return None;
    }
    let mut clean = Url::parse(&format!("https://{host}")).ok()?;
    clean.set_path(url.path());
    if is_youtube(&host) {
        if let Some(video) = url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v) {
            if is_video_id(&video) {
                clean.query_pairs_mut().append_pair("v", &video);
            }
        }
    }
    (clean.as_str().len() <= URL_CHARS).then_some(clean)
}

/// A YouTube watch link that opens at `seconds` (`…&t=754s` is what YouTube itself writes; the
/// server accepts plain seconds, so that's what we store).
pub fn with_timestamp(url: &Url, seconds: u32) -> Url {
    if !is_video_page(url) || seconds > MAX_VIDEO_SECONDS {
        return url.clone();
    }
    let mut out = url.clone();
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "t")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut query = out.query_pairs_mut();
        query.clear();
        for (k, v) in &kept {
            query.append_pair(k, v);
        }
        query.append_pair("t", &seconds.to_string());
    }
    out
}

/// A page that plays one video we can link to a moment of.
pub fn is_video_page(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    (is_youtube(host) && url.path() == "/watch" && url.query_pairs().any(|(k, _)| k == "v"))
        || (host == "youtu.be" && url.path().len() > 1)
}

fn is_youtube(host: &str) -> bool {
    matches!(host, "youtube.com" | "www.youtube.com" | "m.youtube.com")
}

fn is_video_id(id: &str) -> bool {
    (6..=20).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The current time on a video player's time display ("12:34 / 45:00", "1:02:03 / 2:00:00"),
/// read from on-device OCR of the screen. The "/ total" part is required, so a clock or a
/// number in the page isn't mistaken for it.
pub fn player_time(text: &str) -> Option<u32> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    tokens.windows(3).find_map(|w| match w {
        [current, "/", total] => {
            let current = clock_seconds(current)?;
            let total = clock_seconds(total)?;
            (current <= total).then_some(current)
        }
        _ => None,
    })
    // OCR sometimes glues the slash on: "12:34/45:00".
    .or_else(|| {
        tokens.iter().find_map(|token| {
            let (current, total) = token.split_once('/')?;
            let current = clock_seconds(current)?;
            (current <= clock_seconds(total)?).then_some(current)
        })
    })
}

/// "m:ss", "mm:ss" or "h:mm:ss" → seconds.
fn clock_seconds(text: &str) -> Option<u32> {
    let parts: Vec<&str> = text.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0u32;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 2 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let value: u32 = part.parse().ok()?;
        // Minutes and seconds after the first field are two digits below 60.
        if i > 0 && (part.len() != 2 || value >= 60) {
            return None;
        }
        seconds = seconds * 60 + value;
    }
    (seconds <= MAX_VIDEO_SECONDS).then_some(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(raw: &str) -> Option<String> {
        sanitize_url(raw).map(|u| u.to_string())
    }

    #[test]
    fn trims_links_to_what_cant_hold_a_secret() {
        assert_eq!(
            clean("https://example.com/docs/week-3?session=abc#access_token=x").as_deref(),
            Some("https://example.com/docs/week-3")
        );
        assert_eq!(
            clean("example.com/notes").as_deref(),
            Some("https://example.com/notes")
        );
        assert_eq!(
            clean("https://user:pw@Example.COM/").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(
            clean("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&si=tracker&t=10")
                .as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        assert_eq!(
            clean("youtube.com/watch?v=dQw4w9WgXcQ").as_deref(),
            Some("https://youtube.com/watch?v=dQw4w9WgXcQ")
        );
    }

    #[test]
    fn refuses_links_we_shouldnt_keep() {
        for bad in [
            "",
            "http://example.com/",
            "file:///C:/Users/me/secret.pdf",
            "edge://settings",
            "chrome://history",
            "javascript:alert(1)",
            "https://localhost/",
            "https://intranet/",
            "https://192.168.1.10/admin",
            "https://example.com:8443/",
            "Search Google or type a URL",
        ] {
            assert_eq!(clean(bad), None, "{bad:?}");
        }
        // A malformed video id is dropped, not passed on.
        assert_eq!(
            clean("https://www.youtube.com/watch?v=<script>").as_deref(),
            Some("https://www.youtube.com/watch")
        );
    }

    #[test]
    fn links_a_video_to_its_moment() {
        let url = sanitize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
        assert_eq!(
            with_timestamp(&url, 754).as_str(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754"
        );
        let short = sanitize_url("https://youtu.be/dQw4w9WgXcQ").unwrap();
        assert_eq!(
            with_timestamp(&short, 3).as_str(),
            "https://youtu.be/dQw4w9WgXcQ?t=3"
        );
        let page = sanitize_url("https://example.com/lecture").unwrap();
        assert_eq!(with_timestamp(&page, 30), page, "not a video page");
        assert!(!is_video_page(
            &sanitize_url("https://www.youtube.com/feed").unwrap()
        ));
    }

    #[test]
    fn reads_the_players_time_display() {
        assert_eq!(player_time("Lecture 5  12:34 / 45:00  CC"), Some(754));
        assert_eq!(player_time("1:02:03 / 2:00:00"), Some(3723));
        assert_eq!(player_time("0:07/3:15"), Some(7));
        assert_eq!(player_time("Meeting at 12:30 today"), None);
        assert_eq!(player_time("12:75 / 45:00"), None);
        assert_eq!(player_time("50:00 / 45:00"), None, "past the end");
        assert_eq!(player_time("Page 3 / 12"), None);
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(
            clean_title("Lecture 5 – Forces - YouTube - Microsoft\u{200b} Edge", "msedge.exe")
                .as_deref(),
            Some("Lecture 5 – Forces - YouTube")
        );
        assert_eq!(
            clean_title("Worksheet.pdf - Adobe Acrobat", "acrobat.exe").as_deref(),
            Some("Worksheet.pdf - Adobe Acrobat")
        );
        assert_eq!(clean_title("  \u{7}  ", "notepad.exe"), None);
        assert_eq!(
            clean_title(&"x".repeat(500), "notepad.exe").map(|t| t.len()),
            Some(TITLE_CHARS)
        );
        assert!(is_browser("chrome.exe") && !is_browser("acrobat.exe"));
    }
}
