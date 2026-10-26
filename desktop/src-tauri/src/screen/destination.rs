//! "Save it to my Physics notebook, chapter 5" on the desktop (K3, docs/NOTEBOOKS_K.md §4): what
//! the server resolved (checked here like every reply), where a session's entry goes, and the
//! words that are only a save ("save this to chemistry chapter 2"). Pure: no windows, no network.
//!
//! The student's notebook titles arrive only to be shown on the card (as text) and sent back with
//! the save; they're never logged.

use serde::{Deserialize, Serialize};

use super::protocol::{is_uuid, within};

const TITLE_CHARS: usize = 200;
const NEW_TITLE_CHARS: usize = 80;
const MAX_CHOICES: usize = 3;
/// The picker shows at most this many places (the server sends no more).
pub const MAX_PLACES: usize = 200;

/// Which page of the node: its "From screen" page, a new one, or its nth.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Page {
    #[default]
    FromScreen,
    New,
    Number {
        number: u16,
    },
}

/// A place in the student's notebook: a node and its titles from the notebook down, the page,
/// and (after "Create it and save") a chapter to make there first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub node_id: String,
    pub path: Vec<String>,
    pub page: Page,
    pub create: Option<String>,
}

impl Place {
    /// "Physics › Chapter 5" (with the chapter to be made, if any).
    pub fn label(&self) -> String {
        let mut parts = self.path.clone();
        if let Some(title) = &self.create {
            parts.push(title.clone());
        }
        parts.join(" › ")
    }
}

/// The `destination` of a clip as the server stores it (`SavedDestination`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationOut {
    pub node_id: String,
    pub page: Page,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create: Option<CreateOut>,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreateOut {
    pub title: String,
}

impl From<&Place> for DestinationOut {
    fn from(place: &Place) -> Self {
        DestinationOut {
            node_id: place.node_id.clone(),
            page: place.page.clone(),
            create: place.create.clone().map(|title| CreateOut { title }),
            path: place.path.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedIn {
    node_id: String,
    path: Vec<String>,
    page: Page,
    confidence: f32,
    method: String,
}

/// What the server made of the words (`DestinationResolution`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ResolutionIn {
    Resolved {
        destination: ResolvedIn,
    },
    Ambiguous {
        choices: Vec<ResolvedIn>,
    },
    #[serde(rename_all = "camelCase")]
    Missing {
        parent_id: String,
        parent_path: Vec<String>,
        title: String,
        page: Page,
    },
    None,
}

/// What the words came to, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// There. `sticky`: the source's place from earlier, not something the student just said.
    Resolved {
        place: Place,
        sticky: bool,
    },
    /// Close candidates: the student picks (never a guess).
    Choose(Vec<Place>),
    /// "There's no Chapter 5 in Physics yet": offered as "Create it and save".
    Missing {
        parent: Place,
        title: String,
    },
    None,
}

fn path_ok(path: &[String]) -> bool {
    (1..=3).contains(&path.len()) && path.iter().all(|t| within(t, TITLE_CHARS))
}

fn page_ok(page: &Page) -> bool {
    match page {
        Page::Number { number } => (1..=999).contains(number),
        _ => true,
    }
}

fn place_of(resolved: ResolvedIn) -> Option<Place> {
    let ok = is_uuid(&resolved.node_id)
        && path_ok(&resolved.path)
        && page_ok(&resolved.page)
        && (0.0..=1.0).contains(&resolved.confidence)
        && resolved.method.len() <= 16;
    ok.then_some(Place {
        node_id: resolved.node_id,
        path: resolved.path,
        page: resolved.page,
        create: None,
    })
}

fn resolution_of(value: ResolutionIn) -> Option<Resolution> {
    Some(match value {
        ResolutionIn::Resolved { destination } => {
            let sticky = destination.method == "sticky";
            Resolution::Resolved {
                place: place_of(destination)?,
                sticky,
            }
        }
        ResolutionIn::Ambiguous { choices } => {
            if choices.is_empty() || choices.len() > MAX_CHOICES {
                return None;
            }
            Resolution::Choose(choices.into_iter().map(place_of).collect::<Option<_>>()?)
        }
        ResolutionIn::Missing {
            parent_id,
            parent_path,
            title,
            page,
        } => {
            let ok = is_uuid(&parent_id)
                && path_ok(&parent_path)
                && page_ok(&page)
                && within(&title, NEW_TITLE_CHARS);
            if !ok {
                return None;
            }
            Resolution::Missing {
                parent: Place {
                    node_id: parent_id,
                    path: parent_path,
                    page,
                    create: None,
                },
                title,
            }
        }
        ResolutionIn::None => Resolution::None,
    })
}

/// The `resolution` of a `destination` stream event, or of `/api/screen/destinations/resolve`'s
/// reply (`{"resolution": …}`), checked; None for anything malformed.
pub fn parse_resolution(value: serde_json::Value) -> Option<Resolution> {
    resolution_of(serde_json::from_value(value).ok()?)
}

pub fn parse_resolve_reply(body: &[u8]) -> Option<Resolution> {
    #[derive(Deserialize)]
    struct Reply {
        resolution: serde_json::Value,
    }
    let reply: Reply = serde_json::from_slice(body).ok()?;
    parse_resolution(reply.resolution)
}

/// The picker's places (`/api/screen/destinations`'s reply), checked.
pub fn parse_places(body: &[u8]) -> Option<Vec<Place>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlaceIn {
        node_id: String,
        path: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Reply {
        places: Vec<PlaceIn>,
    }
    let reply: Reply = serde_json::from_slice(body).ok()?;
    if reply.places.len() > MAX_PLACES {
        return None;
    }
    reply
        .places
        .into_iter()
        .map(|p| {
            (is_uuid(&p.node_id) && path_ok(&p.path)).then_some(Place {
                node_id: p.node_id,
                path: p.path,
                page: Page::FromScreen,
                create: None,
            })
        })
        .collect()
}

// ─── The words ───────────────────────────────────────────────────────────────────────────────

const LEAD_IN: &[&str] = &[
    "hey", "neb", "mew", "ok", "okay", "please", "and", "then", "also", "can", "could", "you",
    "just", "now",
];
const VERBS: &[&str] = &[
    "save", "put", "add", "file", "keep", "store", "stick", "move", "send",
];
const OBJECTS: &[&str] = &["it", "this", "that", "these", "those", "them"];
const INTO: &[&str] = &["to", "in", "into", "under", "on", "onto", "inside"];
/// Where a plain "save this" goes anyway: these aren't a place.
const ANYWHERE: &[&str] = &[
    "notebook",
    "my notebook",
    "notes",
    "my notes",
    "the notebook",
    "neb",
];

/// The place in words that are only a save ("save this to Chemistry chapter 2", "put it in my
/// bio notebook", typed "save to physics ch 5"); None for anything else, including a question
/// that mentions saving and a plain "save this" (it goes where it always went).
pub fn save_to_phrase(words: &str) -> Option<String> {
    let lowered = words.trim().to_lowercase();
    let cleaned: String = lowered
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' || c == '.' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let tokens: Vec<&str> = cleaned
        .split_whitespace()
        .map(|t| t.trim_end_matches('.'))
        .filter(|t| !t.is_empty())
        .collect();
    let start = tokens
        .iter()
        .position(|t| !LEAD_IN.contains(t))
        .unwrap_or(tokens.len());
    let rest = &tokens[start..];
    let [verb, tail @ ..] = rest else {
        return None;
    };
    if !VERBS.contains(verb) {
        return None;
    }
    let tail = match tail {
        [object, more @ ..] if OBJECTS.contains(object) => more,
        _ => tail,
    };
    let [into, place @ ..] = tail else {
        return None;
    };
    if !INTO.contains(into) || place.is_empty() || place.len() > 12 {
        return None;
    }
    let phrase = place.join(" ");
    (!ANYWHERE.contains(&phrase.as_str())).then_some(phrase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NODE: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const OTHER: &str = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

    fn resolved(node: &str, path: &[&str], method: &str) -> serde_json::Value {
        json!({ "nodeId": node, "path": path, "page": { "kind": "from_screen" },
                "confidence": 0.9, "method": method })
    }

    #[test]
    fn reads_what_the_server_resolved() {
        let place = parse_resolution(json!({
            "kind": "resolved",
            "destination": resolved(NODE, &["Physics", "Chapter 5"], "fuzzy"),
        }));
        assert_eq!(
            place,
            Some(Resolution::Resolved {
                place: Place {
                    node_id: NODE.into(),
                    path: vec!["Physics".into(), "Chapter 5".into()],
                    page: Page::FromScreen,
                    create: None,
                },
                sticky: false,
            })
        );
        let sticky = parse_resolution(json!({
            "kind": "resolved", "destination": resolved(NODE, &["Physics"], "sticky"),
        }));
        assert!(matches!(
            sticky,
            Some(Resolution::Resolved { sticky: true, .. })
        ));
        let choose = parse_resolution(json!({
            "kind": "ambiguous",
            "choices": [resolved(NODE, &["Physics", "Ch 1"], "fuzzy"), resolved(OTHER, &["Physics II", "Ch 1"], "fuzzy")],
        }));
        assert!(matches!(choose, Some(Resolution::Choose(c)) if c.len() == 2));
        let missing = parse_resolution(json!({
            "kind": "missing", "parentId": NODE, "parentPath": ["Physics"], "title": "Chapter 5",
            "page": { "kind": "number", "number": 3 },
        }));
        assert!(matches!(
            missing,
            Some(Resolution::Missing { parent, title }) if parent.page == Page::Number { number: 3 } && title == "Chapter 5"
        ));
        assert_eq!(
            parse_resolution(json!({ "kind": "none" })),
            Some(Resolution::None)
        );
        assert_eq!(
            parse_resolve_reply(br#"{"resolution":{"kind":"none"}}"#),
            Some(Resolution::None)
        );
    }

    #[test]
    fn refuses_anything_malformed() {
        for bad in [
            json!({ "kind": "resolved", "destination": resolved("physics", &["Physics"], "fuzzy") }),
            json!({ "kind": "resolved", "destination": resolved(NODE, &[], "fuzzy") }),
            json!({ "kind": "resolved", "destination": resolved(NODE, &["a", "b", "c", "d"], "fuzzy") }),
            json!({ "kind": "resolved", "destination": resolved(NODE, &["bad\u{7}title"], "fuzzy") }),
            json!({ "kind": "ambiguous", "choices": [] }),
            json!({ "kind": "ambiguous", "choices": [
                resolved(NODE, &["a"], "x"), resolved(NODE, &["b"], "x"),
                resolved(NODE, &["c"], "x"), resolved(NODE, &["d"], "x")] }),
            json!({ "kind": "missing", "parentId": NODE, "parentPath": ["P"], "title": "",
                    "page": { "kind": "from_screen" } }),
            json!({ "kind": "missing", "parentId": NODE, "parentPath": ["P"], "title": "x",
                    "page": { "kind": "number", "number": 0 } }),
            json!({ "kind": "elsewhere" }),
            json!("none"),
        ] {
            assert_eq!(parse_resolution(bad.clone()), None, "{bad}");
        }
        assert_eq!(
            parse_places(br#"{"places":[{"nodeId":"x","path":["P"]}]}"#),
            None
        );
        assert_eq!(
            parse_places(
                format!(r#"{{"places":[{{"nodeId":"{NODE}","path":["Physics","Ch 2"]}}]}}"#)
                    .as_bytes()
            )
            .map(|p| p[0].label()),
            Some("Physics › Ch 2".to_owned())
        );
    }

    #[test]
    fn saves_as_the_server_stores_it() {
        let place = Place {
            node_id: NODE.into(),
            path: vec!["Physics".into()],
            page: Page::New,
            create: Some("Chapter 5".into()),
        };
        assert_eq!(place.label(), "Physics › Chapter 5");
        assert_eq!(
            serde_json::to_value(DestinationOut::from(&place)).unwrap(),
            json!({ "nodeId": NODE, "page": { "kind": "new" }, "create": { "title": "Chapter 5" },
                    "path": ["Physics"] })
        );
    }

    #[test]
    fn knows_words_that_are_only_a_save() {
        for (said, phrase) in [
            ("save this to Chemistry chapter 2", "chemistry chapter 2"),
            (
                "Save it to my physics notebook, chapter 5.",
                "my physics notebook chapter 5",
            ),
            ("put it in my bio notebook", "my bio notebook"),
            ("save to physics ch 5", "physics ch 5"),
            (
                "Neb, please file this under week 2 of biology",
                "week 2 of biology",
            ),
            ("and save it to maths", "maths"),
            ("move it to physics chapter 1", "physics chapter 1"),
        ] {
            assert_eq!(save_to_phrase(said).as_deref(), Some(phrase), "{said}");
        }
        for said in [
            "save this",
            "save this to my notebook",
            "put it in my notes",
            "why is this the hypotenuse? save it to physics",
            "how do I save this to PDF",
            "what does save mean",
            "",
            "save it to",
        ] {
            assert_eq!(save_to_phrase(said), None, "{said}");
        }
    }
}
