//! DO IT's `find_file` (F): a query for the Windows Search index (SystemIndex), the choice among
//! what it found, and where the file is, as a breadcrumb for the replay.
//!
//! The query is built here from the plan's words, after keeping only letters, digits, spaces and
//! `-_.` in each, so nothing in it can change the query's meaning. It's read-only (SystemIndex
//! answers SELECTs only), limited to the student's own files, and never returns system or app
//! folders.

use serde::Deserialize;

use super::plan::FileKind;

const MAX_TERMS: usize = 5;
const TERM_MAX: usize = 40;
pub const RESULTS: usize = 10;

/// Search words: each kept to safe characters, short, at most five, no filler.
pub fn terms(query: &str) -> Vec<String> {
    const FILLER: &[&str] = &[
        "my", "the", "a", "an", "file", "files", "document", "doc", "pdf", "of", "for", "from",
    ];
    query
        .split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .take(TERM_MAX)
                .collect::<String>()
                .trim_matches('.')
                .to_lowercase()
        })
        .filter(|w| w.chars().count() >= 2 && !FILLER.contains(&w.as_str()))
        .take(MAX_TERMS)
        .collect()
}

fn extensions(kind: FileKind) -> &'static [&'static str] {
    match kind {
        FileKind::Any => &[],
        FileKind::Pdf => &[".pdf"],
        FileKind::Document => &[".docx", ".doc", ".odt", ".rtf", ".txt", ".pdf", ".md"],
        FileKind::Spreadsheet => &[".xlsx", ".xls", ".csv", ".ods"],
        FileKind::Presentation => &[".pptx", ".ppt", ".odp", ".key"],
        FileKind::Image => &[
            ".jpg", ".jpeg", ".png", ".heic", ".gif", ".webp", ".bmp", ".tif", ".tiff",
        ],
    }
}

/// The SystemIndex query, or None without usable words.
pub fn search_sql(terms: &[String], kind: FileKind, since: Option<&str>) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let mut sql = format!(
        "SELECT TOP {RESULTS} System.ItemPathDisplay, System.DateModified, System.Search.Rank \
         FROM SystemIndex WHERE SCOPE='file:' AND System.FileAttributes <> 0 \
         AND NOT System.ItemPathDisplay LIKE '%\\AppData\\%' \
         AND NOT System.ItemPathDisplay LIKE '%\\Windows\\%' \
         AND NOT System.ItemPathDisplay LIKE '%\\Program Files%'"
    );
    for term in terms {
        // Safe by construction (`terms`): no quotes, percent signs or brackets can be in it.
        debug_assert!(term
            .chars()
            .all(|c| c.is_alphanumeric() || "-_.".contains(c)));
        sql.push_str(&format!(
            " AND (System.ItemNameDisplay LIKE '%{term}%' OR CONTAINS(*, '\"{term}*\"'))"
        ));
    }
    let ext = extensions(kind);
    if !ext.is_empty() {
        let list: Vec<String> = ext.iter().map(|e| format!("'{e}'")).collect();
        sql.push_str(&format!(
            " AND System.FileExtension IN ({})",
            list.join(",")
        ));
    }
    if let Some(day) = since.filter(|d| valid_day(d)) {
        sql.push_str(&format!(" AND System.DateModified >= '{day}'"));
    }
    sql.push_str(" ORDER BY System.Search.Rank DESC, System.DateModified DESC");
    Some(sql)
}

fn valid_day(d: &str) -> bool {
    d.len() == 10
        && d.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// One file the index found.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Found {
    pub path: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub rank: f64,
}

/// The helper's JSON (a list, or one object when there was one), checked.
pub fn parse_found(json: &[u8]) -> Vec<Found> {
    let text = String::from_utf8_lossy(json);
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Vec::new();
    }
    let list: Vec<Found> = serde_json::from_str::<Vec<Found>>(text)
        .or_else(|_| serde_json::from_str::<Found>(text).map(|f| vec![f]))
        .unwrap_or_default();
    list.into_iter()
        .filter(|f| f.path.len() < 1024 && !f.path.chars().any(char::is_control))
        .take(RESULTS)
        .collect()
}

/// Files never opened by DO IT (they'd run something): only revealed in their folder.
pub fn runs_something(path: &str) -> bool {
    const RUNNABLE: &[&str] = &[
        ".exe",
        ".com",
        ".bat",
        ".cmd",
        ".ps1",
        ".psm1",
        ".vbs",
        ".vbe",
        ".js",
        ".jse",
        ".wsf",
        ".wsh",
        ".msi",
        ".msp",
        ".scr",
        ".lnk",
        ".url",
        ".hta",
        ".cpl",
        ".jar",
        ".reg",
        ".dll",
        ".appx",
        ".msix",
        ".application",
        ".pif",
        ".inf",
    ];
    let lower = path.to_lowercase();
    RUNNABLE.iter().any(|ext| lower.ends_with(ext))
}

/// What to do with the results.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Nothing,
    /// Sure enough to open it.
    Certain(usize),
    /// Ask which (at most three, best first).
    Ask(Vec<usize>),
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Certain when there's one result, or the top one names every word while the next names
/// fewer, or it ranks well ahead (×1.5); otherwise the student picks from the top three.
pub fn choose(found: &[Found], terms: &[String]) -> Choice {
    match found.len() {
        0 => return Choice::Nothing,
        1 => return Choice::Certain(0),
        _ => {}
    }
    let named = |f: &Found| {
        let name = file_name(&f.path).to_lowercase();
        terms.iter().filter(|t| name.contains(t.as_str())).count()
    };
    let (a, b) = (&found[0], &found[1]);
    let all_named = named(a) == terms.len() && named(b) < terms.len();
    let far_ahead = a.rank > 0.0 && a.rank >= b.rank * 1.5;
    if all_named || far_ahead {
        Choice::Certain(0)
    } else {
        Choice::Ask((0..found.len().min(3)).collect())
    }
}

/// "Documents → Housing → 2026" for `C:\Users\me\Documents\Housing\2026\lease.pdf` (relative to
/// the student's profile folder when it's inside it, else from the drive).
pub fn breadcrumb(path: &str, profile: Option<&str>) -> String {
    let normal = path.replace('/', "\\");
    let mut folder = normal.rsplit_once('\\').map_or("", |(f, _)| f).to_owned();
    if let Some(profile) = profile {
        let p = profile.trim_end_matches('\\').to_lowercase();
        if folder.to_lowercase().starts_with(&p) {
            folder = folder[p.len()..].trim_start_matches('\\').to_owned();
        }
    }
    let parts: Vec<&str> = folder.split('\\').filter(|s| !s.is_empty()).collect();
    let parts: Vec<&str> = if parts.len() > 4 {
        let mut short = vec![parts[0], "…"];
        short.extend_from_slice(&parts[parts.len() - 2..]);
        short
    } else {
        parts
    };
    parts.join(" → ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_can_never_change_the_query() {
        let t = terms("my lease' OR 1=1; DROP TABLE x -- %_ [a] \"PDF\"");
        for term in &t {
            assert!(
                term.chars()
                    .all(|c| c.is_alphanumeric() || "-_.".contains(c)),
                "{term}"
            );
        }
        let sql = search_sql(&t, FileKind::Pdf, Some("2026-11-01")).unwrap();
        // Only our own quotes are in the query: two per term pattern and the extension list.
        assert!(!sql.contains("1=1") && !sql.contains(';'));
        assert!(sql.contains("System.FileExtension IN ('.pdf')"));
        assert!(sql.contains(">= '2026-11-01'"));
        assert!(search_sql(&t, FileKind::Any, Some("last week"))
            .unwrap()
            .find("DateModified >=")
            .is_none());
        assert!(search_sql(&[], FileKind::Any, None).is_none());
        assert_eq!(terms("find my lease PDF"), vec!["find", "lease"]);
    }

    fn f(path: &str, rank: f64) -> Found {
        Found {
            path: path.into(),
            modified: String::new(),
            rank,
        }
    }

    #[test]
    fn asks_when_the_top_result_is_uncertain() {
        let t = vec!["lease".to_owned()];
        assert_eq!(choose(&[], &t), Choice::Nothing);
        assert_eq!(
            choose(&[f("C:\\a\\lease.pdf", 1.0)], &t),
            Choice::Certain(0)
        );
        // Two leases, similar ranks: ask.
        let two = [
            f("C:\\a\\lease 2025.pdf", 900.0),
            f("C:\\b\\lease 2026.pdf", 880.0),
            f("C:\\c\\x.pdf", 10.0),
        ];
        assert_eq!(choose(&two, &t), Choice::Ask(vec![0, 1, 2]));
        // Only the first is named for it.
        let one = [f("C:\\a\\lease.pdf", 900.0), f("C:\\b\\notes.pdf", 880.0)];
        assert_eq!(choose(&one, &t), Choice::Certain(0));
        // Far ahead.
        let ahead = [
            f("C:\\a\\x lease.pdf", 900.0),
            f("C:\\b\\y lease.pdf", 100.0),
        ];
        assert_eq!(choose(&ahead, &t), Choice::Certain(0));
    }

    #[test]
    fn breadcrumbs_read_from_the_profile() {
        assert_eq!(
            breadcrumb(
                "C:\\Users\\me\\Documents\\Housing\\2026\\lease.pdf",
                Some("C:\\Users\\me")
            ),
            "Documents → Housing → 2026"
        );
        assert_eq!(
            breadcrumb("D:\\Scans\\lease.pdf", Some("C:\\Users\\me")),
            "D: → Scans"
        );
        assert_eq!(
            breadcrumb(
                "C:\\Users\\me\\a\\b\\c\\d\\e\\f.pdf",
                Some("C:\\Users\\me\\")
            ),
            "a → … → d → e"
        );
    }

    #[test]
    fn the_helpers_output_is_checked() {
        let one = br#"{"path":"C:\\x\\a.pdf","modified":"2026-01-01","rank":3}"#;
        assert_eq!(parse_found(one).len(), 1);
        let list = "\u{feff}[{\"path\":\"C:\\\\a.pdf\"},{\"path\":\"bad\\u0007\"}]";
        assert_eq!(parse_found(list.as_bytes()).len(), 1);
        assert!(parse_found(b"").is_empty());
        assert!(parse_found(b"not json").is_empty());
        assert!(runs_something("C:\\x\\setup.EXE") && runs_something("a.lnk"));
        assert!(!runs_something("C:\\x\\lease.pdf"));
    }
}
