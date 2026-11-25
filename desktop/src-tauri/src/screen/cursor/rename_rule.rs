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

/// Words before the request that don't change it ("hey Neb, could you…", "I want to…").
const LEAD_IN: &[&str] = &[
    "hey", "neb", "mew", "ok", "okay", "please", "can", "could", "would", "will", "you", "i",
    "want", "wanna", "to", "like", "id", "i'd", "lets", "let's", "go", "ahead", "and", "just",
    "quickly", "need", "so",
];
/// How a rename is asked for; the file (if named) and " to " + the new name follow.
const VERBS: &[&str] = &[
    "rename ",
    "change the name of ",
    "change the name ",
    "change its name ",
    "change their names ",
];
/// After " to ", words that make it a purpose, not a name ("rename my thesis to make it
/// shorter"): the model reads those.
const PURPOSE: &[&str] = &[
    "make ",
    "be ",
    "fit ",
    "match ",
    "reflect ",
    "show ",
    "something",
    "anything",
    "whatever",
];

/// What a plain "rename … to …" asked for: the rule, and the file it named, if it named one
/// ("rename the file called notes to Final": `which` is "notes").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    pub rule: RenameRule,
    pub which: Option<String>,
}

/// "rename this to Budget 2026", "Neb, rename these files as trip", "rename the file called
/// notes to Final", "change the name of my essay to Essay v2": a new name, said plainly. None
/// for any other wording (the model reads those). The name keeps the case it was said in.
pub fn from_words(said: &str) -> Option<Said> {
    let lower = said.to_lowercase();
    // Byte offsets only line up when lowercasing kept every length (true for nearly all text).
    if lower.len() != said.len() {
        return None;
    }
    // The earliest, and of two at the same place the longest ("change the name of", not
    // "change the name").
    let (start, verb) = VERBS
        .iter()
        .filter_map(|v| lower.find(v).map(|i| (i, v.len())))
        .min_by_key(|&(i, len)| (i, std::cmp::Reverse(len)))?;
    let before = lower[..start].replace([',', '.', '!', '?'], " ");
    if !before.split_whitespace().all(|w| LEAD_IN.contains(&w)) {
        return None;
    }
    let after = start + verb;
    let (to_at, to_len) = [" to ", " as "]
        .iter()
        .filter_map(|sep| {
            lower[after - 1..]
                .find(sep)
                .map(|i| (after - 1 + i, sep.len()))
        })
        .min()?;
    // What's between names the file: "this", "these photos", "the file called notes".
    let which: Vec<&str> = said[after..to_at.max(after)]
        .split_whitespace()
        .filter(|w| {
            let w = w.to_lowercase();
            !OBJECT_WORDS.contains(&w.as_str()) && !matches!(w.as_str(), "called" | "named" | "of")
        })
        .collect();
    let which = which.join(" ");
    let which = which
        .trim_matches(['"', '\'', '“', '”', '‘', '’', ','])
        .trim();
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
    let which = (!which.is_empty() && which.chars().count() <= TEXT_MAX).then(|| which.to_owned());
    // "rename these to start with 2026": the names stay, with 2026 in front.
    if let Some((front, text)) = affix(name) {
        return Some(Said {
            rule: affix_rule(front, &text)?,
            which,
        });
    }
    let purpose = PURPOSE.iter().any(|p| name.to_lowercase().starts_with(p));
    if name.is_empty()
        || purpose
        || name.chars().count() > TEXT_MAX
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(Said {
        rule: RenameRule {
            name: Some(name.to_owned()),
            prefix: None,
            suffix: None,
            find: None,
            replace: None,
            case: Case::Keep,
        },
        which,
    })
}

/// What follows "rename these to" when it isn't a new name but where to add something: "start
/// with 2026" (true: in front), "end with final", "have 2026 at the start", "have v2 at the end".
fn affix(said: &str) -> Option<(bool, String)> {
    let lower = said.to_lowercase();
    if lower.len() != said.len() {
        return None;
    }
    const FRONT: &[&str] = &["start with ", "starts with ", "begin with ", "begins with "];
    const BACK: &[&str] = &["end with ", "ends with ", "finish with ", "finishes with "];
    for (markers, front) in [(FRONT, true), (BACK, false)] {
        if let Some(m) = markers.iter().find(|m| lower.starts_with(**m)) {
            return Some((front, said[m.len()..].to_owned()));
        }
    }
    // "have 2026 at the start", "have final at the end".
    let rest = lower.strip_prefix("have ")?;
    const AT_FRONT: &[&str] = &[
        " at the start",
        " at the front",
        " at the beginning",
        " in front",
    ];
    const AT_BACK: &[&str] = &[" at the end"];
    for (markers, front) in [(AT_FRONT, true), (AT_BACK, false)] {
        if let Some(m) = markers.iter().find(|m| rest.ends_with(**m)) {
            let text = &said["have ".len()..said.len() - m.len()];
            return Some((front, text.to_owned()));
        }
    }
    None
}

/// A prefix or suffix rule for `text`, with a space between it and the name unless it already
/// ends (or starts) with a separator ("2026-", "_v2").
fn affix_rule(front: bool, text: &str) -> Option<RenameRule> {
    let text = text
        .trim()
        .trim_end_matches(['.', '!', '?', ','])
        .trim_matches(['"', '\'', '“', '”', '‘', '’'])
        .trim();
    if text.is_empty() || text.chars().count() > TEXT_MAX || text.chars().any(char::is_control) {
        return None;
    }
    let joined = |c: Option<char>| c.is_some_and(|c| matches!(c, '-' | '_' | '.' | ' '));
    let (prefix, suffix) = if front {
        let space = if joined(text.chars().last()) { "" } else { " " };
        (Some(format!("{text}{space}")), None)
    } else {
        let space = if joined(text.chars().next()) { "" } else { " " };
        (None, Some(format!("{space}{text}")))
    };
    Some(RenameRule {
        name: None,
        prefix,
        suffix,
        find: None,
        replace: None,
        case: Case::Keep,
    })
}

/// "add 2026 to the start of these names", "put final at the end of the file names", "put 2026
/// in front of these files": a prefix or suffix, said without "rename". Only when what it's added
/// to is plainly file names (so "add a title to the start of this document" stays typing).
pub fn affix_request(said: &str) -> Option<Said> {
    let lower = said.to_lowercase().replace([',', '!', '?'], " ");
    if lower.len() != said.len() {
        return None;
    }
    let (start, verb) = ["add ", "put "]
        .iter()
        .filter_map(|v| lower.find(v).map(|i| (i, v.len())))
        .min()?;
    if !lower[..start]
        .split_whitespace()
        .all(|w| LEAD_IN.contains(&w))
    {
        return None;
    }
    const MARKERS: &[(&str, bool)] = &[
        (" to the start of ", true),
        (" at the start of ", true),
        (" to the front of ", true),
        (" at the front of ", true),
        (" to the beginning of ", true),
        (" at the beginning of ", true),
        (" in front of ", true),
        (" to the end of ", false),
        (" at the end of ", false),
    ];
    let after = start + verb;
    let (at, len, front) = MARKERS
        .iter()
        .filter_map(|(m, front)| {
            lower[after - 1..]
                .find(m)
                .map(|i| (after - 1 + i, m.len(), *front))
        })
        .min_by_key(|&(at, ..)| at)?;
    let text = &said[after..at.max(after)];
    let target: Vec<&str> = lower[at + len..]
        .trim_end_matches(['.', ' '])
        .split_whitespace()
        .collect();
    // What it's added to: names or files, and nothing else.
    let names = target.iter().any(|w| {
        matches!(
            *w,
            "name" | "names" | "filename" | "filenames" | "files" | "these" | "them" | "those"
        )
    });
    let plain = target.iter().all(|w| {
        OBJECT_WORDS.contains(w) || matches!(*w, "name" | "names" | "filename" | "filenames")
    });
    if !(names && plain) {
        return None;
    }
    Some(Said {
        rule: affix_rule(front, text)?,
        which: None,
    })
}

/// The item a rename named ("the file called notes"), among a folder's: one whose name (without
/// its extension) is that, else the only one whose name holds it. None when there's none, or
/// more than one could be meant.
pub fn named_item<'a>(items: &'a [PathBuf], which: &str) -> Option<&'a PathBuf> {
    let which = which.to_lowercase();
    let stem = |p: &PathBuf| {
        let name = p.file_name()?.to_string_lossy().to_lowercase();
        Some(match p.extension() {
            Some(e) => name[..name.len() - e.len() - 1].to_owned(),
            None => name,
        })
    };
    let full = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
    if let Some(exact) = items.iter().find(|p| {
        stem(p).as_deref() == Some(which.as_str()) || full(p).as_deref() == Some(which.as_str())
    }) {
        return Some(exact);
    }
    let mut holding = items
        .iter()
        .filter(|p| stem(p).is_some_and(|s| s.contains(&which)));
    let first = holding.next()?;
    holding.next().is_none().then_some(first)
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
        let said = |s: &str| from_words(s).map(|s| (s.rule, s.which));
        for (words, name, which) in [
            ("rename this to Budget 2026", "Budget 2026", None),
            (
                "Neb, rename this file to budget final.",
                "budget final",
                None,
            ),
            (
                "can you rename these photos as Trip to Rome",
                "Trip to Rome",
                None,
            ),
            ("rename it to \"Essay draft\" please", "Essay draft", None),
            ("rename the two files to notes", "notes", None),
            (
                "rename the file called notes to Final notes",
                "Final notes",
                Some("notes"),
            ),
            (
                "I want to rename my essay to Essay v2",
                "Essay v2",
                Some("essay"),
            ),
            (
                "change the name of the budget file to Budget 2026",
                "Budget 2026",
                Some("budget"),
            ),
            ("could you change its name to Lease", "Lease", None),
        ] {
            assert_eq!(
                said(words),
                Some((named(name), which.map(str::to_owned))),
                "{words}"
            );
        }
        for words in [
            "rename these photos by date",
            "how do I rename a file to something else",
            "rename",
            "rename this to",
            "rename my thesis to make it shorter", // a purpose: the model reads it
            "why did you rename it to that",
        ] {
            assert_eq!(said(words), None, "{words}");
        }
    }

    #[test]
    fn start_with_and_end_with_keep_the_name() {
        let rule = |prefix: Option<&str>, suffix: Option<&str>| RenameRule {
            name: None,
            prefix: prefix.map(str::to_owned),
            suffix: suffix.map(str::to_owned),
            find: None,
            replace: None,
            case: Case::Keep,
        };
        for (words, want) in [
            ("rename these to start with 2026", rule(Some("2026 "), None)),
            (
                "rename this file to end with final",
                rule(None, Some(" final")),
            ),
            (
                "rename these photos to begin with Trip-",
                rule(Some("Trip-"), None),
            ),
            (
                "rename these to have v2 at the end",
                rule(None, Some(" v2")),
            ),
            (
                "rename them to have 2026 at the start.",
                rule(Some("2026 "), None),
            ),
        ] {
            assert_eq!(from_words(words).map(|s| s.rule), Some(want), "{words}");
        }
        for (words, want) in [
            (
                "add 2026 to the start of these names",
                rule(Some("2026 "), None),
            ),
            (
                "put final at the end of the file names",
                rule(None, Some(" final")),
            ),
            (
                "Neb, put 2026 in front of these files",
                rule(Some("2026 "), None),
            ),
            (
                "can you add _old to the end of them",
                rule(None, Some("_old")),
            ),
        ] {
            assert_eq!(affix_request(words).map(|s| s.rule), Some(want), "{words}");
        }
        for words in [
            "add a title to the start of this document",
            "put a heading at the start of the page",
            "add this to my notebook",
            "add milk to the end of my shopping list",
        ] {
            assert_eq!(affix_request(words), None, "{words}");
        }
        // The names stay: only the prefix is added.
        let files = [
            PathBuf::from(r"C:\d\beach.jpg"),
            PathBuf::from(r"C:\d\city.jpg"),
        ];
        let said = from_words("rename these to start with 2026").unwrap();
        assert_eq!(
            names(&plan(&files, &said.rule, |_| false).unwrap()),
            vec!["2026 beach.jpg", "2026 city.jpg"]
        );
    }

    #[test]
    fn a_named_file_is_found_only_when_its_clear() {
        let items = [
            PathBuf::from(r"C:\d\notes.txt"),
            PathBuf::from(r"C:\d\notes old.txt"),
            PathBuf::from(r"C:\d\Budget 2026.xlsx"),
        ];
        assert_eq!(named_item(&items, "notes"), Some(&items[0]));
        assert_eq!(named_item(&items, "budget"), Some(&items[2]));
        assert_eq!(named_item(&items, "Notes old.txt"), Some(&items[1]));
        assert_eq!(named_item(&items, "essay"), None);
        let two = [
            PathBuf::from(r"C:\d\a notes.txt"),
            PathBuf::from(r"C:\d\b notes.txt"),
        ];
        assert_eq!(named_item(&two, "notes"), None);
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
