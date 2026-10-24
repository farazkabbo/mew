//! Playing a Circle & Ask explanation step by step (S3.2 §2.4, §3.6, decision 11). Pure: the
//! caller feeds it what happened (a step arrived, the words were said, time passed, a button)
//! and carries out the cues it returns. Fully tested, with time passed in.
//!
//! Each step: its ink is drawn first (`Reveal`), then, once the ink has had time to appear, its
//! words are said (`Say`, the page reports when it's done) or shown (`Caption`, for reading
//! time). Then the next step, as soon as it has arrived. The words never come before their ink.

use std::time::{Duration, Instant};

/// How the words reach the student.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Voice {
    /// Spoken by the page (and shown in the caption card).
    Spoken,
    /// Shown only (silent mode, §4).
    Captions,
}

/// What the caller should do now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cue {
    /// Draw step `index`'s ink.
    Reveal(usize),
    /// Show step `index`'s words in the caption card.
    Caption(usize),
    /// Say step `index`'s words; the page reports `token` when it's finished.
    Say { index: usize, token: u64 },
    /// Stop whatever is being said.
    Hush,
    /// Every step has been played (or the student stopped it): offer to save.
    Finished,
}

/// Time for the ink to appear before its words (the overlay animates for 300–600 ms).
pub const INK_LEAD: Duration = Duration::from_millis(450);
/// Reading time per word, and at least this long (§3.6).
const READ_PER_WORD: Duration = Duration::from_millis(250);
const READ_AT_LEAST: Duration = Duration::from_millis(1500);
/// If the page never says it finished speaking, carry on after about this long per word, plus
/// some slack for the speech to start.
const SPEAK_PER_WORD: Duration = Duration::from_millis(450);
const SPEAK_SLACK: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Waiting for step `current` to arrive.
    Waiting,
    /// Its ink is appearing; the words come at the deadline.
    Drawing,
    /// Its words are being said (token) or read.
    Telling,
    Paused,
    /// Played to the end, or stopped.
    Over,
}

#[derive(Debug)]
pub struct Playback {
    voice: Voice,
    /// Each arrived step's word count.
    words: Vec<usize>,
    /// No more steps will come.
    complete: bool,
    current: usize,
    phase: Phase,
    deadline: Option<Instant>,
    /// Identifies the words being said now (an older report is ignored).
    token: u64,
    animate: bool,
}

impl Playback {
    pub fn new(voice: Voice, animate: bool) -> Self {
        Self {
            voice,
            words: Vec::new(),
            complete: false,
            current: 0,
            phase: Phase::Waiting,
            deadline: None,
            token: 0,
            animate,
        }
    }

    /// A step's words arrived (steps arrive in order).
    pub fn step_arrived(&mut self, words: usize, now: Instant) -> Vec<Cue> {
        self.words.push(words);
        if self.phase == Phase::Waiting && self.current < self.words.len() {
            return self.reveal(now);
        }
        Vec::new()
    }

    /// No more steps will arrive.
    pub fn no_more_steps(&mut self) -> Vec<Cue> {
        self.complete = true;
        if self.phase == Phase::Waiting && self.current >= self.words.len() {
            return self.finish();
        }
        Vec::new()
    }

    /// The page finished saying the words with `token`.
    pub fn spoken(&mut self, token: u64, now: Instant) -> Vec<Cue> {
        if self.phase == Phase::Telling && self.voice == Voice::Spoken && token == self.token {
            return self.move_on(now);
        }
        Vec::new()
    }

    /// Time passed: acts on the deadline if it's due.
    pub fn tick(&mut self, now: Instant) -> Vec<Cue> {
        match self.deadline {
            Some(at) if now >= at => {}
            _ => return Vec::new(),
        }
        self.deadline = None;
        match self.phase {
            Phase::Drawing => self.tell(now),
            Phase::Telling => self.move_on(now),
            _ => Vec::new(),
        }
    }

    /// When `tick` should be called next.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// "Next": on to the next step now.
    pub fn next(&mut self, now: Instant) -> Vec<Cue> {
        match self.phase {
            Phase::Drawing | Phase::Telling | Phase::Paused => {
                let mut cues = vec![Cue::Hush];
                cues.extend(self.move_on(now));
                cues
            }
            _ => Vec::new(),
        }
    }

    /// "Repeat step": its words again (its ink is still there).
    pub fn repeat(&mut self, now: Instant) -> Vec<Cue> {
        match self.phase {
            Phase::Telling | Phase::Paused => {
                let mut cues = vec![Cue::Hush];
                cues.extend(self.tell(now));
                cues
            }
            // At the end, "repeat" says the last step again.
            Phase::Over if !self.words.is_empty() => {
                self.current = self.words.len() - 1;
                let mut cues = vec![Cue::Hush];
                cues.extend(self.tell(now));
                cues
            }
            _ => Vec::new(),
        }
    }

    pub fn pause(&mut self) -> Vec<Cue> {
        if matches!(self.phase, Phase::Drawing | Phase::Telling) {
            self.phase = Phase::Paused;
            self.deadline = None;
            return vec![Cue::Hush];
        }
        Vec::new()
    }

    /// Picks up where it paused: the current step's words again.
    pub fn resume(&mut self, now: Instant) -> Vec<Cue> {
        if self.phase == Phase::Paused {
            return self.tell(now);
        }
        Vec::new()
    }

    /// "Stop", Esc, or barge-in (the student talks, types or draws): silence, and the explanation
    /// ends where it is.
    pub fn stop(&mut self) -> Vec<Cue> {
        if self.phase == Phase::Over {
            return Vec::new();
        }
        let mut cues = vec![Cue::Hush];
        cues.extend(self.finish());
        cues
    }

    pub fn is_over(&self) -> bool {
        self.phase == Phase::Over
    }

    pub fn is_paused(&self) -> bool {
        self.phase == Phase::Paused
    }

    /// The step being played (from 0), and how many have arrived.
    pub fn position(&self) -> (usize, usize) {
        (
            self.current.min(self.words.len().saturating_sub(1)),
            self.words.len(),
        )
    }

    fn reveal(&mut self, now: Instant) -> Vec<Cue> {
        self.phase = Phase::Drawing;
        let lead = if self.animate {
            INK_LEAD
        } else {
            Duration::from_millis(100)
        };
        self.deadline = Some(now + lead);
        vec![Cue::Reveal(self.current)]
    }

    fn tell(&mut self, now: Instant) -> Vec<Cue> {
        self.phase = Phase::Telling;
        let words = self.words.get(self.current).copied().unwrap_or(0) as u32;
        let index = self.current;
        match self.voice {
            Voice::Spoken => {
                self.token += 1;
                self.deadline = Some(now + SPEAK_PER_WORD * words + SPEAK_SLACK);
                vec![
                    Cue::Caption(index),
                    Cue::Say {
                        index,
                        token: self.token,
                    },
                ]
            }
            Voice::Captions => {
                self.deadline = Some(now + (READ_PER_WORD * words).max(READ_AT_LEAST));
                vec![Cue::Caption(index)]
            }
        }
    }

    fn move_on(&mut self, now: Instant) -> Vec<Cue> {
        self.current += 1;
        self.deadline = None;
        if self.current < self.words.len() {
            return self.reveal(now);
        }
        if self.complete {
            return self.finish();
        }
        self.phase = Phase::Waiting;
        Vec::new()
    }

    fn finish(&mut self) -> Vec<Cue> {
        self.phase = Phase::Over;
        self.deadline = None;
        vec![Cue::Finished]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn draws_each_step_before_saying_it_and_waits_for_the_words_to_end() {
        let t0 = Instant::now();
        let mut play = Playback::new(Voice::Spoken, true);
        assert_eq!(play.step_arrived(6, t0), vec![Cue::Reveal(0)]);
        // The words wait for the ink.
        assert!(play.tick(at(t0, 200)).is_empty());
        assert_eq!(
            play.tick(at(t0, 450)),
            vec![Cue::Caption(0), Cue::Say { index: 0, token: 1 }]
        );
        // Step 2 arrives while step 1 is said: it waits its turn.
        assert!(play.step_arrived(8, at(t0, 600)).is_empty());
        // A stale report changes nothing; the right one moves on.
        assert!(play.spoken(7, at(t0, 1500)).is_empty());
        assert_eq!(play.spoken(1, at(t0, 2000)), vec![Cue::Reveal(1)]);
        assert_eq!(
            play.tick(at(t0, 2450)),
            vec![Cue::Caption(1), Cue::Say { index: 1, token: 2 }]
        );
        assert!(
            play.spoken(2, at(t0, 4000)).is_empty(),
            "more steps may come"
        );
        assert_eq!(play.no_more_steps(), vec![Cue::Finished]);
        assert!(play.is_over());
    }

    #[test]
    fn carries_on_if_the_page_never_says_the_words_ended() {
        let t0 = Instant::now();
        let mut play = Playback::new(Voice::Spoken, true);
        play.step_arrived(10, t0);
        play.no_more_steps();
        play.tick(at(t0, 450));
        // 10 words: 4.5 s + 4 s of slack.
        assert!(play.tick(at(t0, 450 + 8000)).is_empty());
        assert_eq!(play.tick(at(t0, 450 + 8500)), vec![Cue::Finished]);
    }

    #[test]
    fn captions_get_reading_time() {
        let t0 = Instant::now();
        let mut play = Playback::new(Voice::Captions, true);
        play.step_arrived(2, t0);
        assert_eq!(play.tick(at(t0, 450)), vec![Cue::Caption(0)]);
        // Two words still get 1.5 s.
        assert!(play.tick(at(t0, 1900)).is_empty());
        play.step_arrived(20, at(t0, 1000));
        assert_eq!(play.tick(at(t0, 1950)), vec![Cue::Reveal(1)]);
        play.tick(at(t0, 2400));
        // Twenty words: 5 s.
        assert_eq!(play.deadline(), Some(at(t0, 7400)));
    }

    #[test]
    fn next_repeat_pause_and_stop_act_on_steps() {
        let t0 = Instant::now();
        let mut play = Playback::new(Voice::Spoken, false);
        play.step_arrived(4, t0);
        play.step_arrived(4, t0);
        play.no_more_steps();
        // Without animations the words come almost at once.
        assert_eq!(play.tick(at(t0, 100)).len(), 2);

        assert_eq!(
            play.repeat(at(t0, 500)),
            vec![Cue::Hush, Cue::Caption(0), Cue::Say { index: 0, token: 2 }]
        );
        assert_eq!(play.pause(), vec![Cue::Hush]);
        assert!(play.is_paused());
        assert!(
            play.tick(at(t0, 60_000)).is_empty(),
            "paused: nothing moves"
        );
        assert_eq!(
            play.resume(at(t0, 61_000)),
            vec![Cue::Caption(0), Cue::Say { index: 0, token: 3 }]
        );
        assert_eq!(play.next(at(t0, 62_000)), vec![Cue::Hush, Cue::Reveal(1)]);
        assert_eq!(play.position(), (1, 2));
        assert_eq!(play.stop(), vec![Cue::Hush, Cue::Finished]);
        assert!(play.stop().is_empty());
        // At the end, "repeat" says the last step again.
        assert_eq!(
            play.repeat(at(t0, 63_000)),
            vec![Cue::Hush, Cue::Caption(1), Cue::Say { index: 1, token: 4 }]
        );
    }

    #[test]
    fn finishes_at_once_when_no_step_comes() {
        let mut play = Playback::new(Voice::Captions, true);
        assert_eq!(play.no_more_steps(), vec![Cue::Finished]);
    }
}
