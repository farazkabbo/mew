//! Consent-bound AX control collection. Only interface names reach planning; draft/selection
//! facts remain local scalars. Every traversal is bounded by depth, count, per-object timeout
//! and wall time. No AX actions or field values are sent to the server.
use crate::screen::mac::{hand_policy_ax as ax, pipeline, target};
use crate::screen::{
    cursor::{
        catch::{self, Facts},
        target::{interface_name, Source, Target, TargetSet},
    },
    frame::ScreenRect,
};
use std::time::{Duration, Instant};

pub struct Snapshot {
    pub set: TargetSet,
    pub facts: Facts,
    pub terminal: Option<String>,
}
fn role_name(role: &str) -> Option<&'static str> {
    Some(match role {
        "AXButton" => "Button",
        "AXCheckBox" => "CheckBox",
        "AXRadioButton" => "RadioButton",
        "AXPopUpButton" | "AXComboBox" => "ComboBox",
        "AXMenuItem" => "MenuItem",
        "AXMenuBar" => "MenuBar",
        "AXLink" => "Hyperlink",
        "AXToolbar" => "ToolBar",
        "AXTabGroup" => "TabItem",
        "AXStaticText" => "Text",
        _ => return None,
    })
}
fn bounds(value: &ax::Owned, deadline: Instant) -> Option<ScreenRect> {
    let p = ax::pair(ax::attr(value.0, "AXPosition", deadline)?.0, 1)?;
    let s = ax::pair(ax::attr(value.0, "AXSize", deadline)?.0, 2)?;
    target::Rect::new(p.a, p.b, s.a, s.b)?;
    Some(ScreenRect {
        left: p.a.floor() as i32,
        top: p.b.floor() as i32,
        right: (p.a + s.a).ceil() as i32,
        bottom: (p.b + s.b).ceil() as i32,
    })
}
fn text(value: &ax::Owned, name: &str, deadline: Instant) -> Option<String> {
    ax::string(ax::attr(value.0, name, deadline)?.0)
}
pub fn focused_ordinary(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_millis(70);
    let Some(app) = ax::application(pid) else {
        return false;
    };
    if !ax::element(app.0, pid) {
        return false;
    }
    let Some(focused) = ax::attr(app.0, "AXFocusedUIElement", deadline) else {
        return false;
    };
    if !ax::element(focused.0, pid) {
        return false;
    }
    let Some(window) = ax::attr(app.0, "AXFocusedWindow", deadline) else {
        return false;
    };
    let Some(element_window) = ax::attr(focused.0, "AXWindow", deadline) else {
        return false;
    };
    if !ax::element(window.0, pid)
        || !ax::element(element_window.0, pid)
        || !ax::equal(&window, &element_window)
    {
        return false;
    }
    let Some(role) = text(&focused, "AXRole", deadline) else {
        return false;
    };
    match role.as_str() {
        "AXTextArea" | "AXButton" | "AXCheckBox" | "AXRadioButton" | "AXPopUpButton"
        | "AXComboBox" | "AXMenuItem" | "AXTable" | "AXOutline" | "AXList" | "AXScrollArea" => true,
        "AXTextField" => {
            text(&focused, "AXSubrole", deadline).is_some_and(|s| s != "AXSecureTextField")
        }
        _ => false,
    }
}
pub fn collect(target: &pipeline::Target, catch_consent: bool) -> Option<Snapshot> {
    objc2::MainThreadMarker::new()?;
    let deadline = Instant::now() + Duration::from_millis(220);
    let pid = target.process.pid;
    let app = ax::application(pid)?;
    if !ax::element(app.0, pid) {
        return None;
    }
    let window = ax::attr(app.0, "AXFocusedWindow", deadline)?;
    if !ax::element(window.0, pid) {
        return None;
    }
    let actual = bounds(&window, deadline)?;
    let expected = target.quartz_points;
    if actual
        != (ScreenRect {
            left: expected.x.floor() as i32,
            top: expected.y.floor() as i32,
            right: (expected.x + expected.width).ceil() as i32,
            bottom: (expected.y + expected.height).ceil() as i32,
        })
    {
        return None;
    }
    let mut set = TargetSet {
        window: target.window_id as isize,
        process: crate::screen::mac::app_policy::wire_name(&target.process.bundle_id)
            .unwrap_or(&target.process.bundle_id)
            .into(),
        ..TargetSet::default()
    };
    let mut facts = Facts::default();
    let mut terminal = None;
    if catch_consent {
        set.title = text(&window, "AXTitle", deadline).unwrap_or_default();
        if ax::attr(window.0, "AXEdited", deadline).and_then(|v| ax::boolean(v.0)) == Some(true) {
            set.title.insert(0, '*');
        }
    }
    let mut stack = vec![(window, 0)];
    let mut count = 0;
    while let Some((value, depth)) = stack.pop() {
        count += 1;
        if count > 512 || Instant::now() >= deadline {
            return None;
        }
        if !ax::element(value.0, pid) {
            return None;
        }
        let role = text(&value, "AXRole", deadline)?;
        // Never descend into a secure or unknown single-line field.
        if role == "AXTextField"
            && text(&value, "AXSubrole", deadline).is_none_or(|s| s == "AXSecureTextField")
        {
            continue;
        }
        let name = text(&value, "AXTitle", deadline)
            .or_else(|| text(&value, "AXDescription", deadline))
            .unwrap_or_default();
        if let Some(kind) = role_name(&role) {
            if !name.is_empty() && interface_name(&name) {
                if let Some(rect) = bounds(&value, deadline) {
                    set.targets.push(Target {
                        id: set.targets.len() as u32,
                        name: name.clone(),
                        control_type: kind.into(),
                        automation_id: text(&value, "AXIdentifier", deadline).unwrap_or_default(),
                        rect,
                        source: Source::Uia,
                    });
                }
            }
        }
        if catch_consent {
            if catch::looks_like_attachment(&name)
                && matches!(role.as_str(), "AXButton" | "AXStaticText" | "AXGroup")
            {
                facts.attachments = facts.attachments.saturating_add(1);
            }
            if role == "AXTextArea" {
                if let Some(mut draft) = ax::attr(value.0, "AXValue", deadline)
                    .and_then(|v| ax::string_bounded(v.0, 16000))
                {
                    facts.mentions_attachment |= catch::mentions_attachment(&draft);
                    if target
                        .process
                        .bundle_id
                        .to_ascii_lowercase()
                        .contains("terminal")
                    {
                        terminal = Some(
                            draft
                                .lines()
                                .last()
                                .unwrap_or("")
                                .chars()
                                .take(500)
                                .collect(),
                        );
                    }
                    crate::screen::secret::wipe(unsafe { draft.as_bytes_mut() });
                }
            }
            if role == "AXRow"
                && ax::attr(value.0, "AXSelected", deadline).and_then(|v| ax::boolean(v.0))
                    == Some(true)
            {
                facts.selected_files = facts.selected_files.saturating_add(1);
                if text(&value, "AXRoleDescription", deadline).is_some_and(|s| {
                    matches!(s.to_ascii_lowercase().as_str(), "folder" | "dossier")
                }) {
                    facts.selected_folders = facts.selected_folders.saturating_add(1);
                }
            }
            // Recipient chips are local metadata. Only count an explicit address; never retain it.
            if name.contains('@')
                && matches!(role.as_str(), "AXTokenField" | "AXButton" | "AXStaticText")
            {
                facts.recipients = facts.recipients.saturating_add(1);
            }
        }
        // Content rows/cells are never read as control summaries. Their aggregate selection is
        // native adapter work; absence remains zero, so Delete never produces an invented warning.
        if depth < 8
            && !matches!(
                role.as_str(),
                "AXTextArea" | "AXTextField" | "AXWebArea" | "AXCell"
            )
        {
            for child in ax::children(&value, 64, deadline).into_iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }
    Some(Snapshot {
        set,
        facts,
        terminal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_metadata_roles_become_control_targets() {
        assert_eq!(role_name("AXButton"), Some("Button"));
        assert_eq!(role_name("AXRow"), None);
        assert_eq!(role_name("AXTextArea"), None);
        assert_eq!(role_name("AXSecureTextField"), None);
        assert_eq!(role_name("AXWebArea"), None);
    }
}
