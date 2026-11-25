//! DO IT's `rename_files`: the files the student selected in File Explorer, renamed the way they
//! asked ("rename this to budget 2026", "rename these to trip", "add 2026 to the start of
//! these", "replace draft with final in these names"). Asked for in so many words only.
//!
//! The model never sees a file name: it reads only what was said and answers a rule (a new
//! name, a prefix, a suffix, a find-and-replace, a case), and the rule is applied here, to the
//! names on this computer. The plain wording ("rename this to …") needs no model at all.
//!
//! Every new name keeps its file's extension (a changed extension can stop a file opening), is
//! a legal Windows name, never lands on another file's name (" (2)" is added instead), and is
//! shown in a before → after table first. The renaming itself, its undo log and the undo are
//! `rename.rs`'s.

use std::path::{Path, PathBuf};

/// The longest text a rule may carry (a name, a prefix, …).
pub const TEXT_MAX: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Case {
    Keep,
    Lower,
    Upper,
    Title,
}

/// How to rename. Applied in this order: `name` (numbered " 1", " 2"… when there are several
/// files), `find` → `replace`, `prefix`, `suffix`, `case`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameRule {
    pub name: Option<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub find: Option<String>,
    pub replace: Option<String>,
    pub case: Case,
}

impl RenameRule {
    fn changes_something(&self) -> bool {
        self.name.is_some()
            || self.prefix.is_some()
            || self.suffix.is_some()
            || self.find.is_some()
            || self.case != Case::Keep
    }
}

/// A rule's text: short, no control characters (None when absent or empty). `trim`: for a whole
/// name; a prefix or suffix keeps its spaces ("2026 " goes before the name with a space).
fn text(value: Option<&serde_json::Value>, trim: bool) -> Result<Option<String>, ()> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => {
            let s = v.as_str().ok_or(())?;
            if s.chars().count() > TEXT_MAX || s.chars().any(char::is_control) {
                return Err(());
            }
            let s = if trim { s.trim() } else { s };
            Ok((!s.is_empty()).then(|| s.to_owned()))
        }
    }
}

/// The model's rule, checked (the `rename_files` action, packages/shared/src/screen-plan.ts).
pub fn parse(value: &serde_json::Value) -> Option<RenameRule> {
    let case = match value.get("case").and_then(|v| v.as_str()).unwrap_or("keep") {
        "keep" => Case::Keep,
        "lower" => Case::Lower,
        "upper" => Case::Upper,
        "title" => Case::Title,
        _ => return None,
    };
    let rule = RenameRule {
        name: text(value.get("name"), true).ok()?,
        prefix: text(value.get("prefix"), false).ok()?,
        suffix: text(value.get("suffix"), false).ok()?,
        find: text(value.get("find"), false).ok()?,
        // None or empty: what's found is removed ("take 'copy' out of these names").
        replace: text(value.get("replace"), false).ok()?,
        case,
    };
    rule.changes_something().then_some(rule)
}

/// Words that may sit between "rename" and "to": "rename these two files to …".
const OBJECT_WORDS: &[&str] = &[
    "this",
    "that",
    "it",
    "these",
    "those",
    "them",
    "the",
    "my",
    "all",
    "selected",
    "one",
    "two",
    "three",
    "file",
    "files",
    "folder",
    "folders",
    "document",
    "documents",
    "doc",
    "docs",
    "photo",
    "photos",
    "picture",
    "pictures",
    "image",
    "images",
    "pic",
    "pics",
    "video",
    "videos",
    "pdf",
    "pdfs",
];

/// "rename this to Budget 2026", "Neb, rename these files as trip": a new name, said plainly.
/// None for any other wording (the model reads those). The name keeps the case it was said in.
pub fn from_words(said: &str) -> Option<RenameRule> {
    let lower = said.to_lowercase();
    // Byte offsets only line up when lowercasing kept every length (true for nearly all text).
    if lower.len() != said.len() {
        return None;
    }
    let start = lower.find("rename ")?;
    // Only polite words before it ("hey Neb, can you rename…").
    let before = lower[..start].replace([',', '.', '!', '?'], " ");
    let polite = before.split_whitespace().all(|w| {
        matches!(
            w,
            "hey" | "neb" | "mew" | "ok" | "okay" | "please" | "can" | "could" | "would" | "you"
        )
    });
    if !polite {
        return None;
    }
    let after = start + "rename ".len();
    let (to_at, to_len) = [" to ", " as "]
        .iter()
        .filter_map(|sep| {
            lower[after - 1..]
                .find(sep)
                .map(|i| (after - 1 + i, sep.len()))
        })
        .min()?;
    let between = &lower[after..to_at.max(after)];
    if !between
        .split_whitespace()
        .all(|w| OBJECT_WORDS.contains(&w))
    {
        return None;
    }
    let name = said[to_at + to_len..]
        .trim()
        .trim_end_matches(['.', '!', '?', ',']);
    let name = name
        .strip_suffix(" please")
        .or_else(|| name.strip_suffix(" for me"))
        .unwrap_or(name)
        .trim()
        .trim_end_matches(['.', '!', '?', ','])
        .trim_matches(['"', '\'', '“', '”', '‘', '’'])
        .trim();
    if name.is_empty() || name.chars().count() > TEXT_MAX || name.chars().any(char::is_control) {
        return None;
    }
    Some(RenameRule {
        name: Some(name.to_owned()),
        prefix: None,
        suffix: None,
        find: None,
        replace: None,
        case: Case::Keep,
    })
}

/// Characters Windows never allows in a name.
const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A name Windows will take, or why not (in words for the student).
fn legal(stem: &str) -> Result<String, String> {
    if let Some(c) = stem.chars().find(|c| FORBIDDEN.contains(c)) {
        return Err(format!(
            "A file name can't have {c} in it. Ask again without it."
        ));
    }
    let stem = stem.trim().trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return Err("That would leave a file with no name.".into());
    }
    if RESERVED.contains(&stem.to_lowercase().as_str()) {
        return Err(format!(
            "Windows keeps the name {stem} for itself. Try another."
        ));
    }
    if stem.chars().count() > 200 {
        return Err("That name is too long for Windows.".into());
    }
    Ok(stem.to_owned())
}

/// `text` with every `find` replaced, ignoring case where that's safe to do.
fn replace_all(text: &str, find: &str, with: &str) -> String {
    let (lt, lf) = (text.to_lowercase(), find.to_lowercase());
    if lt.len() != text.len() || lf.len() != find.len() {
        return text.replace(find, with);
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(i) = lt[at..].find(&lf) {
        out.push_str(&text[at..at + i]);
        out.push_str(with);
        at += i + lf.len();
    }
    out.push_str(&text[at..]);
    out
}

fn title_case(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut start = true;
    for c in text.chars() {
        if start {
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_lowercase());
        }
        start = c.is_whitespace() || c == '-' || c == '_';
    }
    out
}

/// The same name to Windows (it ignores case): a rename that only changes case is allowed.
pub fn same_name(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// The renames for the selected `items` (sorted by name), or why there are none. `exists` says
/// whether a name is taken on disk.
pub fn plan(
    items: &[PathBuf],
    rule: &RenameRule,
    exists: impl Fn(&Path) -> bool,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut items: Vec<&PathBuf> = items.iter().take(super::rename::MAX_FILES).collect();
    items.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    let numbered = rule.name.is_some() && items.len() > 1;
    let mut claimed: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for (i, path) in items.iter().enumerate() {
        let (Some(file), Some(dir)) = (path.file_name(), path.parent()) else {
            continue;
        };
        let file = file.to_string_lossy().to_string();
        // Folders, and names with no extension, keep the whole name as the stem.
        let (stem, ext) = match path.extension() {
            Some(e) if !path.is_dir() => {
                let ext = format!(".{}", e.to_string_lossy());
                (file[..file.len() - ext.len()].to_owned(), ext)
            }
            _ => (file.clone(), String::new()),
        };
        let mut new = match &rule.name {
            Some(name) => {
                // "budget.pdf" said for a PDF: the extension isn't said twice.
                let name = if !ext.is_empty() && name.to_lowercase().ends_with(&ext.to_lowercase())
                {
                    &name[..name.len() - ext.len()]
                } else {
                    name.as_str()
                };
                if numbered {
                    format!("{name} {}", i + 1)
                } else {
                    name.to_owned()
                }
            }
            None => stem.clone(),
        };
        if let Some(find) = &rule.find {
            new = replace_all(&new, find, rule.replace.as_deref().unwrap_or(""));
        }
        if let Some(prefix) = &rule.prefix {
            new = format!("{prefix}{new}");
        }
        if let Some(suffix) = &rule.suffix {
            new = format!("{new}{suffix}");
        }
        new = match rule.case {
            Case::Keep => new,
            Case::Lower => new.to_lowercase(),
            Case::Upper => new.to_uppercase(),
            Case::Title => title_case(&new),
        };
        let new = legal(&new)?;
        if format!("{new}{ext}") == file {
            continue; // already so
        }
        let mut n = 1;
        let target = loop {
            let candidate = if n == 1 {
                dir.join(format!("{new}{ext}"))
            } else {
                dir.join(format!("{new} ({n}){ext}"))
            };
            let taken = claimed.iter().any(|c| same_name(c, &candidate))
                || (exists(&candidate) && !same_name(&candidate, path));
            if !taken {
                break candidate;
            }
            n += 1;
        };
        claimed.push(target.clone());
        out.push(((*path).clone(), target));
    }
    if out.is_empty() {
        return Err("Those already have those names.".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str) -> RenameRule {
        RenameRule {
            name: Some(name.into()),
            prefix: None,
            suffix: None,
            find: None,
            replace: None,
            case: Case::Keep,
        }
    }

    fn names(plan: &[(PathBuf, PathBuf)]) -> Vec<String> {
        plan.iter()
            .map(|(_, to)| to.file_name().unwrap().to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn plain_words_name_the_file() {
        for (said, name) in [
            ("rename this to Budget 2026", "Budget 2026"),
            ("Neb, rename this file to budget final.", "budget final"),
            (
                "can you rename these photos as Trip to Rome",
                "Trip to Rome",
            ),
            ("rename it to \"Essay draft\" please", "Essay draft"),
            ("rename the two files to notes", "notes"),
        ] {
            assert_eq!(from_words(said), Some(named(name)), "{said}");
        }
        for said in [
            "rename these photos by date",
            "how do I rename a file to something else",
            "rename",
            "rename this to",
            "I want to rename my thesis to make it shorter", // not plain: the model reads it
        ] {
            assert_eq!(from_words(said), None, "{said}");
        }
    }

    #[test]
    fn the_models_rule_is_checked() {
        let ok = serde_json::json!({"type":"rename_files","name":null,"prefix":"2026 ","suffix":null,"find":null,"replace":null,"case":"keep"});
        assert_eq!(parse(&ok).unwrap().prefix.as_deref(), Some("2026 "));
        for bad in [
            serde_json::json!({"name":null,"prefix":null,"suffix":null,"find":null,"replace":null,"case":"keep"}),
            serde_json::json!({"name":"x","case":"sideways"}),
            serde_json::json!({"name":"a\u{7}b","case":"keep"}),
            serde_json::json!({"name":"x".repeat(101),"case":"keep"}),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn one_file_keeps_its_extension_and_several_are_numbered() {
        let one = [PathBuf::from("C:\\d\\IMG_1.JPG")];
        let plan1 = plan(&one, &named("Beach"), |_| false).unwrap();
        assert_eq!(names(&plan1), vec!["Beach.JPG"]);
        // Saying the extension doesn't double it.
        let pdf = [PathBuf::from("C:\\d\\scan.pdf")];
        assert_eq!(
            names(&plan(&pdf, &named("Lease.pdf"), |_| false).unwrap()),
            vec!["Lease.pdf"]
        );
        let many = [
            PathBuf::from("C:\\d\\b.jpg"),
            PathBuf::from("C:\\d\\a.jpg"),
            PathBuf::from("C:\\d\\c.png"),
        ];
        assert_eq!(
            names(&plan(&many, &named("Trip"), |_| false).unwrap()),
            vec!["Trip 1.jpg", "Trip 2.jpg", "Trip 3.png"]
        );
    }

    #[test]
    fn prefixes_replacements_and_case() {
        let files = [
            PathBuf::from("C:\\d\\essay DRAFT.docx"),
            PathBuf::from("C:\\d\\notes draft.txt"),
        ];
        let rule = RenameRule {
            name: None,
            prefix: Some("2026 ".into()),
            suffix: None,
            find: Some("draft".into()),
            replace: Some("final".into()),
            case: Case::Title,
        };
        assert_eq!(
            names(&plan(&files, &rule, |_| false).unwrap()),
            vec!["2026 Essay Final.docx", "2026 Notes Final.txt"]
        );
    }

    #[test]
    fn never_lands_on_another_name_and_refuses_illegal_ones() {
        let files = [PathBuf::from("C:\\d\\a.txt")];
        let taken = |p: &Path| p.ends_with("Notes.txt");
        assert_eq!(
            names(&plan(&files, &named("Notes"), taken).unwrap()),
            vec!["Notes (2).txt"]
        );
        // A case-only change of the same file is allowed (Windows sees one name).
        let same = [PathBuf::from("C:\\d\\notes.txt")];
        let exists = |p: &Path| same_name(p, Path::new("C:\\d\\notes.txt"));
        assert_eq!(
            names(&plan(&same, &named("Notes"), exists).unwrap()),
            vec!["Notes.txt"]
        );
        assert!(plan(&files, &named("a/b"), |_| false).is_err());
        assert!(plan(&files, &named("CON"), |_| false).is_err());
        assert!(plan(&files, &named("a"), |_| false).is_err()); // already so
    }
}
