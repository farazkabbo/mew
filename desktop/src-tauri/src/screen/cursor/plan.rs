//! The planning request and its reply (`POST /api/screen/plan`, packages/shared/src/
//! screen-plan.ts), checked here before anything is shown or done.
//!
//! The body is the student's words, the app in front and the window's control summary (names
//! and types, content left out: `target::summary`). The reply is a path for SHOW ME or one
//! action from DO IT's allowlist; anything else doesn't parse.

use serde::Deserialize;

use super::path::Anchor;
use super::target::SummaryItem;

pub const MAX_STEPS: usize = 8;
const NAME_MAX: usize = 60;
const SPEECH_MAX: usize = 300;

/// Control types a step may name (PLAN_CONTROL_TYPES).
const STEP_TYPES: &[&str] = &[
    "Button",
    "CheckBox",
    "ComboBox",
    "Hyperlink",
    "ListItem",
    "MenuItem",
    "MenuBar",
    "RadioButton",
    "SplitButton",
    "TabItem",
    "ToolBar",
    "TreeItem",
    "Text",
    "Group",
    "Pane",
    "Custom",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Show,
    Do,
}

pub fn plan_body(
    mode: Mode,
    request: &str,
    app: Option<&str>,
    controls: &[SummaryItem],
    plan_id: Option<&str>,
    happened: Option<&str>,
) -> Vec<u8> {
    let mut body = serde_json::json!({
        "mode": if mode == Mode::Show { "show" } else { "do" },
        "request": request.chars().take(300).collect::<String>(),
        "app": app.filter(|a| valid_app(a)),
        "controls": controls,
    });
    if let Some(id) = plan_id {
        body["planId"] = id.into();
    }
    if let Some(h) = happened {
        body["happened"] = h.chars().take(200).collect::<String>().into();
    }
    body.to_string().into_bytes()
}

/// An executable name the server accepts (AppName in packages/shared/src/screen.ts).
fn valid_app(app: &str) -> bool {
    app.len() <= 64
        && app.ends_with(".exe")
        && app
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || " ._+()-".contains(c))
}

/// DO IT's allowlist (v1). Nothing else can be carried out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoAction {
    FindFile {
        query: String,
        kind: FileKind,
        /// YYYY-MM-DD.
        since: Option<String>,
    },
    OpenSetting {
        page: String,
    },
    /// Dark (true) or light mode, switched for them: apps and Windows both.
    SetTheme {
        dark: bool,
    },
    SaveRecipe,
    BatchRename,
    /// The files selected in File Explorer (or the one named aloud, `which`: only ever from the
    /// device's own reading of the words), renamed by a rule (never a file name from the model).
    RenameFiles {
        /// Boxed: a rule is several strings, and every other action is small.
        rule: Box<super::rename_rule::RenameRule>,
        which: Option<String>,
    },
    /// Not on the list: offer SHOW ME instead.
    ShowMe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Any,
    Pdf,
    Document,
    Spreadsheet,
    Presentation,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub plan_id: String,
    pub speech: String,
    pub steps: Vec<Anchor>,
    pub action: Option<DoAction>,
}

fn plain(text: &str, max: usize) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn uuid_like(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// The server's reply, checked: a uuid, plain short texts, known control types, at most 8 steps,
/// and an action only from the allowlist (with a known settings page and a short query).
pub fn parse_plan(bytes: &[u8]) -> Option<Plan> {
    #[derive(Deserialize)]
    struct Step {
        #[serde(rename = "type")]
        ty: String,
        name: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        plan_id: String,
        speech: String,
        steps: Vec<Step>,
        action: Option<serde_json::Value>,
    }
    let reply: Reply = serde_json::from_slice(bytes).ok()?;
    if !uuid_like(&reply.plan_id) || reply.steps.len() > MAX_STEPS {
        return None;
    }
    let speech = plain(&reply.speech, SPEECH_MAX)?;
    let steps = reply
        .steps
        .into_iter()
        .map(|s| {
            STEP_TYPES.contains(&s.ty.as_str()).then_some(())?;
            Some(Anchor {
                control_type: s.ty,
                name: plain(&s.name, NAME_MAX)?,
                automation_id: String::new(),
                process: String::new(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let action = match reply.action {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(parse_action(&value)?),
    };
    Some(Plan {
        plan_id: reply.plan_id,
        speech,
        steps,
        action,
    })
}

/// One allowlisted action, checked (also what the intent route may answer with `do_it`).
pub fn parse_action(value: &serde_json::Value) -> Option<DoAction> {
    let field = |k: &str| value.get(k).and_then(|v| v.as_str());
    match field("type")? {
        "find_file" => {
            let kind = match field("kind")? {
                "any" => FileKind::Any,
                "pdf" => FileKind::Pdf,
                "document" => FileKind::Document,
                "spreadsheet" => FileKind::Spreadsheet,
                "presentation" => FileKind::Presentation,
                "image" => FileKind::Image,
                _ => return None,
            };
            let since = match value.get("since") {
                None | Some(serde_json::Value::Null) => None,
                Some(v) => {
                    let d = v.as_str()?;
                    let ok = d.len() == 10
                        && d.chars().enumerate().all(|(i, c)| {
                            if i == 4 || i == 7 {
                                c == '-'
                            } else {
                                c.is_ascii_digit()
                            }
                        });
                    ok.then(|| d.to_owned())?.into()
                }
            };
            Some(DoAction::FindFile {
                query: plain(field("query")?, 100)?,
                kind,
                since,
            })
        }
        "open_setting" => {
            let page = field("page")?;
            super::settings_uri::uri_for(page).map(|_| DoAction::OpenSetting {
                page: page.to_owned(),
            })
        }
        "set_theme" => match field("theme")? {
            "dark" => Some(DoAction::SetTheme { dark: true }),
            "light" => Some(DoAction::SetTheme { dark: false }),
            _ => None,
        },
        "save_recipe" => Some(DoAction::SaveRecipe),
        "batch_rename" => (field("scheme")? == "date_taken").then_some(DoAction::BatchRename),
        "rename_files" => super::rename_rule::parse(value).map(|rule| DoAction::RenameFiles {
            rule: Box::new(rule),
            which: None,
        }),
        "show_me" => Some(DoAction::ShowMe),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "44444444-4444-4444-8444-444444444444";

    #[test]
    fn a_good_show_plan_parses() {
        let reply = format!(
            r#"{{"planId":"{ID}","speech":"Click Personalization, then Colors.","steps":[{{"type":"ListItem","name":"Personalization"}},{{"type":"ListItem","name":"Colors"}}],"action":null}}"#
        );
        let plan = parse_plan(reply.as_bytes()).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[1].name, "Colors");
        assert!(plan.action.is_none());
    }

    #[test]
    fn anything_off_the_allowlist_or_malformed_is_refused() {
        let with = |action: &str| {
            format!(r#"{{"planId":"{ID}","speech":"ok","steps":[],"action":{action}}}"#)
        };
        for bad in [
            with(r#"{"type":"delete_file","path":"C:\\x"}"#),
            with(r#"{"type":"open_setting","page":"ms-settings:colors"}"#),
            with(r#"{"type":"open_setting","page":"regedit"}"#),
            with(r#"{"type":"find_file","query":"lease","kind":"exe","since":null}"#),
            with(r#"{"type":"find_file","query":"lease","kind":"pdf","since":"last week"}"#),
            with(r#"{"type":"batch_rename","scheme":"random"}"#),
            with(r#"{"type":"set_theme","theme":"purple"}"#),
            with(r#"{"type":"rename_files","name":null,"case":"keep"}"#),
            r#"{"planId":"nope","speech":"ok","steps":[],"action":null}"#.to_string(),
            format!(
                r#"{{"planId":"{ID}","speech":"ok","steps":[{{"type":"Edit","name":"x"}}],"action":null}}"#
            ),
            format!(r#"{{"planId":"{ID}","speech":"ok\u0007","steps":[],"action":null}}"#),
        ] {
            assert!(parse_plan(bad.as_bytes()).is_none(), "{bad}");
        }
        let dark = with(r#"{"type":"set_theme","theme":"dark"}"#);
        assert_eq!(
            parse_plan(dark.as_bytes()).unwrap().action,
            Some(DoAction::SetTheme { dark: true })
        );
        let ok = with(r#"{"type":"find_file","query":"lease","kind":"pdf","since":"2026-11-01"}"#);
        assert!(matches!(
            parse_plan(ok.as_bytes()).unwrap().action,
            Some(DoAction::FindFile {
                kind: FileKind::Pdf,
                ..
            })
        ));
    }

    #[test]
    fn the_body_carries_names_only() {
        let body = plan_body(
            Mode::Show,
            "how do I turn on dark mode?",
            Some("systemsettings.exe"),
            &[SummaryItem {
                control_type: "ListItem".into(),
                name: "Personalization".into(),
            }],
            None,
            None,
        );
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["controls"][0]["name"], "Personalization");
        assert!(v.get("image").is_none() && v.get("planId").is_none());
        // A path never goes as the app.
        let body = plan_body(
            Mode::Do,
            "x",
            Some("C:\\a.exe"),
            &[],
            Some(ID),
            Some("clicked Back"),
        );
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["app"].is_null());
        assert_eq!(v["planId"], ID);
    }
}
