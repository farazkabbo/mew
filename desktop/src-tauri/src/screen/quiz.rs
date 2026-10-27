//! "Quiz me on this" on the desktop (Screen Coach S6, docs/SCREEN_COACH.md §2.5): what is sent to
//! the web app's server, what comes back (checked here before anything is said or shown), the
//! quiz in progress, what the student's words mean during it, and what the quiz card shows.
//! Pure: no I/O, fully tested. Mirrors `ScreenQuizRequest`, `ScreenQuizReply` and the answer
//! types in packages/shared/src/screen-quiz.ts.
//!
//! The questions' keys never come here: an answer goes to the server, which grades it.

use serde::{Deserialize, Serialize};

use super::frame::FrameMeta;
use super::protocol::{is_uuid, scope_name, with_image, within, SPEECH_CHARS};
use super::secret::SecretBytes;

pub const MAX_QUESTIONS: usize = 3;
const PROMPT_CHARS: usize = 300;
const CHOICE_CHARS: usize = 120;
const MAX_CHOICES: usize = 4;
/// An answer, as typed or said (the server's limit).
pub const ANSWER_CHARS: usize = 500;
/// The window title kept with the cards (the server's limit).
const TITLE_CHARS: usize = 200;
/// The quiz card's size, in CSS pixels.
pub const CARD_SIZE: (f64, f64) = (440.0, 264.0);

// ─── Requests and replies ────────────────────────────────────────────────────────────────────

/// `POST /api/screen/quiz`: the screen, its app and (when it holds nothing sensitive) the
/// window's title, kept with the cards so the review can say where they came from.
pub fn quiz_body(meta: &FrameMeta, title: Option<&str>, jpeg: &[u8]) -> SecretBytes {
    #[derive(Serialize)]
    struct Head<'a> {
        app: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        scope: &'static str,
    }
    let title = title
        .map(|t| {
            t.chars()
                .filter(|c| !c.is_control())
                .take(TITLE_CHARS)
                .collect::<String>()
        })
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let head = Head {
        app: meta.app.as_deref(),
        title,
        scope: scope_name(meta.kind),
    };
    with_image(&head, jpeg, meta.width, meta.height)
}

/// `POST /api/screen/quiz/answer`.
pub fn answer_body(check_id: &str, answer: &str) -> Vec<u8> {
    let answer: String = answer
        .chars()
        .filter(|c| !c.is_control())
        .take(ANSWER_CHARS)
        .collect();
    serde_json::to_vec(&serde_json::json!({ "checkId": check_id, "answer": answer.trim() }))
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Short,
    Mcq,
    Work,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub check_id: String,
    pub prompt: String,
    pub kind: QuestionKind,
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuizReply {
    pub speech: String,
    pub questions: Vec<Question>,
}

/// The server's questions, if they're well formed: ids, short plain texts, choices only (2–4)
/// for a multiple choice.
pub fn parse_quiz_reply(body: &[u8]) -> Option<QuizReply> {
    let reply: QuizReply = serde_json::from_slice(body).ok()?;
    let questions_ok = reply.questions.len() <= MAX_QUESTIONS
        && reply.questions.iter().all(|q| {
            let choices_ok = match q.kind {
                QuestionKind::Mcq => (2..=MAX_CHOICES).contains(&q.choices.len()),
                _ => q.choices.is_empty(),
            };
            is_uuid(&q.check_id)
                && within(&q.prompt, PROMPT_CHARS)
                && choices_ok
                && q.choices.iter().all(|c| within(c, CHOICE_CHARS))
        });
    (questions_ok && within(&reply.speech, SPEECH_CHARS)).then_some(reply)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AnswerReply {
    pub correct: bool,
    pub speech: String,
}

pub fn parse_answer_reply(body: &[u8]) -> Option<AnswerReply> {
    let reply: AnswerReply = serde_json::from_slice(body).ok()?;
    within(&reply.speech, SPEECH_CHARS).then_some(reply)
}

// ─── The quiz in progress ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// The question is asked: waiting for an answer.
    Asking,
    /// An answer is being graded.
    Checking,
    /// Graded: what was said back.
    Answered { correct: bool, said: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quiz {
    questions: Vec<Question>,
    index: usize,
    pub phase: Phase,
    right: usize,
    answered: usize,
}

impl Quiz {
    /// A quiz of `questions`, or None when there are none.
    pub fn new(questions: Vec<Question>) -> Option<Self> {
        (!questions.is_empty()).then_some(Self {
            questions,
            index: 0,
            phase: Phase::Asking,
            right: 0,
            answered: 0,
        })
    }

    pub fn current(&self) -> Option<&Question> {
        self.questions.get(self.index)
    }

    /// The grade of the current question's answer.
    pub fn graded(&mut self, correct: bool, said: String) {
        self.answered += 1;
        self.right += usize::from(correct);
        self.phase = Phase::Answered { correct, said };
    }

    /// On to the next question; false when that was the last.
    pub fn advance(&mut self) -> bool {
        self.index += 1;
        self.phase = Phase::Asking;
        self.index < self.questions.len()
    }

    /// What's said when it ends.
    pub fn closing_line(&self) -> String {
        let total = self.questions.len();
        let review = if total == 1 {
            "It comes back in your review."
        } else {
            "They come back in your review."
        };
        if self.answered == 0 {
            return format!("Okay. {review}");
        }
        format!(
            "That's the quiz: {} of {} right. {review}",
            self.right, self.answered
        )
    }

    /// What the quiz card shows (its page lays it out, `quiz-card.ts`).
    pub fn view(&self) -> CardView<'_> {
        let question = self.current();
        let (phase, correct, said) = match &self.phase {
            Phase::Asking => ("asking", None, None),
            Phase::Checking => ("checking", None, None),
            Phase::Answered { correct, said } => ("answered", Some(*correct), Some(said.as_str())),
        };
        CardView {
            step: self.index + 1,
            total: self.questions.len(),
            prompt: question.map_or("", |q| q.prompt.as_str()),
            kind: question.map_or(QuestionKind::Short, |q| q.kind),
            choices: question.map_or(&[], |q| q.choices.as_slice()),
            phase,
            correct,
            said,
            last: self.index + 1 >= self.questions.len(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CardView<'a> {
    pub step: usize,
    pub total: usize,
    pub prompt: &'a str,
    pub kind: QuestionKind,
    pub choices: &'a [String],
    pub phase: &'static str,
    pub correct: Option<bool>,
    pub said: Option<&'a str>,
    /// The last question: "Finish" instead of "Next".
    pub last: bool,
}

// ─── Words during a quiz ─────────────────────────────────────────────────────────────────────

/// What the student's words over the hotkey mean while a quiz is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuizWord {
    Stop,
    /// Skip this question (or, once it's graded, go on).
    Next,
    Answer(String),
    /// Nothing said.
    Nothing,
}

fn normalized(text: &str) -> String {
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
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn word_of(transcript: &str, question: Option<&Question>) -> QuizWord {
    let text = normalized(transcript);
    let text = text
        .strip_prefix("neb ")
        .or_else(|| text.strip_prefix("hey neb "))
        .unwrap_or(&text);
    match text {
        "" => QuizWord::Nothing,
        "stop" | "stop the quiz" | "stop quiz" | "end the quiz" | "end quiz" | "quit"
        | "cancel" | "that's enough" | "enough" => QuizWord::Stop,
        "skip" | "skip it" | "skip this" | "skip this one" | "pass" | "next" | "next question"
        | "next one" | "go on" | "continue" | "move on" => QuizWord::Next,
        _ => {
            let choice = question
                .filter(|q| q.kind == QuestionKind::Mcq)
                .and_then(|q| choice_for(text, &q.choices).and_then(|i| q.choices.get(i)));
            QuizWord::Answer(
                choice
                    .cloned()
                    .unwrap_or_else(|| transcript.trim().to_owned()),
            )
        }
    }
}

/// The choice the words pick: its letter ("b", "option b"), its place ("the second one", "2"),
/// or its text.
pub fn choice_for(words: &str, choices: &[String]) -> Option<usize> {
    let text = normalized(words);
    let text = ["it's ", "its ", "i think ", "the answer is ", "answer "]
        .iter()
        .fold(text.as_str(), |t, prefix| {
            t.strip_prefix(prefix).unwrap_or(t)
        })
        .trim();
    let text = text
        .strip_prefix("option ")
        .or_else(|| text.strip_prefix("letter "))
        .or_else(|| text.strip_prefix("choice "))
        .unwrap_or(text);
    const ORDINALS: [&[&str]; 4] = [
        &["a", "1", "one", "first", "the first", "the first one"],
        &["b", "2", "two", "second", "the second", "the second one"],
        &["c", "3", "three", "third", "the third", "the third one"],
        &["d", "4", "four", "fourth", "the fourth", "the fourth one"],
    ];
    if let Some(index) = ORDINALS.iter().position(|names| names.contains(&text)) {
        return (index < choices.len()).then_some(index);
    }
    choices.iter().position(|c| normalized(c) == text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::frame::{ScreenRect, TargetKind, Timings};

    const ID: &str = "00000000-0000-4000-8000-000000000001";

    fn question(kind: QuestionKind, choices: &[&str]) -> Question {
        Question {
            check_id: ID.into(),
            prompt: "What is the horizontal acceleration of a projectile?".into(),
            kind,
            choices: choices.iter().map(|c| (*c).to_owned()).collect(),
        }
    }

    fn meta() -> FrameMeta {
        let rect = ScreenRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        };
        FrameMeta {
            kind: TargetKind::Window,
            app: Some("chrome.exe".into()),
            bounds: rect,
            monitor: rect,
            dpi: 96,
            width: 800,
            height: 600,
            timings: Timings::default(),
            video_playing: None,
            window: None,
        }
    }

    #[test]
    fn sends_the_screen_with_its_title() {
        let body = quiz_body(&meta(), Some("Lecture 5\n - YouTube"), &[0xff, 0xd8]);
        let json: serde_json::Value = serde_json::from_slice(body.as_slice()).unwrap();
        assert_eq!(json["app"], "chrome.exe");
        assert_eq!(json["title"], "Lecture 5 - YouTube");
        assert_eq!(json["scope"], "window");
        assert_eq!(json["image"]["width"], 800);
        let untitled = quiz_body(&meta(), Some("  "), &[0xff]);
        let json: serde_json::Value = serde_json::from_slice(untitled.as_slice()).unwrap();
        assert!(json.get("title").is_none());
    }

    #[test]
    fn checks_the_questions_before_asking_them() {
        let good = serde_json::json!({
            "speech": "Two questions on projectile motion.",
            "questions": [
                question(QuestionKind::Short, &[]),
                question(QuestionKind::Mcq, &["0", "9.8 m/s²"]),
            ],
        });
        let reply = parse_quiz_reply(good.to_string().as_bytes()).unwrap();
        assert_eq!(reply.questions.len(), 2);

        let mut bad_id = good.clone();
        bad_id["questions"][0]["checkId"] = "nope".into();
        assert!(parse_quiz_reply(bad_id.to_string().as_bytes()).is_none());
        let mut one_choice = good.clone();
        one_choice["questions"][1]["choices"] = serde_json::json!(["0"]);
        assert!(parse_quiz_reply(one_choice.to_string().as_bytes()).is_none());
        let mut control = good.clone();
        control["questions"][0]["prompt"] = "Why?\u{7}".into();
        assert!(parse_quiz_reply(control.to_string().as_bytes()).is_none());
        let four = serde_json::json!({
            "speech": "Four.",
            "questions": vec![question(QuestionKind::Short, &[]); 4],
        });
        assert!(parse_quiz_reply(four.to_string().as_bytes()).is_none());
        let none = serde_json::json!({ "speech": "Nothing to quiz on here.", "questions": [] });
        assert!(parse_quiz_reply(none.to_string().as_bytes()).is_some());
    }

    #[test]
    fn sends_an_answer_cleaned() {
        let body = answer_body(ID, " forty\u{0} two ");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "checkId": ID, "answer": "forty two" })
        );
        let reply = parse_answer_reply(br#"{"correct":false,"speech":"Not quite. The answer: 0"}"#);
        assert_eq!(reply.map(|r| r.correct), Some(false));
        assert!(parse_answer_reply(br#"{"correct":true,"speech":""}"#).is_none());
    }

    #[test]
    fn goes_through_the_questions_and_counts_what_was_right() {
        assert!(Quiz::new(vec![]).is_none());
        let mut quiz = Quiz::new(vec![
            question(QuestionKind::Short, &[]),
            question(QuestionKind::Mcq, &["0", "9.8"]),
        ])
        .unwrap();
        assert_eq!(quiz.view().phase, "asking");
        assert!(!quiz.view().last);
        quiz.graded(true, "That's it.".into());
        assert_eq!(quiz.view().said, Some("That's it."));
        assert!(quiz.advance());
        assert!(quiz.view().last);
        assert_eq!(quiz.view().choices.len(), 2);
        quiz.graded(false, "Not quite.".into());
        assert!(!quiz.advance());
        assert_eq!(
            quiz.closing_line(),
            "That's the quiz: 1 of 2 right. They come back in your review."
        );
    }

    #[test]
    fn skipping_everything_still_keeps_the_cards() {
        let mut quiz = Quiz::new(vec![question(QuestionKind::Short, &[])]).unwrap();
        assert!(!quiz.advance());
        assert_eq!(quiz.closing_line(), "Okay. It comes back in your review.");
    }

    #[test]
    fn hears_stop_skip_and_answers() {
        let short = question(QuestionKind::Short, &[]);
        assert_eq!(word_of("Stop the quiz.", Some(&short)), QuizWord::Stop);
        assert_eq!(word_of("Neb, skip", Some(&short)), QuizWord::Next);
        assert_eq!(word_of("next question", Some(&short)), QuizWord::Next);
        assert_eq!(word_of("  ", Some(&short)), QuizWord::Nothing);
        assert_eq!(
            word_of("Gravity pulls it down", Some(&short)),
            QuizWord::Answer("Gravity pulls it down".into())
        );
    }

    #[test]
    fn picks_a_choice_by_letter_place_or_text() {
        let choices: Vec<String> = ["0", "9.8 m/s²", "It depends"]
            .iter()
            .map(|c| (*c).to_owned())
            .collect();
        assert_eq!(choice_for("B", &choices), Some(1));
        assert_eq!(choice_for("option c", &choices), Some(2));
        assert_eq!(choice_for("the first one", &choices), Some(0));
        assert_eq!(choice_for("it depends", &choices), Some(2));
        assert_eq!(choice_for("I think it's... d", &choices), None);
        assert_eq!(choice_for("seven", &choices), None);
        let mcq = question(QuestionKind::Mcq, &["0", "9.8 m/s²", "It depends"]);
        assert_eq!(
            word_of("the second one", Some(&mcq)),
            QuizWord::Answer("9.8 m/s²".into())
        );
        assert_eq!(
            word_of("zero, I think", Some(&mcq)),
            QuizWord::Answer("zero, I think".into())
        );
    }
}
