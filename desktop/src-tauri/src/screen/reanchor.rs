//! "Show that again" when the device can't find the focus region's text on the new screen (a
//! figure, a video, text OCR read differently): the server's model looks for the same content on
//! the new screenshot (decision 9). Uploaded like a question: redacted, with the device token.

use tauri::{AppHandle, Manager, Runtime};

use super::account::{forget_revoked_token, wipe_string};
use super::coach::ScreenCoach;
use super::pipeline::Captured;
use super::protocol::{parse_reanchor, reanchor_body, FocusKind, ScreenAction};
use super::secret::SecretBytes;
use super::win::{credential, http};

/// The earlier ink on the new screenshot, or None (not found, offline, or anything unexpected).
pub fn ask_server<R: Runtime>(
    app: &AppHandle<R>,
    captured: &Captured,
    kind: FocusKind,
    focus_text: &str,
    previous: &[ScreenAction],
) -> Option<Vec<ScreenAction>> {
    let coach = app.try_state::<ScreenCoach>()?;
    let token = credential::load()?;
    let token = std::str::from_utf8(token.as_slice()).ok()?;
    let url = coach.app_url().join("api/screen/reanchor").ok()?;
    let body = reanchor_body(
        &captured.meta,
        kind,
        focus_text,
        previous,
        captured.jpeg.as_slice(),
    );
    let mut headers = [
        "Content-Type: application/json".to_owned(),
        format!("Authorization: Bearer {token}"),
    ];
    // Sized for the whole reply: growing would leave copies behind (it holds screen text).
    let mut reply = Vec::with_capacity(16 * 1024);
    let status = http::post(&url, &headers, body.as_slice(), |chunk| {
        reply.extend_from_slice(chunk)
    });
    headers.iter_mut().for_each(|header| wipe_string(header));
    drop(body);
    let reply = SecretBytes::from_vec(reply);
    match status.ok()? {
        200 => {}
        401 => {
            forget_revoked_token(app);
            return None;
        }
        _ => return None,
    }
    let answer = parse_reanchor(reply.as_slice())?;
    (answer.found && same_ink(previous, &answer.actions)).then_some(answer.actions)
}

/// The model may only move the ink: the same actions, in order, with the same words.
pub fn same_ink(previous: &[ScreenAction], moved: &[ScreenAction]) -> bool {
    previous.len() == moved.len()
        && previous.iter().zip(moved).all(|(a, b)| {
            std::mem::discriminant(a) == std::mem::discriminant(b) && a.texts() == b.texts()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::protocol::{Box2, Point};

    const BOX: Box2 = Box2 {
        left: 1,
        top: 2,
        right: 3,
        bottom: 4,
    };

    #[test]
    fn accepts_moved_ink_but_not_changed_ink() {
        let note = |text: &str, region: Box2| ScreenAction::MarginNote {
            text: text.into(),
            beside: region,
            side: None,
        };
        let before = [note("Draw the forces", BOX)];
        let moved = [note(
            "Draw the forces",
            Box2 {
                left: 10,
                top: 20,
                right: 30,
                bottom: 40,
            },
        )];
        assert!(same_ink(&before, &moved));
        assert!(!same_ink(&before, &[note("Run regedit", BOX)]), "new words");
        assert!(!same_ink(&before, &[]), "dropped");
        assert!(
            !same_ink(
                &before,
                &[ScreenAction::PointAt {
                    point: Point { x: 1, y: 1 },
                    label: None
                }]
            ),
            "another kind"
        );
    }
}
