//! Bounded browser-companion wire format. No OS, credentials, captures or provider calls.
use std::io::{Read, Write};
pub const VERSION: u8 = 1;
pub const MAX_FRAME_BYTES: usize = 16_384;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Io,
    Truncated,
    Size,
    Utf8,
    Json,
    Invalid,
    Replay,
}
fn valid_json(bytes: &[u8]) -> Result<(), FrameError> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::Size);
    }
    std::str::from_utf8(bytes).map_err(|_| FrameError::Utf8)?;
    if !serde_json::from_slice::<serde_json::Value>(bytes)
        .map_err(|_| FrameError::Json)?
        .is_object()
    {
        return Err(FrameError::Json);
    }
    Ok(())
}
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut header = [0; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(FrameError::Io),
        }
    }
    reader.read_exact(&mut header[1..]).map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            FrameError::Truncated
        } else {
            FrameError::Io
        }
    })?;
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(FrameError::Size);
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            FrameError::Truncated
        } else {
            FrameError::Io
        }
    })?;
    valid_json(&body)?;
    Ok(Some(body))
}
pub fn write_frame<W: Write>(writer: &mut W, bytes: &[u8]) -> Result<(), FrameError> {
    valid_json(bytes)?;
    writer
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(bytes))
        .and_then(|_| writer.flush())
        .map_err(|_| FrameError::Io)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn frame(body: &[u8]) -> Vec<u8> {
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend(body);
        out
    }
    #[test]
    fn roundtrip_and_clean_eof_are_distinct_from_truncation() {
        let body = br#"{"version":1}"#;
        let mut out = Vec::new();
        write_frame(&mut out, body).unwrap();
        assert_eq!(out, frame(body));
        let mut input = Cursor::new(out);
        assert_eq!(read_frame(&mut input).unwrap(), Some(body.to_vec()));
        assert_eq!(read_frame(&mut input).unwrap(), None);
        for bytes in [vec![1], vec![1, 0, 0], vec![2, 0, 0, 0, b'{']] {
            assert_eq!(
                read_frame(&mut Cursor::new(bytes)),
                Err(FrameError::Truncated)
            );
        }
    }
    #[test]
    fn oversized_empty_invalid_utf8_and_nonjson_frames_fail_before_delivery() {
        assert_eq!(
            read_frame(&mut Cursor::new((MAX_FRAME_BYTES as u32 + 1).to_le_bytes())),
            Err(FrameError::Size)
        );
        assert_eq!(
            read_frame(&mut Cursor::new(0u32.to_le_bytes())),
            Err(FrameError::Size)
        );
        assert_eq!(
            read_frame(&mut Cursor::new(frame(&[255]))),
            Err(FrameError::Utf8)
        );
        assert_eq!(
            read_frame(&mut Cursor::new(frame(b"not json"))),
            Err(FrameError::Json)
        );
        assert!(write_frame(&mut Vec::new(), &vec![b' '; MAX_FRAME_BYTES + 1]).is_err());
    }
}

use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Message {
    HostHello(HostHello),
    Hello(Hello),
    Pair(Hello),
    Request(Request),
    Response(Response),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostHello {
    pub version: u8,
    pub origin: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub version: u8,
    pub profile_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Probe,
    Media,
    Control,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Play,
    Pause,
    Next,
    Previous,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub nonce: String,
    pub generation: u64,
    pub sequence: u64,
    pub profile_id: String,
    pub operation: Operation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Action>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Error,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unpaired,
    InvalidRequest,
    Private,
    Unfocused,
    PermissionDenied,
    Changed,
    Ambiguous,
    NoMedia,
    Unsupported,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub version: u8,
    pub nonce: String,
    pub generation: u64,
    pub sequence: u64,
    pub profile_id: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<Window>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Media>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorCode>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Window {
    pub id: i64,
    pub focused: bool,
    pub incognito: bool,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub tab: Tab,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tab {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub document_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub position_sec: f64,
    pub can_next: bool,
    pub can_previous: bool,
}

pub fn is_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(value: &str, max: usize) -> bool {
    value.chars().count() <= max && !value.chars().any(char::is_control)
}
fn browser_id(id: i64) -> bool {
    (0..=i64::from(i32::MAX)).contains(&id)
}
fn identity(version: u8, nonce: &str, generation: u64, sequence: u64, profile: &str) -> bool {
    version == VERSION && is_id(nonce) && generation > 0 && sequence > 0 && is_id(profile)
}
impl Request {
    pub fn validate(&self) -> Result<(), FrameError> {
        let basic = identity(
            self.version,
            &self.nonce,
            self.generation,
            self.sequence,
            &self.profile_id,
        ) && self.window_id.is_none_or(browser_id)
            && self.tab_id.is_none_or(browser_id)
            && self.document_id.as_deref().is_none_or(is_id)
            && self.media_id.as_deref().is_none_or(is_id);
        let scoped =
            self.window_id.is_some() && self.tab_id.is_some() && self.document_id.is_some();
        let op = match self.operation {
            Operation::Probe => self.action.is_none() && self.media_id.is_none(),
            Operation::Media => scoped && self.action.is_none() && self.media_id.is_none(),
            Operation::Control => scoped && self.media_id.is_some() && self.action.is_some(),
        };
        if basic && op {
            Ok(())
        } else {
            Err(FrameError::Invalid)
        }
    }
}
impl Window {
    pub fn validate(&self) -> Result<(), FrameError> {
        let good = browser_id(self.id)
            && browser_id(self.tab.id)
            && is_id(&self.tab.document_id)
            && text(&self.tab.url, 2000)
            && text(&self.tab.title, 200)
            && [self.left, self.top, self.width, self.height]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 100_000.)
            && self.width > 0.
            && self.height > 0.;
        if good {
            Ok(())
        } else {
            Err(FrameError::Invalid)
        }
    }
    pub fn normal_focused(&self) -> bool {
        self.focused && !self.incognito
    }
}
impl Media {
    pub fn validate(&self) -> Result<(), FrameError> {
        if is_id(&self.id)
            && text(&self.title, 200)
            && text(&self.artist, 200)
            && self.position_sec.is_finite()
            && (0. ..=86400.).contains(&self.position_sec)
        {
            Ok(())
        } else {
            Err(FrameError::Invalid)
        }
    }
}
impl Response {
    pub fn validate(&self) -> Result<(), FrameError> {
        if !identity(
            self.version,
            &self.nonce,
            self.generation,
            self.sequence,
            &self.profile_id,
        ) {
            return Err(FrameError::Invalid);
        }
        match self.status {
            Status::Error
                if self.error.is_some() && self.window.is_none() && self.media.is_none() =>
            {
                Ok(())
            }
            Status::Ok if self.error.is_none() => {
                self.window
                    .as_ref()
                    .ok_or(FrameError::Invalid)?
                    .validate()?;
                if self.window.as_ref().is_some_and(|window| window.incognito) {
                    return Err(FrameError::Invalid);
                }
                if let Some(media) = &self.media {
                    media.validate()?;
                }
                Ok(())
            }
            _ => Err(FrameError::Invalid),
        }
    }
}
impl Message {
    pub fn validate(&self) -> Result<(), FrameError> {
        match self {
            Self::HostHello(h) => {
                if h.version == VERSION && text(&h.origin, 512) && !h.origin.is_empty() {
                    Ok(())
                } else {
                    Err(FrameError::Invalid)
                }
            }
            Self::Hello(h) | Self::Pair(h) => {
                if h.version == VERSION && is_id(&h.profile_id) {
                    Ok(())
                } else {
                    Err(FrameError::Invalid)
                }
            }
            Self::Request(r) => r.validate(),
            Self::Response(r) => r.validate(),
        }
    }
}
pub fn decode(bytes: &[u8]) -> Result<Message, FrameError> {
    valid_json(bytes)?;
    let message: Message = serde_json::from_slice(bytes).map_err(|_| FrameError::Invalid)?;
    message.validate()?;
    Ok(message)
}
pub fn encode(message: &Message) -> Result<Vec<u8>, FrameError> {
    message.validate()?;
    let bytes = serde_json::to_vec(message).map_err(|_| FrameError::Invalid)?;
    valid_json(&bytes)?;
    Ok(bytes)
}
pub fn read_message<R: Read>(reader: &mut R) -> Result<Option<Message>, FrameError> {
    read_frame(reader)?.map(|b| decode(&b)).transpose()
}
pub fn write_message<W: Write>(writer: &mut W, message: &Message) -> Result<(), FrameError> {
    write_frame(writer, &encode(message)?)
}

/// Per authenticated profile/connection. A rejected reply never advances the sequence.
pub struct ReplyGuard {
    profile: String,
    last_sequence: u64,
}
impl ReplyGuard {
    pub fn new(profile: &str) -> Result<Self, FrameError> {
        if !is_id(profile) {
            return Err(FrameError::Invalid);
        }
        Ok(Self {
            profile: profile.into(),
            last_sequence: 0,
        })
    }
    pub fn accept(&mut self, request: &Request, response: &Response) -> Result<(), FrameError> {
        request.validate()?;
        response.validate()?;
        if request.profile_id != self.profile
            || response.profile_id != self.profile
            || request.nonce != response.nonce
            || request.generation != response.generation
            || request.sequence != response.sequence
            || response.sequence <= self.last_sequence
        {
            return Err(FrameError::Replay);
        }
        if response.status == Status::Ok {
            let window = response.window.as_ref().ok_or(FrameError::Invalid)?;
            if (request.window_id.is_none() && !window.focused)
                || request.window_id.is_some_and(|id| window.id != id)
                || request.tab_id.is_some_and(|id| window.tab.id != id)
                || request
                    .document_id
                    .as_ref()
                    .is_some_and(|id| window.tab.document_id != *id)
            {
                return Err(FrameError::Invalid);
            }
            match request.operation {
                Operation::Probe if response.media.is_some() => return Err(FrameError::Invalid),
                Operation::Media | Operation::Control => {
                    let media = response.media.as_ref().ok_or(FrameError::Invalid)?;
                    if request.media_id.as_ref().is_some_and(|id| media.id != *id) {
                        return Err(FrameError::Invalid);
                    }
                }
                _ => {}
            }
        }
        self.last_sequence = response.sequence;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    pub chrome_extension_ids: Vec<String>,
    pub firefox_addon_ids: Vec<String>,
    pub app_directory: String,
}
impl HostConfig {
    pub fn validate(&self) -> Result<(), FrameError> {
        let chrome = |s: &String| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b));
        if self.app_directory != "app.mew.desktop"
            || self.chrome_extension_ids.len() > 16
            || self.firefox_addon_ids.len() > 16
            || !self.chrome_extension_ids.iter().all(chrome)
            || self.firefox_addon_ids.iter().any(|s| {
                s.is_empty()
                    || s.len() > 80
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"@{}-._".contains(&b))
            })
        {
            return Err(FrameError::Invalid);
        }
        Ok(())
    }
    #[allow(dead_code)] // Shared with the separately compiled native-host executable.
    pub fn caller(&self, args: &[String]) -> Result<String, FrameError> {
        self.validate()?;
        match args {
            [origin]
                if self
                    .chrome_extension_ids
                    .iter()
                    .any(|id| *origin == format!("chrome-extension://{id}/")) =>
            {
                Ok(origin.clone())
            }
            [manifest, id]
                if manifest.starts_with('/')
                    && text(manifest, 4096)
                    && self.firefox_addon_ids.contains(id) =>
            {
                Ok(id.clone())
            }
            _ => Err(FrameError::Invalid),
        }
    }
}
#[cfg(test)]
mod validation_tests {
    use super::*;
    const ID: &str = "11111111111111111111111111111111";
    fn request() -> Request {
        Request {
            version: 1,
            nonce: ID.into(),
            generation: 1,
            sequence: 1,
            profile_id: ID.into(),
            operation: Operation::Probe,
            window_id: None,
            tab_id: None,
            document_id: None,
            media_id: None,
            action: None,
        }
    }
    fn response() -> Response {
        Response {
            version: 1,
            nonce: ID.into(),
            generation: 1,
            sequence: 1,
            profile_id: ID.into(),
            status: Status::Ok,
            window: Some(Window {
                id: 4,
                focused: true,
                incognito: false,
                left: -1200.,
                top: 0.,
                width: 1000.,
                height: 800.,
                tab: Tab {
                    id: 7,
                    url: "https://example.com/lesson".into(),
                    title: "Lesson".into(),
                    document_id: ID.into(),
                },
            }),
            media: None,
            error: None,
        }
    }
    #[test]
    fn unknown_fields_versions_duplicate_keys_and_unbounded_values_are_rejected() {
        let mut value = serde_json::to_value(Message::Request(request())).unwrap();
        value["arbitraryScript"] = serde_json::json!("eval");
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut r = request();
        r.version = 2;
        assert!(r.validate().is_err());
        r = request();
        r.nonce = "A".repeat(32);
        assert!(r.validate().is_err());
        r = request();
        r.generation = 0;
        assert!(r.validate().is_err());
        assert!(decode(br#"{"type":"hello","version":1,"version":1,"profileId":"11111111111111111111111111111111"}"#).is_err());
        let mut r = response();
        r.window.as_mut().unwrap().tab.title = "a".repeat(201);
        assert!(r.validate().is_err());
        r = response();
        r.window.as_mut().unwrap().incognito = true;
        assert!(r.validate().is_err());
    }
    #[test]
    fn replay_changed_profile_nonce_generation_and_document_cannot_inherit_proof() {
        let r = request();
        let response = response();
        let mut guard = ReplyGuard::new(ID).unwrap();
        guard.accept(&r, &response).unwrap();
        assert_eq!(guard.accept(&r, &response), Err(FrameError::Replay));
        for change in 0..4 {
            let mut changed = response.clone();
            match change {
                0 => changed.nonce = "2".repeat(32),
                1 => changed.generation = 2,
                2 => changed.profile_id = "2".repeat(32),
                _ => changed.sequence = 2,
            };
            assert!(ReplyGuard::new(ID).unwrap().accept(&r, &changed).is_err());
        }
        let mut req = request();
        req.operation = Operation::Media;
        req.window_id = Some(4);
        req.tab_id = Some(7);
        req.document_id = Some("2".repeat(32));
        let mut response = response.clone();
        response.media = Some(Media {
            id: ID.into(),
            title: "Video".into(),
            artist: "".into(),
            playing: true,
            position_sec: 5.,
            can_next: false,
            can_previous: false,
        });
        assert!(ReplyGuard::new(ID)
            .unwrap()
            .accept(&req, &response)
            .is_err());
    }
    #[test]
    fn background_proof_requires_an_exact_target_and_never_allows_private() {
        let mut r = response();
        r.window.as_mut().unwrap().focused = false;
        assert!(r.validate().is_ok());
        let mut req = request();
        assert!(ReplyGuard::new(ID).unwrap().accept(&req, &r).is_err());
        req.window_id = Some(4);
        req.tab_id = Some(7);
        req.document_id = Some(ID.into());
        assert!(ReplyGuard::new(ID).unwrap().accept(&req, &r).is_ok());
        for mismatch in 0..3 {
            let mut changed = req.clone();
            match mismatch {
                0 => changed.window_id = Some(5),
                1 => changed.tab_id = Some(8),
                _ => changed.document_id = Some("2".repeat(32)),
            }
            assert!(ReplyGuard::new(ID).unwrap().accept(&changed, &r).is_err());
        }
        r.window.as_mut().unwrap().incognito = true;
        assert!(r.validate().is_err());
        assert!(ReplyGuard::new(ID).unwrap().accept(&req, &r).is_err());
    }
    #[test]
    fn control_requires_exact_ids_and_error_replies_cannot_carry_content() {
        let mut req = request();
        req.operation = Operation::Control;
        assert!(req.validate().is_err());
        req.window_id = Some(4);
        req.tab_id = Some(7);
        req.document_id = Some(ID.into());
        req.media_id = Some(ID.into());
        req.action = Some(Action::Pause);
        assert!(req.validate().is_ok());
        let mut r = response();
        r.status = Status::Error;
        r.error = Some(ErrorCode::Private);
        assert!(r.validate().is_err());
        r.window = None;
        assert!(r.validate().is_ok());
    }
    #[test]
    fn caller_identity_never_accepts_prefixes_wildcards_or_extra_arguments() {
        let c = HostConfig {
            chrome_extension_ids: vec!["a".repeat(32)],
            firefox_addon_ids: vec!["neb@example.invalid".into()],
            app_directory: "app.mew.desktop".into(),
        };
        let origin = format!("chrome-extension://{}/", "a".repeat(32));
        assert_eq!(c.caller(std::slice::from_ref(&origin)).unwrap(), origin);
        assert!(c.caller(&[format!("{origin}evil")]).is_err());
        assert!(c.caller(&[origin, "ignored".into()]).is_err());
        assert!(c
            .caller(&["/fixed/manifest.json".into(), "neb@example.invalid".into()])
            .is_ok());
        assert!(c
            .caller(&["relative.json".into(), "neb@example.invalid".into()])
            .is_err());
    }
}
