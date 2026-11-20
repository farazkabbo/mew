//! What can be clicked (B): the foreground window's invokable controls from UI Automation (or
//! words from on-device OCR where an app exposes nothing), and the compact summary of them that a
//! planning request may carry.
//!
//! The summary is names and control types only, at most 40, and never what the student wrote:
//! controls that hold content (edit boxes, documents, list rows, cells, tree rows) are left out,
//! and so is any name that looks like an address, a number, a path or a sentence.

use serde::{Deserialize, Serialize};

use crate::screen::frame::ScreenRect;

/// The most controls a planning request describes.
pub const SUMMARY_MAX: usize = 40;
const NAME_MAX: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Uia,
    Ocr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Stable within one collection of the window (its index), not across collections.
    pub id: u32,
    pub name: String,
    /// UI Automation's control type name ("Button", "MenuItem", "TabItem", …).
    pub control_type: String,
    pub automation_id: String,
    /// Global physical pixels.
    pub rect: ScreenRect,
    pub source: Source,
}

/// The targets of one window, as collected.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetSet {
    pub window: isize,
    /// Lowercase executable name ("explorer.exe").
    pub process: String,
    pub class: String,
    pub title: String,
    pub targets: Vec<Target>,
}

impl TargetSet {
    pub fn get(&self, id: u32) -> Option<&Target> {
        self.targets.iter().find(|t| t.id == id)
    }
}

/// UI Automation's control type ids (UIA_*ControlTypeId, 50000…) as names.
pub fn control_type_name(id: i32) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button",
        "Calendar",
        "CheckBox",
        "ComboBox",
        "Edit",
        "Hyperlink",
        "Image",
        "ListItem",
        "List",
        "Menu",
        "MenuBar",
        "MenuItem",
        "ProgressBar",
        "RadioButton",
        "ScrollBar",
        "Slider",
        "Spinner",
        "StatusBar",
        "Tab",
        "TabItem",
        "Text",
        "ToolBar",
        "ToolTip",
        "Tree",
        "TreeItem",
        "Custom",
        "Group",
        "Thumb",
        "DataGrid",
        "DataItem",
        "Document",
        "SplitButton",
        "Window",
        "Pane",
        "Header",
        "HeaderItem",
        "Table",
        "TitleBar",
        "Separator",
        "SemanticZoom",
        "AppBar",
    ];
    usize::try_from(id - 50000)
        .ok()
        .and_then(|i| NAMES.get(i))
        .copied()
        .unwrap_or("Custom")
}

/// Control types whose names are interface words, not the student's content.
const SUMMARY_TYPES: &[&str] = &[
    "Button",
    "MenuItem",
    "MenuBar",
    "TabItem",
    "Hyperlink",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "SplitButton",
    "ToolBar",
    "ListItem",
    "TreeItem",
];

/// One line of the planning summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SummaryItem {
    #[serde(rename = "type")]
    pub control_type: String,
    pub name: String,
}

/// A name that's an interface word: short, no address, path, long number or sentence.
pub fn interface_name(name: &str) -> bool {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > NAME_MAX {
        return false;
    }
    if name.contains('@') || name.contains("://") || name.contains('\\') || name.contains('/') {
        return false;
    }
    let digits = name.chars().filter(char::is_ascii_digit).count();
    if digits >= 4 {
        return false;
    }
    // More than 6 words reads like content (a subject line, a message preview).
    name.split_whitespace().count() <= 6
}

/// Navigation list rows (Settings' left pane, Explorer's folder tree) are interface; a list's
/// rows in the content area (mail, files) are content. Rows are kept only when their names are
/// interface words and there are few of them (a navigation pane, not an inbox).
pub fn summary(set: &TargetSet) -> Vec<SummaryItem> {
    let rows = set
        .targets
        .iter()
        .filter(|t| matches!(t.control_type.as_str(), "ListItem" | "TreeItem"))
        .count();
    let mut items: Vec<(&Target, SummaryItem)> = set
        .targets
        .iter()
        .filter(|t| SUMMARY_TYPES.contains(&t.control_type.as_str()))
        .filter(|t| rows <= 24 || !matches!(t.control_type.as_str(), "ListItem" | "TreeItem"))
        .filter(|t| interface_name(&t.name))
        .map(|t| {
            (
                t,
                SummaryItem {
                    control_type: t.control_type.clone(),
                    name: t.name.trim().to_owned(),
                },
            )
        })
        .collect();
    // Reading order: top to bottom, left to right, in 16 px bands.
    items.sort_by_key(|(t, _)| (t.rect.top / 16, t.rect.left));
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .map(|(_, item)| item)
        .filter(|item| seen.insert((item.control_type.clone(), item.name.to_lowercase())))
        .take(SUMMARY_MAX)
        .collect()
}

#[cfg(test)]
pub fn t(id: u32, name: &str, ty: &str, rect: (i32, i32, i32, i32)) -> Target {
    Target {
        id,
        name: name.to_owned(),
        control_type: ty.to_owned(),
        automation_id: String::new(),
        rect: ScreenRect {
            left: rect.0,
            top: rect.1,
            right: rect.2,
            bottom: rect.3,
        },
        source: Source::Uia,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_never_carries_content() {
        let set = TargetSet {
            targets: vec![
                t(0, "Personalization", "ListItem", (0, 100, 200, 130)),
                t(1, "Dark", "RadioButton", (300, 200, 400, 220)),
                t(2, "Dear Sam, the lease is attached", "Edit", (0, 0, 1, 1)),
                t(3, "sam@example.com", "Button", (0, 0, 1, 1)),
                t(4, "C:\\Users\\me\\lease.pdf", "Hyperlink", (0, 0, 1, 1)),
                t(5, "Invoice 2026-0042", "Button", (0, 0, 1, 1)),
                t(
                    6,
                    "Re: our trip next week and the hotel booking details",
                    "Button",
                    (0, 0, 1, 1),
                ),
                t(7, "Document body", "Document", (0, 0, 1, 1)),
                t(8, "Colors", "ListItem", (0, 140, 200, 170)),
            ],
            ..TargetSet::default()
        };
        let items = summary(&set);
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["Personalization", "Colors", "Dark"]);
    }

    #[test]
    fn many_rows_are_a_content_list_and_are_left_out() {
        let mut targets: Vec<Target> = (0..40)
            .map(|i| {
                t(
                    i,
                    &format!("Mail {i}"),
                    "ListItem",
                    (0, i as i32 * 30, 100, 20),
                )
            })
            .collect();
        targets.push(t(99, "Reply all", "Button", (0, 0, 50, 20)));
        let set = TargetSet {
            targets,
            ..TargetSet::default()
        };
        let items = summary(&set);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Reply all");
    }

    #[test]
    fn at_most_forty_and_no_duplicates() {
        let targets: Vec<Target> = (0..100)
            .map(|i| {
                t(
                    i,
                    &format!("Tool {}", i % 60),
                    "Button",
                    (i as i32, 0, 10, 10),
                )
            })
            .collect();
        let items = summary(&TargetSet {
            targets,
            ..TargetSet::default()
        });
        assert_eq!(items.len(), SUMMARY_MAX);
        let unique: std::collections::HashSet<_> = items.iter().map(|i| &i.name).collect();
        assert_eq!(unique.len(), items.len());
    }
}
