//! What the student meant by what they said while holding the hotkey (decision 9): fixed rules,
//! no model. "Save this", "show that again" and "check my notes" (Notes Check) are short
//! commands; anything else is a question for the tutor.
//!
//! A command must be the whole utterance, so "how do I save this file?" stays a question.

/// What to do with a held frame and the words said over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    /// Ask the tutor about the screen.
    Ask,
    /// Save the annotated part of the screen to the notebook.
    Clip,
    /// Re-place the last ink on the screen as it is now.
    Reannotate,
    /// Compare the screen with the student's notes (Notes Check); `all`: every notebook, not
    /// just the one they're working in.
    NotesCheck { all: bool },
}

/// Words that never change the meaning of a command ("please save this now").
const FILLER: &[&str] = &[
    "please", "pls", "now", "mew", "hey", "ok", "okay", "can", "could", "you", "just", "for", "me",
    "quickly",
];
const THIS: &[&str] = &["this", "that", "it", "these", "those"];
const NOTEBOOK_PLACES: &[&str] = &["notebook", "notes", "my notebook", "my notes"];

pub fn intent_of(transcript: &str) -> Intent {
    let words = normalise(transcript);
    // Commands are short; a long sentence is a question even if it mentions saving.
    if words.is_empty() || words.len() > 9 {
        return Intent::Ask;
    }
    let core: Vec<&str> = words
        .iter()
        .map(String::as_str)
        .filter(|w| !FILLER.contains(w))
        .collect();
    if is_clip(&core) {
        Intent::Clip
    } else if let Some(all) = notes_check(&core) {
        Intent::NotesCheck { all }
    } else if is_reannotate(&core) {
        Intent::Reannotate
    } else {
        Intent::Ask
    }
}

/// "save this", "clip that", "save this to my notebook", "put this in my notes", "add it to
/// notebook", "keep this".
fn is_clip(words: &[&str]) -> bool {
    let [verb, object, place @ ..] = words else {
        return false;
    };
    if !THIS.contains(object) {
        return false;
    }
    let place = place.join(" ");
    let to_notebook = |prepositions: &[&str]| {
        prepositions.iter().any(|p| {
            place
                .strip_prefix(p)
                .map(str::trim)
                .is_some_and(|where_| NOTEBOOK_PLACES.contains(&where_))
        })
    };
    match *verb {
        "save" | "clip" | "keep" | "snip" | "capture" | "grab" => {
            place.is_empty() || to_notebook(&["to", "in", "into", "on"])
        }
        "put" | "add" | "stick" => to_notebook(&["in", "into", "to", "on"]),
        _ => false,
    }
}

/// "check my notes", "does this match my notes?", "what am I missing?", "compare this with my
/// notes", "check against all my notes" (Some(true): all of them).
fn notes_check(words: &[&str]) -> Option<bool> {
    let all = words.contains(&"all");
    let text = words
        .iter()
        .filter(|w| !matches!(**w, "all" | "this" | "that" | "it" | "the" | "these"))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let asks = matches!(
        text.as_str(),
        "check my notes"
            | "check notes"
            | "check against my notes"
            | "check with my notes"
            | "check it against my notes"
            | "compare with my notes"
            | "compare to my notes"
            | "compare my notes"
            | "does match my notes"
            | "does it match my notes"
            | "do my notes match"
            | "is in my notes"
            | "what am i missing"
            | "what did i miss"
            | "what's missing from my notes"
            | "what is missing from my notes"
            | "notes check"
    );
    asks.then_some(all)
}

/// "show that again", "show me again", "where was that", "draw it again", "point to that again".
fn is_reannotate(words: &[&str]) -> bool {
    let text = words.join(" ");
    let again = text.ends_with(" again") || text == "again";
    let verb = words.first().copied().unwrap_or("");
    match verb {
        "show" | "draw" | "redraw" | "point" | "mark" | "highlight" => again || verb == "redraw",
        "where" => matches!(
            text.as_str(),
            "where was that" | "where was it" | "where was that again" | "where was it again"
        ),
        "again" => text == "again",
        _ => false,
    }
}

/// Lowercase words, without punctuation (speech-to-text adds full stops and commas).
fn normalise(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.trim_matches('\'').to_owned())
        .filter(|w| !w.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_saving() {
        for said in [
            "save this",
            "Save this.",
            "save that",
            "clip this",
            "Clip it please",
            "save this to my notebook",
            "Save this in my notes.",
            "put this in my notebook",
            "Put it into my notebook!",
            "add this to my notebook",
            "keep this",
            "Mew, save this.",
            "okay, save it now",
            "could you save this for me",
        ] {
            assert_eq!(intent_of(said), Intent::Clip, "{said}");
        }
    }

    #[test]
    fn recognises_show_again() {
        for said in [
            "show that again",
            "Show me that again.",
            "show it again",
            "where was that",
            "Where was it again?",
            "draw that again",
            "point to it again",
            "again",
            "redraw that",
        ] {
            assert_eq!(intent_of(said), Intent::Reannotate, "{said}");
        }
    }

    #[test]
    fn recognises_checking_notes() {
        for said in [
            "check my notes",
            "Check my notes.",
            "Mew, check my notes please",
            "does this match my notes?",
            "what am I missing?",
            "What did I miss",
            "compare this with my notes",
            "check this against my notes",
        ] {
            assert_eq!(intent_of(said), Intent::NotesCheck { all: false }, "{said}");
        }
        for said in [
            "check against all my notes",
            "check all my notes",
            "compare with all my notes",
        ] {
            assert_eq!(intent_of(said), Intent::NotesCheck { all: true }, "{said}");
        }
    }

    #[test]
    fn keeps_questions_as_questions() {
        for said in [
            "",
            "   ",
            "how do I save this file?",
            "what does save as do",
            "save",
            "save the world",
            "save this as a PDF",
            "put this formula in my calculator",
            "add this up for me",
            "show me how to make a chart",
            "help me with question 3",
            "what's going on in this diagram?",
            "can you explain this again, but slower, and with an example please",
            "where is the insert tab",
            "show me",
            "how do I check my notes for spelling",
            "what am I missing in this proof",
            "check my answer",
        ] {
            assert_eq!(intent_of(said), Intent::Ask, "{said:?}");
        }
    }
}
