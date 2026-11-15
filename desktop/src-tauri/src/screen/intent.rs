//! What the student meant by what they said. A model reads the words first (`ask.rs` asks
//! `POST /api/screen/intent`; decision 16), so any phrasing works; the fixed rules here are the
//! fallback when it can't be reached, and they alone decide "Neb, pause" (nothing is sent for
//! that) and the words of a quiz or Circle & Ask in progress. The rules (decisions 9 and 10): "Save this", "show that again", "check my notes" (Notes Check) and "Neb,
//! pause" (K2: pausing had a hotkey before) are short commands; "teach me how to…" starts a walkthrough (coach mode, S4) and "continue where we left
//! off" resumes one; during a walkthrough, "done", "I'm stuck", "yes", "no", "pause" and "stop"
//! steer it. Anything else is a question for the tutor.
//!
//! A command must be the whole utterance, so "how do I save this file?" stays a question.

/// The body of `POST /api/screen/intent` (packages/shared/src/screen-intent.ts): the words and
/// what Neb is doing, never the screen.
pub fn intent_body(transcript: &str, coaching: bool, has_ink: bool) -> Vec<u8> {
    serde_json::json!({
        "transcript": transcript,
        "app": null,
        "coaching": coaching,
        "hasInk": has_ink,
    })
    .to_string()
    .into_bytes()
}

/// The server's reading of the words, checked: one of the known intents, and one that fits what
/// Neb is doing (a walkthrough's replies only during one, "show that again" only with ink).
/// None for anything else: the fixed rules below decide instead.
pub fn parse_intent_reply(bytes: &[u8], coaching: bool, has_ink: bool) -> Option<Intent> {
    #[derive(serde::Deserialize)]
    struct Reply {
        intent: String,
    }
    let reply: Reply = serde_json::from_slice(bytes).ok()?;
    let word = |word: CoachWord| coaching.then_some(Intent::Coach(word));
    match reply.intent.as_str() {
        "ask" => Some(Intent::Ask),
        "write" => Some(Intent::Write),
        "act" => Some(Intent::Act),
        "clip" => Some(Intent::Clip),
        "notes_check" => Some(Intent::NotesCheck { all: false }),
        "notes_check_all" => Some(Intent::NotesCheck { all: true }),
        "coach_start" => Some(Intent::CoachStart),
        "coach_resume" => Some(Intent::CoachResume),
        "coach_recheck" => Some(Intent::CoachRecheck),
        "quiz" => Some(Intent::Quiz),
        "reannotate" => has_ink.then_some(Intent::Reannotate),
        "pause" => Some(Intent::Pause),
        "coach_done" => word(CoachWord::Done),
        "coach_stuck" => word(CoachWord::Stuck),
        "coach_yes" => word(CoachWord::Yes),
        "coach_no" => word(CoachWord::No),
        "coach_pause" => word(CoachWord::Pause),
        "coach_stop" => word(CoachWord::Stop),
        _ => None,
    }
}

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
    /// S5: re-check a skill learned before, solo ("let me try pivot tables on my own").
    CoachRecheck,
    /// S6: questions about what's on the screen ("quiz me on this").
    Quiz,
    /// Type into the document in front ("rewrite this sentence", "type a conclusion", "fix the
    /// grammar"): Neb writes the text and types it at the cursor (`screen_write.rs`).
    Write,
    /// Do something on the screen with Neb's own cursor ("open the Insert tab", "click that for
    /// me", "scroll down"): `screen_hand.rs`.
    Act,
    /// A word for the walkthrough in progress.
    Coach(CoachWord),
    /// Pause Screen Coach ("Neb, pause"; during a walkthrough, "pause" pauses the walkthrough).
    Pause,
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
    "please", "pls", "now", "neb", "mew", "hey", "ok", "okay", "can", "could", "you", "just",
    "for", "me", "quickly",
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
    if is_recheck(&words) {
        return Intent::CoachRecheck;
    }
    if is_quiz(&words) {
        return Intent::Quiz;
    }
    if is_write(&words) {
        return Intent::Write;
    }
    if is_act(&words) {
        return Intent::Act;
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
    if is_pause(&core) {
        Intent::Pause
    } else if is_clip(&core) {
        Intent::Clip
    } else if let Some(all) = notes_check(&core) {
        Intent::NotesCheck { all }
    } else if is_reannotate(&core) {
        Intent::Reannotate
    } else {
        Intent::Ask
    }
}

/// "pause", "pause screen coach", "stop looking", "stop watching my screen" ("Neb, pause": the
/// name is filler).
fn is_pause(words: &[&str]) -> bool {
    matches!(
        words.join(" ").as_str(),
        "pause"
            | "pause yourself"
            | "pause screen coach"
            | "pause the screen coach"
            | "pause neb"
            | "stop looking"
            | "stop watching"
            | "stop looking at my screen"
            | "stop watching my screen"
            | "dont look at my screen"
            | "don't look at my screen"
    )
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

/// Polite words before a request ("hey Neb, can you teach me…"; Mew is the app's old name).
const LEAD_IN: &[&str] = &[
    "hey", "neb", "mew", "ok", "okay", "please", "so", "can", "could", "would", "will", "you",
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

/// The words after any polite lead-in ("hey Neb, can you…"), joined, without apostrophes.
fn after_lead_in(words: &[String]) -> String {
    let start = words
        .iter()
        .position(|w| !LEAD_IN.contains(&w.as_str()))
        .unwrap_or(words.len());
    plain(
        &words[start..]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
    )
}

/// S5: "let me try pivot tables on my own", "can I try it myself", "I want to do it solo",
/// "re-check my skills": a solo re-check of something learned before.
fn is_recheck(words: &[String]) -> bool {
    let text = after_lead_in(words);
    if words.len() > 16 {
        return false;
    }
    if matches!(
        text.as_str(),
        "recheck" | "re check" | "recheck my skills" | "re check my skills" | "test my skills"
    ) {
        return true;
    }
    let tries = [
        "let me try",
        "i try",
        "i want to try",
        "ill try",
        "let me do",
        "i want to do",
    ]
    .iter()
    .any(|p| text.starts_with(p));
    let alone = [
        " on my own",
        " myself",
        " solo",
        " without you",
        " without help",
        " alone",
        " by myself",
    ]
    .iter()
    .any(|w| text.ends_with(w) || text.contains(&format!("{w} ")));
    tries && alone
}

/// S6: "quiz me on this", "test me on this page", "ask me questions about this", "make me a
/// quiz": questions about what's on the screen.
fn is_quiz(words: &[String]) -> bool {
    let text = after_lead_in(words);
    if words.len() > 12 {
        return false;
    }
    let about_this = |rest: &str| {
        rest.is_empty()
            || matches!(
                rest,
                "this"
                    | "that"
                    | "it"
                    | "this page"
                    | "this one"
                    | "these"
                    | "what im looking at"
                    | "whats on my screen"
                    | "whats on screen"
                    | "my screen"
                    | "the screen"
            )
    };
    for prefix in [
        "quiz me on ",
        "test me on ",
        "ask me questions about ",
        "ask me about ",
        "quiz me about ",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return about_this(rest.trim());
        }
    }
    matches!(
        text.as_str(),
        "quiz me" | "make me a quiz" | "give me a quiz" | "quiz me please" | "test me"
    )
}

/// Typing into a document: a request that starts by asking Neb to type, write, rewrite or fix
/// something there ("type a conclusion", "rewrite this sentence", "can you fix the grammar in
/// this paragraph", "suggest a better opening line", "make this more formal", "finish this
/// sentence"). A question about writing ("how do I write a thesis?") stays a question.
fn is_write(words: &[String]) -> bool {
    if words.len() > MAX_GOAL_WORDS {
        return false;
    }
    let text = after_lead_in(words);
    let text = text.as_str();
    let rest_of = |prefix: &str| text.strip_prefix(prefix).map(str::trim);
    // "Type …" always means typing ("type that for me", "type a summary here").
    if rest_of("type ").is_some_and(|rest| !rest.is_empty()) {
        return true;
    }
    // Changing text: "rewrite this", "reword the second sentence", "proofread my paragraph".
    const EDIT: &[&str] = &[
        "rewrite ",
        "reword ",
        "rephrase ",
        "paraphrase ",
        "shorten ",
        "proofread ",
        "polish ",
        "tidy up ",
        "clean up ",
        "edit ",
        "improve ",
        "translate ",
        "simplify ",
        "summarise ",
        "summarize ",
    ];
    const OBJECT: &[&str] = &[
        "this", "that", "it", "the", "my", "these", "those", "what", "his", "her", "our",
    ];
    let has_object = |rest: &str| {
        rest.split_whitespace()
            .next()
            .is_some_and(|first| OBJECT.contains(&first))
    };
    if EDIT
        .iter()
        .any(|verb| rest_of(verb).is_some_and(has_object))
    {
        return true;
    }
    // The verb alone, with the text selected: "rewrite", "proofread".
    if matches!(
        text,
        "rewrite" | "reword" | "rephrase" | "paraphrase" | "proofread"
    ) {
        return true;
    }
    // "Fix the grammar", "fix my spelling", "correct this paragraph".
    const FIXABLE: &[&str] = &[
        "grammar",
        "spelling",
        "punctuation",
        "typo",
        "typos",
        "sentence",
        "sentences",
        "paragraph",
        "paragraphs",
        "wording",
        "essay",
        "intro",
        "introduction",
        "conclusion",
        "email",
        "text",
        "writing",
    ];
    for verb in ["fix ", "correct "] {
        if let Some(rest) = rest_of(verb) {
            if rest.split_whitespace().any(|w| FIXABLE.contains(&w)) {
                return true;
            }
        }
    }
    // "Write a conclusion", "write me an intro", "write the next sentence".
    if let Some(rest) = rest_of("write ") {
        let first = rest.split_whitespace().next().unwrap_or("");
        if matches!(
            first,
            "a" | "an"
                | "me"
                | "the"
                | "some"
                | "down"
                | "this"
                | "that"
                | "it"
                | "about"
                | "something"
                | "my"
                | "one"
                | "two"
                | "three"
                | "four"
                | "five"
                | "ten"
        ) || first.starts_with(|c: char| c.is_ascii_digit())
        {
            return true;
        }
    }
    // "Suggest a better word", "suggest some edits", "suggest changes to this paragraph".
    if let Some(rest) = rest_of("suggest ") {
        let first = rest.split_whitespace().next().unwrap_or("");
        if matches!(
            first,
            "a" | "an" | "some" | "better" | "changes" | "edits" | "improvements" | "another"
        ) {
            return true;
        }
    }
    // "Make this more formal", "make it shorter", "make changes to this".
    if let Some(rest) = rest_of("make ") {
        let mut it = rest.split_whitespace();
        let (first, second) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        if matches!(first, "this" | "that" | "it" | "my" | "the") && !second.is_empty() {
            return true;
        }
        if matches!(first, "changes" | "edits" | "suggestions") {
            return true;
        }
    }
    // "Finish this sentence", "continue my paragraph", "complete the list", "add a conclusion".
    for verb in ["finish ", "continue ", "complete ", "add "] {
        if let Some(rest) = rest_of(verb) {
            let mut it = rest.split_whitespace();
            let first = it.next().unwrap_or("");
            let second = it.next().unwrap_or("");
            let doc_word = |w: &str| {
                FIXABLE.contains(&w)
                    || matches!(
                        w,
                        "line" | "list" | "title" | "heading" | "point" | "bullet" | "summary"
                    )
            };
            if matches!(first, "this" | "my" | "the" | "a" | "an" | "another") && doc_word(second) {
                return true;
            }
            if verb == "continue " && first == "writing" {
                return true;
            }
        }
    }
    false
}

/// Doing something on the screen for them: a request that starts by telling Neb to click,
/// press or scroll ("click the Insert tab", "press the next button", "scroll down a bit"), or
/// to do the thing for them ("do it for me", "click that for me"). Anything put another way is
/// read by the model (`ask.rs`). "Where do I click?" stays a question.
fn is_act(words: &[String]) -> bool {
    if words.len() > MAX_GOAL_WORDS {
        return false;
    }
    let text = after_lead_in(words);
    let text = text.as_str();
    if matches!(
        text,
        "do it for me"
            | "do that for me"
            | "do this for me"
            | "do it"
            | "click it"
            | "click that"
            | "click it for me"
            | "click that for me"
            | "scroll down"
            | "scroll up"
    ) {
        return true;
    }
    [
        "click on ",
        "click the ",
        "press the ",
        "scroll down ",
        "scroll up ",
        "scroll to ",
    ]
    .iter()
    .any(|start| {
        text.strip_prefix(start)
            .is_some_and(|rest| !rest.is_empty())
    })
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
            "Neb, save this.",
            "Mew, save this.",
            "okay, save it now",
            "could you save this for me",
        ] {
            assert_eq!(intent_of(said, false), Intent::Clip, "{said}");
        }
    }

    #[test]
    fn recognises_pausing_screen_coach() {
        for said in [
            "Neb, pause.",
            "pause",
            "Hey Neb, pause please",
            "pause Screen Coach",
            "stop looking at my screen",
            "Stop watching.",
        ] {
            assert_eq!(intent_of(said, false), Intent::Pause, "{said}");
        }
        // In a walkthrough "pause" pauses the walkthrough; naming Screen Coach still pauses it.
        assert_eq!(intent_of("pause", true), Intent::Coach(CoachWord::Pause));
        assert_eq!(intent_of("pause screen coach", true), Intent::Pause);
        for said in [
            "pause this video",
            "how do I pause the music",
            "why did it pause",
        ] {
            assert_eq!(intent_of(said, false), Intent::Ask, "{said}");
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
            "Neb, check my notes please",
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
    fn recognises_a_solo_recheck() {
        for said in [
            "let me try pivot tables on my own",
            "Neb, let me try it myself.",
            "can I try it myself?",
            "I want to do the chart by myself",
            "I'll try it without help",
            "recheck my skills",
            "test my skills",
        ] {
            assert_eq!(intent_of(said, false), Intent::CoachRecheck, "{said}");
        }
        for said in [
            "let me try again",
            "I tried it myself and it broke, why?",
            "teach me how to make a pivot table",
        ] {
            assert_ne!(intent_of(said, false), Intent::CoachRecheck, "{said}");
        }
    }

    #[test]
    fn recognises_quiz_me_on_this() {
        for said in [
            "quiz me on this",
            "Neb, quiz me on this page.",
            "test me on this",
            "ask me questions about what I'm looking at",
            "make me a quiz",
            "quiz me please",
        ] {
            assert_eq!(intent_of(said, false), Intent::Quiz, "{said}");
        }
        for said in [
            // K8's "quiz me on what I saved" is the notebook's, not the screen's.
            "quiz me on what I saved today",
            "what's a quiz?",
            "test me on the french revolution chapter from last week please",
        ] {
            assert_ne!(intent_of(said, false), Intent::Quiz, "{said}");
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
            "Hey Neb, can you teach me how to make a chart?",
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
            "Neb, let's continue",
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
        // Coach words mean nothing outside a walkthrough ("pause" pauses Screen Coach instead).
        for said in ["done", "I'm stuck", "yes", "stop"] {
            assert_eq!(intent_of(said, false), Intent::Ask, "{said}");
        }
    }

    #[test]
    fn asks_neb_to_do_it_with_its_own_cursor() {
        for said in [
            "Click the Insert tab.",
            "hey neb, click on File",
            "press the next button",
            "scroll down",
            "Scroll down to the references",
            "do it for me",
            "can you click that for me",
        ] {
            assert_eq!(intent_of(said, false), Intent::Act, "{said}");
        }
        // Asking where or how is still a question.
        for said in [
            "where do I click?",
            "which button do I press",
            "how do I scroll to the end?",
            "what does clicking this do",
        ] {
            assert_eq!(intent_of(said, false), Intent::Ask, "{said}");
        }
        let act = serde_json::json!({ "intent": "act" }).to_string();
        assert_eq!(
            parse_intent_reply(act.as_bytes(), false, false),
            Some(Intent::Act)
        );
    }

    #[test]
    fn takes_the_servers_reading_only_when_it_fits() {
        let read = |intent: &str, coaching, has_ink| {
            let body = serde_json::json!({ "intent": intent }).to_string();
            parse_intent_reply(body.as_bytes(), coaching, has_ink)
        };
        assert_eq!(read("write", false, false), Some(Intent::Write));
        assert_eq!(read("ask", false, false), Some(Intent::Ask));
        assert_eq!(
            read("notes_check_all", false, false),
            Some(Intent::NotesCheck { all: true })
        );
        // A walkthrough's reply means nothing without one; ink can't be shown again without ink.
        assert_eq!(read("coach_done", false, false), None);
        assert_eq!(
            read("coach_done", true, false),
            Some(Intent::Coach(CoachWord::Done))
        );
        assert_eq!(read("reannotate", false, false), None);
        assert_eq!(read("reannotate", false, true), Some(Intent::Reannotate));
        // Anything else is refused, so the fixed rules decide.
        assert_eq!(read("format_disk", false, false), None);
        assert_eq!(parse_intent_reply(b"not json", false, false), None);
        let body: serde_json::Value =
            serde_json::from_slice(&intent_body("rewrite", true, false)).unwrap();
        assert_eq!(body["transcript"], "rewrite");
        assert_eq!(body["coaching"], true);
        assert_eq!(body["hasInk"], false);
    }

    #[test]
    fn asks_to_type_into_a_document() {
        for said in [
            "Type a conclusion for this essay.",
            "Neb, can you rewrite this sentence so it's shorter?",
            "reword the second paragraph",
            "Fix the grammar in this paragraph.",
            "please fix my spelling",
            "Write a title for this.",
            "write me an intro",
            "Suggest a better opening line.",
            "make this more formal",
            "Finish this sentence.",
            "add a conclusion",
            "continue writing",
            "translate this into French",
            "rewrite",
            "Rewrite.",
            "hey write a conclusion",
            "write a 100 word essay on cats",
            "write 100 words about cats",
            "write about my weekend",
        ] {
            assert_eq!(intent_of(said, false), Intent::Write, "{said}");
        }
    }

    #[test]
    fn questions_about_writing_stay_questions() {
        for said in [
            "how do I write a thesis statement?",
            "what does this paragraph mean",
            "is my grammar right here?",
            "why is this sentence wrong",
            "fix this",
            "can you explain how to fix this error",
            "suggest how I should start",
            "what should I write next?",
        ] {
            assert_eq!(intent_of(said, false), Intent::Ask, "{said}");
        }
    }
}
