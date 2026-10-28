//! Music on the island: what's playing on this PC (from Windows' media controls, whatever the
//! player: the Spotify app, Spotify or YouTube in a browser) with play/pause, next and previous,
//! and the student's pinned Spotify playlists and albums, which open in the Spotify app.
//!
//! No Spotify account or Web API: Spotify only lets a handful of allow-listed users into an app
//! that isn't a large company's, so nothing here signs in. A pin is a link the student copied in
//! Spotify (Share → Copy link); its name comes from Spotify's public oEmbed endpoint, once.
//! What's playing is shown on the island only: never sent, logged or saved.
//!
//! Pure: links, pins, the saved file's shape, cleaning text, and the view the island is sent.
//! The media session is `win/media_session.rs`; the worker and buttons are `screen_music.rs`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "music.json";
/// Pins kept (the newest first); pinning another drops the oldest.
pub const MAX_PINS: usize = 6;
/// Longest name, title or artist shown (characters).
const MAX_NAME_CHARS: usize = 60;
const MAX_TEXT_CHARS: usize = 120;
/// Clipboard text longer than this isn't a link.
pub const MAX_CLIPBOARD_CHARS: usize = 2048;
/// Album art bigger than this isn't shown.
pub const MAX_ART_BYTES: usize = 512 * 1024;

/// What a pin opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Playlist,
    Album,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Playlist => "playlist",
            Kind::Album => "album",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "playlist" => Some(Kind::Playlist),
            "album" => Some(Kind::Album),
            _ => None,
        }
    }
}

/// A pinned playlist or album.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub kind: Kind,
    /// Spotify's id: 22 letters and digits.
    pub id: String,
    pub name: String,
}

impl Pin {
    /// Opens it in the Spotify app.
    pub fn app_uri(&self) -> String {
        format!("spotify:{}:{}", self.kind.as_str(), self.id)
    }

    /// Opens it in the browser (no Spotify app), and what oEmbed is asked about.
    pub fn web_url(&self) -> String {
        format!(
            "https://open.spotify.com/{}/{}",
            self.kind.as_str(),
            self.id
        )
    }

    /// The name used until (or if never) Spotify says what it's called.
    pub fn fallback_name(kind: Kind) -> String {
        match kind {
            Kind::Playlist => "Spotify playlist".to_owned(),
            Kind::Album => "Spotify album".to_owned(),
        }
    }
}

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Za-z]{22}$").unwrap());
/// `https://open.spotify.com/playlist/<id>?si=…`, also with a locale (`/intl-de/`).
static WEB_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^https://open\.spotify\.com/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?(playlist|album)/([0-9A-Za-z]{22})(?:[/?#].*)?$",
    )
    .unwrap()
});
/// `spotify:playlist:<id>` (Spotify's "Copy URI").
static APP_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^spotify:(playlist|album):([0-9A-Za-z]{22})$").unwrap());

/// The playlist or album a copied link points to: the first word of `text` that is one.
pub fn parse_link(text: &str) -> Option<(Kind, String)> {
    if text.chars().count() > MAX_CLIPBOARD_CHARS {
        return None;
    }
    text.split_whitespace().find_map(|word| {
        let captures = WEB_LINK
            .captures(word)
            .or_else(|| APP_LINK.captures(word))?;
        Some((Kind::parse(&captures[1])?, captures[2].to_owned()))
    })
}

/// Text from another app (a player's title, Spotify's name for a playlist) as the island shows
/// it: no control characters, spaces collapsed, at most `max` characters.
pub fn clean_text(text: &str, max: usize) -> String {
    let words: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect();
    let joined = words.join(" ");
    if joined.chars().count() <= max {
        return joined;
    }
    let mut cut: String = joined.chars().take(max.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// The name in Spotify's oEmbed reply (`{"title": …}`), cleaned; None if it has none.
pub fn oembed_title(body: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Reply {
        title: Option<String>,
    }
    let reply: Reply = serde_json::from_slice(body).ok()?;
    let name = clean_text(&reply.title?, MAX_NAME_CHARS);
    (!name.is_empty()).then_some(name)
}

/// Pins `pin` first (moving it up if it's pinned already), keeping at most `MAX_PINS`.
pub fn add_pin(pins: &mut Vec<Pin>, pin: Pin) {
    pins.retain(|old| !(old.kind == pin.kind && old.id == pin.id));
    pins.insert(0, pin);
    pins.truncate(MAX_PINS);
}

/// Unpins the pin with `id`; false if there was none.
pub fn remove_pin(pins: &mut Vec<Pin>, id: &str) -> bool {
    let before = pins.len();
    pins.retain(|pin| pin.id != id);
    pins.len() != before
}

#[derive(Serialize)]
struct Saved<'a> {
    pins: &'a [Pin],
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The saved pins: anything malformed (a hand-edited file) is dropped, never trusted. Each pin is
/// read on its own, so one bad entry doesn't lose the others.
pub fn parse_pins(text: &str) -> Vec<Pin> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        pins: Vec<serde_json::Value>,
    }
    let Ok(raw) = serde_json::from_str::<Raw>(text) else {
        return Vec::new();
    };
    let mut pins: Vec<Pin> = Vec::new();
    for pin in raw
        .pins
        .into_iter()
        .filter_map(|value| serde_json::from_value::<Pin>(value).ok())
        .rev()
    {
        if ID.is_match(&pin.id) {
            let name = clean_text(&pin.name, MAX_NAME_CHARS);
            let name = if name.is_empty() {
                Pin::fallback_name(pin.kind)
            } else {
                name
            };
            add_pin(&mut pins, Pin { name, ..pin });
        }
    }
    pins
}

pub fn load(path: &Path) -> Vec<Pin> {
    fs::read_to_string(path)
        .map(|text| parse_pins(&text))
        .unwrap_or_default()
}

/// Writes the pins atomically (a temporary file renamed over the old one).
pub fn save(path: &Path, pins: &[Pin]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(&Saved { pins }).map_err(io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text)?;
    fs::rename(&temp, path)
}

/// The player's name, from its media session's app id ("Spotify.exe", "MSEdge",
/// "SpotifyAB.SpotifyMusic_…!Spotify"); None for one we don't name.
pub fn player_name(app_id: &str) -> Option<&'static str> {
    let id = app_id.to_lowercase();
    [
        ("spotify", "Spotify"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
    ]
    .into_iter()
    .find(|(stem, _)| id.contains(stem))
    .map(|(_, name)| name)
}

/// Album art the island may show: a PNG or JPEG (by its bytes), not too big.
pub fn art_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_ART_BYTES {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else {
        None
    }
}

/// What's playing, as the island shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    /// "Spotify", "Edge"…, when known.
    pub player: Option<&'static str>,
    pub playing: bool,
    pub can_previous: bool,
    pub can_next: bool,
    /// The album art as a `data:` URL (PNG or JPEG), when the player gives one.
    pub art: Option<String>,
}

impl NowPlaying {
    /// From the media session's text, cleaned. None when there's no title (nothing to show).
    pub fn new(title: &str, artist: &str, app_id: &str) -> Option<Self> {
        let title = clean_text(title, MAX_TEXT_CHARS);
        (!title.is_empty()).then(|| Self {
            title,
            artist: clean_text(artist, MAX_TEXT_CHARS),
            player: player_name(app_id),
            playing: false,
            can_previous: false,
            can_next: false,
            art: None,
        })
    }

    /// The same track (its art needn't be read again).
    pub fn same_track(&self, other: &NowPlaying) -> bool {
        self.title == other.title && self.artist == other.artist && self.player == other.player
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PinView {
    pub kind: Kind,
    pub id: String,
    pub name: String,
}

/// What the island's music panel is sent (`mew:island-music`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MusicView {
    pub now: Option<NowPlaying>,
    pub pins: Vec<PinView>,
    /// A line for the student (why pinning didn't work, a pin that couldn't open).
    pub notice: Option<String>,
    /// Pinning is under way (the name is being looked up).
    pub pinning: bool,
}

impl MusicView {
    pub fn new(
        now: Option<NowPlaying>,
        pins: &[Pin],
        notice: Option<String>,
        pinning: bool,
    ) -> Self {
        Self {
            now,
            pins: pins
                .iter()
                .map(|pin| PinView {
                    kind: pin.kind,
                    id: pin.id.clone(),
                    name: pin.name.clone(),
                })
                .collect(),
            notice,
            pinning,
        }
    }
}

/// A playback button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Control {
    PlayPause,
    Next,
    Previous,
}

pub const NOTICE_NO_LINK: &str =
    "Copy a playlist's link in Spotify first (Share → Copy link), then pin it.";
pub const NOTICE_FULL: &str = "Pinned. The oldest pin made room.";
pub const NOTICE_CANT_OPEN: &str = "Couldn't open Spotify or the browser.";

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "37i9dQZF1DXcBWIGoYBM5M";
    const ID_B: &str = "4aawyAB9vmqN3uQ7FjRGTy";

    #[test]
    fn reads_the_links_spotify_copies() {
        let playlist = Some((Kind::Playlist, ID_A.to_owned()));
        assert_eq!(
            parse_link(&format!(
                "https://open.spotify.com/playlist/{ID_A}?si=abc123"
            )),
            playlist
        );
        assert_eq!(
            parse_link(&format!("https://open.spotify.com/intl-de/playlist/{ID_A}")),
            playlist
        );
        assert_eq!(
            parse_link(&format!("  spotify:album:{ID_B}\r\n")),
            Some((Kind::Album, ID_B.to_owned()))
        );
        // A link inside a message.
        assert_eq!(
            parse_link(&format!(
                "study music: https://open.spotify.com/playlist/{ID_A} enjoy"
            )),
            playlist
        );
    }

    #[test]
    fn refuses_anything_else() {
        for text in [
            "",
            "hello",
            &format!("http://open.spotify.com/playlist/{ID_A}"),
            &format!("https://open.spotify.com.evil.example/playlist/{ID_A}"),
            &format!("https://evil.example/?https://open.spotify.com/playlist/{ID_A}"),
            &format!("https://open.spotify.com/track/{ID_A}"),
            "https://open.spotify.com/playlist/short",
            &format!("https://open.spotify.com/playlist/{ID_A}x"),
            &format!("spotify:playlist:{ID_A}:extra"),
            &format!("javascript:alert(1)//{ID_A}"),
            "https://spotify.link/abcdef",
        ] {
            assert_eq!(parse_link(text), None, "{text}");
        }
        let long = format!("{} {}", "x".repeat(MAX_CLIPBOARD_CHARS), ID_A);
        assert_eq!(parse_link(&long), None);
    }

    #[test]
    fn a_pin_opens_in_the_app_or_the_browser() {
        let pin = Pin {
            kind: Kind::Playlist,
            id: ID_A.to_owned(),
            name: "Focus".to_owned(),
        };
        assert_eq!(pin.app_uri(), format!("spotify:playlist:{ID_A}"));
        assert_eq!(
            pin.web_url(),
            format!("https://open.spotify.com/playlist/{ID_A}")
        );
    }

    #[test]
    fn text_from_other_apps_is_cleaned_and_cut() {
        assert_eq!(
            clean_text("  Lo-fi\tbeats\u{0}\n  to study ", 60),
            "Lo-fi beats to study"
        );
        assert_eq!(clean_text("abcdefghij", 6), "abcde…");
        assert_eq!(clean_text("ab  cdefgh", 4), "ab…");
        assert_eq!(
            clean_text("ééééé", 5),
            "ééééé",
            "counts characters, not bytes"
        );
        assert_eq!(clean_text("\u{7}\u{1b}", 10), "");
    }

    #[test]
    fn takes_the_title_from_oembed() {
        assert_eq!(
            oembed_title(br#"{"title":"Deep Focus","type":"rich","html":"<iframe>"}"#),
            Some("Deep Focus".to_owned())
        );
        assert_eq!(oembed_title(br#"{"title":"   "}"#), None);
        assert_eq!(oembed_title(br#"{"type":"rich"}"#), None);
        assert_eq!(oembed_title(b"<html>not json</html>"), None);
    }

    #[test]
    fn pins_keep_the_newest_first_without_repeats() {
        let pin = |n: usize| Pin {
            kind: Kind::Playlist,
            id: format!("{n:0>22}"),
            name: format!("List {n}"),
        };
        let mut pins = Vec::new();
        for n in 0..MAX_PINS + 2 {
            add_pin(&mut pins, pin(n));
        }
        assert_eq!(pins.len(), MAX_PINS);
        assert_eq!(pins[0], pin(MAX_PINS + 1));
        // Pinned again: moves to the top, not twice.
        add_pin(&mut pins, pin(4));
        assert_eq!(pins[0], pin(4));
        assert_eq!(pins.iter().filter(|p| p.id == pin(4).id).count(), 1);
        assert!(remove_pin(&mut pins, &pin(4).id));
        assert!(!remove_pin(&mut pins, &pin(4).id));
    }

    #[test]
    fn the_saved_file_round_trips_and_bad_entries_are_dropped() {
        let dir = std::env::temp_dir().join(format!("mew-music-test-{}", std::process::id()));
        let path = path_in(&dir);
        let pins = vec![
            Pin {
                kind: Kind::Playlist,
                id: ID_A.to_owned(),
                name: "Focus".to_owned(),
            },
            Pin {
                kind: Kind::Album,
                id: ID_B.to_owned(),
                name: "Album".to_owned(),
            },
        ];
        save(&path, &pins).unwrap();
        assert_eq!(load(&path), pins);
        let _ = fs::remove_dir_all(&dir);

        let edited = format!(
            r#"{{"pins":[
                {{"kind":"playlist","id":"{ID_A}","name":"  \u0007 "}},
                {{"kind":"playlist","id":"../../etc","name":"x"}},
                {{"kind":"track","id":"{ID_B}","name":"x"}}
            ]}}"#
        );
        assert_eq!(
            parse_pins(&edited),
            vec![Pin {
                kind: Kind::Playlist,
                id: ID_A.to_owned(),
                name: "Spotify playlist".to_owned(),
            }]
        );
        assert!(parse_pins("not json").is_empty());
        assert!(load(&dir.join("missing.json")).is_empty());
    }

    #[test]
    fn names_the_player() {
        assert_eq!(player_name("Spotify.exe"), Some("Spotify"));
        assert_eq!(
            player_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
            Some("Spotify")
        );
        assert_eq!(player_name("MSEdge"), Some("Edge"));
        assert_eq!(player_name("SomethingElse.exe"), None);
    }

    #[test]
    fn only_small_pngs_and_jpegs_are_shown() {
        assert_eq!(art_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(art_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(art_mime(b"<svg onload=alert(1)>"), None);
        assert_eq!(art_mime(b"GIF89a"), None);
        let mut big = vec![0xFF, 0xD8, 0xFF];
        big.resize(MAX_ART_BYTES + 1, 0);
        assert_eq!(art_mime(&big), None);
    }

    #[test]
    fn nothing_shows_without_a_title() {
        assert!(NowPlaying::new(" ", "Artist", "Spotify.exe").is_none());
        let now = NowPlaying::new("Song", "Artist", "Spotify.exe").unwrap();
        assert_eq!(now.player, Some("Spotify"));
        let mut other = now.clone();
        other.playing = true;
        assert!(now.same_track(&other));
    }

    #[test]
    fn the_view_is_what_the_page_expects() {
        let mut now = NowPlaying::new("Song", "Artist", "Spotify.exe").unwrap();
        now.playing = true;
        now.can_next = true;
        let pins = [Pin {
            kind: Kind::Playlist,
            id: ID_A.to_owned(),
            name: "Focus".to_owned(),
        }];
        let view = MusicView::new(Some(now), &pins, None, false);
        assert_eq!(
            serde_json::to_value(&view).unwrap(),
            serde_json::json!({
                "now": {
                    "title": "Song", "artist": "Artist", "player": "Spotify", "playing": true,
                    "can_previous": false, "can_next": true, "art": null
                },
                "pins": [{ "kind": "playlist", "id": ID_A, "name": "Focus" }],
                "notice": null,
                "pinning": false
            })
        );
    }
}
