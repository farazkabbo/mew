//! Text-only destination movement for an existing owner-scoped entry; no screenshots or IPC grant.
use crate::screen::{
    destination::{DestinationOut, Place},
    protocol::is_uuid,
    secret::SecretBytes,
};
use tauri::AppHandle;
fn body(clip_id: &str, place: &Place, app: Option<&str>) -> Result<SecretBytes, String> {
    if !is_uuid(clip_id)
        || !is_uuid(&place.node_id)
        || !(1..=3).contains(&place.path.len())
        || place
            .path
            .iter()
            .any(|s| s.is_empty() || s.chars().count() > 200 || s.chars().any(char::is_control))
        || place.create.as_ref().is_some_and(|s| {
            s.trim().is_empty() || s.chars().count() > 80 || s.chars().any(char::is_control)
        })
        || app.is_some_and(|s| s.chars().count() > 64 || s.chars().any(char::is_control))
        || matches!(place.page,crate::screen::destination::Page::Number{number}if !(1..=999).contains(&number))
    {
        return Err("Invalid notebook destination.".into());
    }
    let bytes=SecretBytes::from_vec(serde_json::to_vec(&serde_json::json!({"clipId":clip_id,"destination":DestinationOut::from(place),"source":{"app":app}})).map_err(|_|"Couldn't prepare notebook destination.")?);
    if bytes.len() > 4000 {
        return Err("Notebook destination is too large.".into());
    }
    Ok(bytes)
}
/// A choice during first save waits for its real clip ID; later moves keep that same ID.
pub fn pending(
    clip_id: Option<&str>,
    desired: Option<&Place>,
    applied: Option<&Place>,
) -> Option<(String, Place)> {
    let (id, place) = clip_id.zip(desired)?;
    (applied != Some(place)).then(|| (id.to_owned(), place.clone()))
}
pub fn move_owned(
    app: &AppHandle,
    clip_id: &str,
    place: &Place,
    source_app: Option<&str>,
    stamp: &[u8; 32],
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let bytes = body(clip_id, place, source_app)?;
    super::service_call::post_bound(
        app,
        "api/screen/entries/destination",
        bytes.as_slice(),
        stamp,
        cancelled,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::destination::Page;
    #[test]
    fn move_body_matches_existing_destination_route_and_carries_no_frame() {
        let place = Place {
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            path: vec!["Physics".into()],
            page: Page::FromScreen,
            create: None,
            root: false,
        };
        let bytes = body(
            "11111111-1111-4111-8111-111111111111",
            &place,
            Some("textedit.exe"),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(bytes.as_slice()).unwrap();
        assert_eq!(value["clipId"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(value["destination"]["nodeId"], place.node_id);
        assert_eq!(value["source"]["app"], "textedit.exe");
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(body("not-a-clip", &place, None).is_err());
    }
    #[test]
    fn choices_during_first_save_move_the_same_entry_and_skip_already_applied_places() {
        let a = Place {
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            path: vec!["A".into()],
            page: Page::FromScreen,
            create: None,
            root: false,
        };
        let mut b = a.clone();
        b.node_id = "33333333-3333-4333-8333-333333333333".into();
        b.path = vec!["B".into()];
        assert!(pending(None, Some(&b), Some(&a)).is_none());
        let next = pending(Some("existing-clip"), Some(&b), Some(&a)).unwrap();
        assert_eq!(next.0, "existing-clip");
        assert_eq!(next.1, b);
        assert!(pending(Some("existing-clip"), Some(&b), Some(&b)).is_none());
    }
}
