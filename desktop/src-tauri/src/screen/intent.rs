//! What the student meant by what they said while holding the hotkey (decisions 9 and 10): fixed
//! rules, no model. "Save this", "show that again" and "check my notes" (Notes Check) are short
//! commands; "teach me how to…" starts a walkthrough (coach mode, S4) and "continue where we left
//! off" resumes one; during a walkthrough, "done", "I'm stuck", "yes", "no", "pause" and "stop"
//! steer it. Anything else is a question for the tutor.
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
    /// Start a walkthrough of the task in the words ("teach me how to make a pivot table").
    CoachStart,
    /// Continue the latest unfinished walkthrough ("continue where we left off").
    CoachResume,
    /// A word for the walkthrough in progress.
    Coach(CoachWord),
}

/// What the student can say to a walkthrough in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoachWord {
    /// "Done", "okay", "next", or just the hotkey: check the step.
    Done,
    /// "I'm stuck", "what now", "hint": help (the step is checked first).
    Stuck,
    /// "Yes", when asked whether the step is done.
    Yes,
    /// "No", when asked whether the step is done.
    No,
    Pause,
    Stop,
}

/// Words that never change the meaning of a command ("please save this now").
const FILLER: &[&str] = &[
    "please", "pls", "now", "mew", "hey", "ok", "okay", "can", "could", "you", "just", "for", "me",
    "quickly",
];
const THIS: &[&str] = &["this", "that", "it", "these", "those"];
const NOTEBOOK_PLACES: &[&str] = &["notebook", "notes", "my notebook", "my notes"];

/// What the words mean; `coaching`: a walkthrough is in progress (its words are checked first).
pub fn intent_of(transcript: &str, coaching: bool) -> Intent {
    let words = normalise(transcript);
    if coaching {
        if let Some(word) = coach_word(&words) {
            return Intent::Coach(word);
        }
    }
    if is_coach_start(&words) {
        return Intent::CoachStart;
    }
    // Commands are short; a long sentence is a question even if it mentions saving.
    if words.is_empty() || words.len() > 9 {
        return Intent::Ask;
    }
    if is_resume(&words) {
        return Intent::CoachResume;
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

// ─── Coach mode (S4) ─────────────────────────────────────────────────────────────────────────

/// Polite words before a request ("hey Mew, can you teach me…").
const LEAD_IN: &[&str] = &[
    "hey", "mew", "ok", "okay", "please", "so", "can", "could", "would", "will", "you",
];
/// How a walkthrough is asked for; the task follows.
const START_PREFIXES: &[&str] = &[
    "teach me how to ",
    "teach me how ",
    "teach me to ",
    "walk me through ",
    "guide me through ",
    "coach me through ",
    "coach me on ",
    "show me step by step how to ",
];
/// A walkthrough's goal may be a long sentence, but not a paragraph.
const MAX_GOAL_WORDS: usize = 40;

/// "Teach me how to make a pivot table", "can you walk me through adding a header", "how do I
/// make a chart, step by step".
fn is_coach_start(words: &[String]) -> bool {
    let start = words
        .iter()
        .position(|w| !LEAD_IN.contains(&w.as_str()))
        .unwrap_or(words.len());
    let rest = &words[start..];
    if rest.len() > MAX_GOAL_WORDS {
        return false;
    }
    let text = rest.join(" ");
    let prefixed = START_PREFIXES.iter().any(|prefix| {
        text.strip_prefix(prefix)
            .is_some_and(|task| !task.trim().is_empty())
    });
    let step_by_step = text.ends_with(" step by step")
        && ["how do i ", "how to ", "show me how to ", "help me "]
            .iter()
            .any(|p| text.starts_with(p));
    prefixed || step_by_step
}

/// "Continue where we left off", "resume", "keep going".
fn is_resume(words: &[String]) -> bool {
    matches!(
        plain(&without_filler(words)).as_str(),
        "continue"
            | "resume"
            | "carry on"
            | "keep going"
            | "lets continue"
            | "lets keep going"
            | "continue where we left off"
            | "continue where i left off"
            | "pick up where we left off"
            | "pick up where i left off"
            | "where were we"
            | "resume coaching"
            | "continue coaching"
            | "continue the walkthrough"
            | "resume the walkthrough"
    )
}

/// A word to the walkthrough in progress; None for anything else (a question, say).
fn coach_word(words: &[String]) -> Option<CoachWord> {
    let text = plain(&without_filler(words));
    // Nothing but the hotkey (or "okay"): check the step (brief §2.2).
    if text.is_empty() {
        return Some(CoachWord::Done);
    }
    let word =
        match text.as_str() {
            "done" | "im done" | "i am done" | "all done" | "did it" | "i did it"
            | "ive done it" | "i have done it" | "finished" | "im finished" | "next"
            | "next step" | "got it" | "ready" | "thats done" | "its done" | "check"
            | "check it" | "check this" | "check that" | "there" | "go on" | "yes done"
            | "yes its done" | "yes i did" => CoachWord::Done,
            // "now" is filler: "what now" and "now what" arrive as "what".
            "im stuck"
            | "i am stuck"
            | "stuck"
            | "what"
            | "what do i do"
            | "what should i do"
            | "i dont know what to do"
            | "whats next"
            | "what next"
            | "hint"
            | "a hint"
            | "give a hint"
            | "hint please"
            | "help"
            | "help me"
            | "i need help"
            | "i dont know"
            | "i cant find it"
            | "i cant see it"
            | "i dont see it"
            | "where"
            | "where is it"
            | "wheres that"
            | "show"
            | "show it"
            | "im lost"
            | "i dont get it" => CoachWord::Stuck,
            "yes" | "yeah" | "yep" | "yup" | "it is" | "yes it is" | "its there" | "correct"
            | "right" | "uh huh" | "sure" => CoachWord::Yes,
            "no" | "nope" | "not yet" | "it isnt" | "its not" | "no its not" | "no it isnt"
            | "no not yet" | "not really" => CoachWord::No,
            "pause" | "pause it" | "pause this" | "pause coaching" | "wait" | "hold on"
            | "hang on" | "one moment" | "one sec" | "one second" | "give a minute"
            | "give a second" => CoachWord::Pause,
            "stop"
            | "stop it"
            | "stop this"
            | "stop coaching"
            | "stop the walkthrough"
            | "cancel"
            | "quit"
            | "exit"
            | "end"
            | "end it"
            | "thats enough"
            | "never mind"
            | "nevermind" => CoachWord::Stop,
            _ => return None,
        };
    Some(word)
}

fn without_filler(words: &[String]) -> Vec<&str> {
    words
        .iter()
        .map(String::as_str)
        .filter(|w| !FILLER.contains(w))
        .collect()
}

/// Words joined, without apostrophes ("I'm" and "Im" both become "im").
fn plain(words: &[&str]) -> String {
    words.join(" ").replace('\'', "")
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
            assert_eq!(intent_of(said, false), Intent::Clip, "{said}");
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
            assert_eq!(intent_of(said, false), Intent::Reannotate, "{said}");
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
            assert_eq!(
                intent_of(said, false),
                Intent::NotesCheck { all: false },
                "{said}"
            );
        }
        for said in [
            "check against all my notes",
            "check all my notes",
            "compare with all my notes",
        ] {
            assert_eq!(
                intent_of(said, false),
                Intent::NotesCheck { all: true },
                "{said}"
            );
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
            assert_eq!(intent_of(said, false), Intent::Ask, "{said:?}");
        }
    }

    #[test]
    fn recognises_asking_for_a_walkthrough() {
        for said in [
            "Teach me how to make a pivot table.",
            "teach me to add a header in Word",
            "Hey Mew, can you teach me how to make a chart?",
            "walk me through making a pivot table",
            "Could you guide me through adding page numbers",
            "coach me through this export",
            "how do I make a chart step by step",
            "show me step by step how to sort this column",
        ] {
            assert_eq!(intent_of(said, false), Intent::CoachStart, "{said}");
            // A new goal during a walkthrough starts a new one.
            assert_eq!(intent_of(said, true), Intent::CoachStart, "{said}");
        }
        for said in [
            "teach me",
            "teach me what this means",
            "show me how to make a chart",
            "how do I make a chart?",
            "walk me through",
        ] {
            assert_ne!(intent_of(said, false), Intent::CoachStart, "{said}");
        }
    }

    #[test]
    fn recognises_resuming() {
        for said in [
            "continue where we left off",
            "Continue where we left off.",
            "Mew, let's continue",
            "keep going",
            "resume",
            "pick up where I left off please",
        ] {
            assert_eq!(intent_of(said, false), Intent::CoachResume, "{said}");
            assert_eq!(intent_of(said, true), Intent::CoachResume, "{said}");
        }
    }

    #[test]
    fn steers_a_walkthrough_in_progress() {
        let coach = |said: &str| intent_of(said, true);
        for said in [
            "", "  ", "done", "Done!", "okay", "OK.", "I'm done", "Im done", "next", "I did it",
            "check it",
        ] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::Done), "{said:?}");
        }
        for said in [
            "I'm stuck",
            "what now?",
            "Now what",
            "give me a hint",
            "help",
            "Where is it?",
            "I can't find it",
            "show me",
        ] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::Stuck), "{said}");
        }
        for said in ["yes", "Yeah.", "yep", "it is"] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::Yes), "{said}");
        }
        for said in ["no", "Not yet.", "nope", "no, it's not"] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::No), "{said}");
        }
        for said in ["pause", "hold on", "give me a minute"] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::Pause), "{said}");
        }
        for said in [
            "stop",
            "Stop coaching.",
            "cancel",
            "never mind",
            "that's enough",
        ] {
            assert_eq!(coach(said), Intent::Coach(CoachWord::Stop), "{said}");
        }
    }

    #[test]
    fn keeps_other_commands_and_questions_during_a_walkthrough() {
        let coach = |said: &str| intent_of(said, true);
        assert_eq!(coach("save this"), Intent::Clip);
        assert_eq!(coach("check my notes"), Intent::NotesCheck { all: false });
        assert_eq!(coach("show that again"), Intent::Reannotate);
        for said in [
            "what's a pivot table?",
            "why do I need to select the data first",
            "help me with question 3",
            "is it done?",
            "stop the music",
        ] {
            assert_eq!(coach(said), Intent::Ask, "{said}");
        }
        // Coach words mean nothing outside a walkthrough.
        for said in ["done", "I'm stuck", "yes", "stop", "pause"] {
            assert_eq!(intent_of(said, false), Intent::Ask, "{said}");
        }
    }
}
