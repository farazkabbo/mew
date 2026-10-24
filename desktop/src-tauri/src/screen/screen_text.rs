//! The text on a captured screen, as on-device OCR read it, in screen pixels (S3).
//!
//! Only text that is still visible after redaction is kept: a word that overlaps a covered or
//! blacked-out area is dropped, so hidden details can never reach a saved clip's text. What's
//! kept stays in Rust: the overlay gets rectangles only (to keep notes off the text), and words
//! leave the device only inside a clip the student chose to save. Texts are wiped on drop.

use super::frame::ScreenRect;
use super::privacy::detect::{find_sensitive, RedactionRules};
use super::privacy::redact::{OcrLine, PixelRect};
use super::secret::wipe;

pub struct ScreenWord {
    pub rect: ScreenRect,
    text: String,
    line: u32,
}

/// The visible words of one capture, in reading order.
#[derive(Default)]
pub struct ScreenText {
    words: Vec<ScreenWord>,
}

/// A few words and where they were: enough to find the same spot on a later capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextAnchor {
    words: Vec<String>,
    pub rect: ScreenRect,
}

/// How many words of a focus region are looked for again.
const ANCHOR_WORDS: usize = 6;

/// Caps on what a notes check sends (packages/shared/src/notes-check.ts NOTES_CHECK_LIMITS).
const MAX_BLOCKS: usize = 80;
const BLOCK_CHARS: usize = 1000;
const SCREEN_CHARS: usize = 8000;

/// A paragraph of on-screen text (Notes Check): what's sent is the id and the words; where it is
/// stays here, to put the marks beside it. The text is wiped on drop.
pub struct TextBlock {
    pub id: String,
    pub text: String,
    pub rect: ScreenRect,
    /// The block's last line, to decide whether the next one continues the paragraph.
    last_line: ScreenRect,
}

impl Drop for TextBlock {
    fn drop(&mut self) {
        wipe_string(&mut self.text);
    }
}

impl ScreenText {
    /// Words from OCR `lines` (in OCR-image pixels; `ocr_scale` converts to captured pixels),
    /// placed on screen within `bounds` (the captured area, `raw_width`×`raw_height` pixels),
    /// leaving out any word that touches a `covered` rectangle (captured pixels).
    pub fn from_ocr(
        lines: &[OcrLine],
        ocr_scale: f32,
        (raw_width, raw_height): (u32, u32),
        bounds: ScreenRect,
        covered: &[PixelRect],
    ) -> Self {
        if raw_width == 0 || raw_height == 0 {
            return Self::default();
        }
        let sx = bounds.width() as f32 / raw_width as f32;
        let sy = bounds.height() as f32 / raw_height as f32;
        let mut words = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            for word in &line.words {
                let raw = PixelRect {
                    left: (word.x * ocr_scale).max(0.0) as u32,
                    top: (word.y * ocr_scale).max(0.0) as u32,
                    right: ((word.x + word.width) * ocr_scale).ceil().max(0.0) as u32,
                    bottom: ((word.y + word.height) * ocr_scale).ceil().max(0.0) as u32,
                };
                if word.text.trim().is_empty() || covered.iter().any(|c| touches(c, &raw)) {
                    continue;
                }
                words.push(ScreenWord {
                    rect: ScreenRect {
                        left: bounds.left + (raw.left as f32 * sx).floor() as i32,
                        top: bounds.top + (raw.top as f32 * sy).floor() as i32,
                        right: bounds.left + (raw.right as f32 * sx).ceil() as i32,
                        bottom: bounds.top + (raw.bottom as f32 * sy).ceil() as i32,
                    },
                    text: word.text.clone(),
                    line: index as u32,
                });
            }
        }
        Self { words }
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// Where text is, for keeping notes off it.
    pub fn rects(&self) -> impl Iterator<Item = ScreenRect> + '_ {
        self.words.iter().map(|w| w.rect)
    }

    /// The median height of a word on screen (sizes the handwriting).
    pub fn typical_height(&self) -> Option<f32> {
        let mut heights: Vec<i32> = self.words.iter().map(|w| w.rect.height()).collect();
        if heights.is_empty() {
            return None;
        }
        heights.sort_unstable();
        Some(heights[heights.len() / 2] as f32)
    }

    /// The text whose words sit inside `area` (their centre does), a line per OCR line. A line
    /// that still looks sensitive under `rules` (plus the default rules, always) is left out as
    /// well: a saved clip's text must never hold what the image hides.
    pub fn text_in(&self, area: ScreenRect, rules: &RedactionRules) -> String {
        let mut out = String::new();
        let mut line = None;
        for word in self.words.iter().filter(|w| centre_in(&w.rect, &area)) {
            if !out.is_empty() {
                out.push(if line == Some(word.line) { ' ' } else { '\n' });
            }
            out.push_str(&word.text);
            line = Some(word.line);
        }
        let rules = at_least_defaults(rules);
        out.lines()
            .filter(|l| find_sensitive(l, &rules).is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Where each word is and which line it's on, in reading order (for the student's marks,
    /// Circle & Ask: `marks::target_words` picks words by these indexes).
    pub fn word_boxes(&self) -> Vec<super::marks::WordBox> {
        self.words
            .iter()
            .map(|w| super::marks::WordBox {
                rect: w.rect,
                line: w.line,
            })
            .collect()
    }

    /// The text of the words at `indexes` (from `word_boxes`), a line per OCR line, leaving out
    /// lines that still look sensitive (as `text_in` does).
    pub fn text_of(&self, indexes: &[usize], rules: &RedactionRules) -> String {
        let mut picked: Vec<usize> = indexes
            .iter()
            .copied()
            .filter(|&i| i < self.words.len())
            .collect();
        picked.sort_unstable();
        picked.dedup();
        let mut out = String::new();
        let mut line = None;
        for word in picked.into_iter().map(|i| &self.words[i]) {
            if !out.is_empty() {
                out.push(if line == Some(word.line) { ' ' } else { '\n' });
            }
            out.push_str(&word.text);
            line = Some(word.line);
        }
        let rules = at_least_defaults(rules);
        let kept = out
            .lines()
            .filter(|l| find_sensitive(l, &rules).is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        wipe_string(&mut out);
        kept
    }

    /// The screen's text as blocks (Notes Check, N4): each a paragraph of consecutive OCR lines
    /// of similar size close together, with where it is. Blocks get ids "b1", "b2"… in reading
    /// order; the positions stay on the device (the marks are placed here), only the words are
    /// sent. A line that still looks sensitive is left out, as in `text_in`.
    pub fn blocks(&self, rules: &RedactionRules) -> Vec<TextBlock> {
        let rules = at_least_defaults(rules);
        let mut blocks: Vec<TextBlock> = Vec::new();
        let mut total = 0;
        for (rect, mut text) in self.lines() {
            if !find_sensitive(&text, &rules).is_empty() {
                wipe_string(&mut text);
                continue;
            }
            if total + text.len() + 1 > SCREEN_CHARS {
                wipe_string(&mut text);
                break;
            }
            total += text.len() + 1;
            let paragraph = blocks.last_mut().filter(|block| {
                continues_paragraph(block.last_line, rect)
                    && block.text.len() + text.len() < BLOCK_CHARS
            });
            if let Some(block) = paragraph {
                block.rect = union([block.rect, rect]).unwrap_or(block.rect);
                block.last_line = rect;
                block.text.push(' ');
                block.text.push_str(&text);
                wipe_string(&mut text);
            } else if blocks.len() < MAX_BLOCKS {
                let id = format!("b{}", blocks.len() + 1);
                blocks.push(TextBlock {
                    id,
                    text,
                    rect,
                    last_line: rect,
                });
            } else {
                wipe_string(&mut text);
                break;
            }
        }
        blocks
    }

    /// The OCR lines in reading order: where each is, and its words joined by spaces.
    fn lines(&self) -> Vec<(ScreenRect, String)> {
        let mut lines: Vec<(u32, ScreenRect, String)> = Vec::new();
        for word in &self.words {
            match lines.last_mut() {
                Some((line, rect, text)) if *line == word.line => {
                    *rect = union([*rect, word.rect]).unwrap_or(*rect);
                    text.push(' ');
                    text.push_str(&word.text);
                }
                _ => lines.push((word.line, word.rect, word.text.clone())),
            }
        }
        lines
            .into_iter()
            .map(|(_, rect, text)| (rect, text))
            .collect()
    }

    /// The first few words inside `area`, with where they are (None without text there).
    pub fn anchor_in(&self, area: ScreenRect) -> Option<TextAnchor> {
        let inside: Vec<&ScreenWord> = self
            .words
            .iter()
            .filter(|w| centre_in(&w.rect, &area))
            .filter(|w| !normalise(&w.text).is_empty())
            .take(ANCHOR_WORDS)
            .collect();
        // One or two words are too likely to appear elsewhere on the page.
        if inside.len() < 3.min(ANCHOR_WORDS) {
            return None;
        }
        Some(TextAnchor {
            words: inside.iter().map(|w| normalise(&w.text)).collect(),
            rect: union(inside.iter().map(|w| w.rect))?,
        })
    }

    /// Where the anchor's words are now, if they appear in the same order (exactly once: a
    /// phrase that appears twice can't say which one the ink was about).
    pub fn locate(&self, anchor: &TextAnchor) -> Option<ScreenRect> {
        let words: Vec<(String, ScreenRect)> = self
            .words
            .iter()
            .map(|w| (normalise(&w.text), w.rect))
            .filter(|(text, _)| !text.is_empty())
            .collect();
        let n = anchor.words.len();
        let mut found = None;
        for start in 0..words.len().saturating_sub(n - 1) {
            let window = &words[start..start + n];
            if window.iter().zip(&anchor.words).all(|((w, _), a)| w == a) {
                if found.is_some() {
                    return None;
                }
                found = union(window.iter().map(|(_, rect)| *rect));
            }
        }
        found
    }
}

impl Drop for ScreenWord {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.text).into_bytes();
        wipe(&mut bytes);
    }
}

impl Drop for TextAnchor {
    fn drop(&mut self) {
        for word in &mut self.words {
            let mut bytes = std::mem::take(word).into_bytes();
            wipe(&mut bytes);
        }
    }
}

/// The user's redaction rules, with the default ones always on (a saved or sent text must never
/// hold what the image hides).
fn at_least_defaults(rules: &RedactionRules) -> RedactionRules {
    let defaults = RedactionRules::default();
    RedactionRules {
        cards: rules.cards || defaults.cards,
        secrets: rules.secrets || defaults.secrets,
        codes: rules.codes || defaults.codes,
        emails: rules.emails,
        phones: rules.phones,
    }
}

/// The next OCR line continues a paragraph when it's the same size of text, just below it (at
/// most a line's height of space) and starts near the same place (aligned or overlapping).
fn continues_paragraph(previous: ScreenRect, next: ScreenRect) -> bool {
    let (h1, h2) = (previous.height().max(1), next.height().max(1));
    let similar_size = (h1 - h2).abs() * 3 <= h1.max(h2);
    let gap = next.top - previous.bottom;
    let close_below = (-h1 / 2..=h1).contains(&gap);
    let aligned = (next.left - previous.left).abs() <= 2 * h1
        || (next.left < previous.right && previous.left < next.right);
    similar_size && close_below && aligned
}

fn wipe_string(text: &mut String) {
    let mut bytes = std::mem::take(text).into_bytes();
    wipe(&mut bytes);
}

/// Lowercase letters and digits only: OCR varies in punctuation between captures.
fn normalise(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn touches(a: &PixelRect, b: &PixelRect) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

fn centre_in(rect: &ScreenRect, area: &ScreenRect) -> bool {
    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    cx >= area.left && cx < area.right && cy >= area.top && cy < area.bottom
}

pub fn union(rects: impl IntoIterator<Item = ScreenRect>) -> Option<ScreenRect> {
    rects.into_iter().reduce(|a, b| ScreenRect {
        left: a.left.min(b.left),
        top: a.top.min(b.top),
        right: a.right.max(b.right),
        bottom: a.bottom.max(b.bottom),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::privacy::redact::OcrWord;

    /// Lines of words 10 px apart, each word 40×10 OCR pixels (OCR ran at half size).
    fn ocr(lines: &[&str]) -> Vec<OcrLine> {
        lines
            .iter()
            .enumerate()
            .map(|(row, line)| OcrLine {
                words: line
                    .split(' ')
                    .enumerate()
                    .map(|(col, text)| OcrWord {
                        text: text.to_owned(),
                        x: col as f32 * 50.0,
                        y: row as f32 * 20.0,
                        width: 40.0,
                        height: 10.0,
                    })
                    .collect(),
            })
            .collect()
    }

    /// A window at (-1000, 100), captured at 2000×1000 pixels, shown 1:1 on screen.
    const BOUNDS: ScreenRect = ScreenRect {
        left: -1000,
        top: 100,
        right: 1000,
        bottom: 1100,
    };

    fn text(lines: &[&str], covered: &[PixelRect]) -> ScreenText {
        ScreenText::from_ocr(&ocr(lines), 2.0, (2000, 1000), BOUNDS, covered)
    }

    #[test]
    fn places_words_on_screen() {
        let screen = text(&["Question 3"], &[]);
        let rects: Vec<_> = screen.rects().collect();
        assert_eq!(
            rects[1],
            ScreenRect {
                left: -900,
                top: 100,
                right: -820,
                bottom: 120
            }
        );
        assert_eq!(screen.typical_height(), Some(20.0));
    }

    #[test]
    fn drops_words_under_redaction() {
        // The second word of the second line was covered (captured pixels 100..180 × 40..60).
        let covered = [PixelRect {
            left: 100,
            top: 40,
            right: 180,
            bottom: 60,
        }];
        let screen = text(&["Pay with", "card 4242424242424242"], &covered);
        let all = screen.text_in(BOUNDS, &RedactionRules::default());
        assert_eq!(all, "Pay with\ncard");
        assert!(!all.contains("4242"));
    }

    #[test]
    fn leaves_out_anything_still_sensitive() {
        // OCR split differently from the redaction pass: the rules run again on the text.
        let screen = text(&["Key AKIAIOSFODNN7EXAMPLE here", "Plain words"], &[]);
        assert_eq!(
            screen.text_in(BOUNDS, &RedactionRules::default()),
            "Plain words"
        );
    }

    #[test]
    fn reads_only_the_area_asked_for() {
        let screen = text(&["one two three", "four five six"], &[]);
        let first_line = ScreenRect {
            left: -1000,
            top: 100,
            right: 1000,
            bottom: 125,
        };
        assert_eq!(
            screen.text_in(first_line, &RedactionRules::default()),
            "one two three"
        );
    }

    #[test]
    fn finds_the_same_words_after_scrolling() {
        let before = text(
            &["Intro text here", "Question 3 a block slides", "Next part"],
            &[],
        );
        let focus = ScreenRect {
            left: -1000,
            top: 140,
            right: 1000,
            bottom: 160,
        };
        let anchor = before.anchor_in(focus).expect("anchor");
        assert_eq!(anchor.rect.top, 140);

        // Scrolled up by two lines (80 screen pixels).
        let after = text(&["Question 3 a block slides", "Next part", "More"], &[]);
        let now = after.locate(&anchor).expect("found again");
        assert_eq!(now.top, 100);
        assert_eq!(now.left, anchor.rect.left);
    }

    /// OCR lines at the given (top, height) with the given text, each starting at x = 0.
    fn ocr_at(lines: &[(f32, f32, &str)]) -> Vec<OcrLine> {
        lines
            .iter()
            .map(|(y, h, line)| OcrLine {
                words: line
                    .split(' ')
                    .enumerate()
                    .map(|(col, text)| OcrWord {
                        text: text.to_owned(),
                        x: col as f32 * 50.0,
                        y: *y,
                        width: 40.0,
                        height: *h,
                    })
                    .collect(),
            })
            .collect()
    }

    #[test]
    fn groups_lines_into_paragraphs_for_notes_check() {
        let lines = ocr_at(&[
            (0.0, 20.0, "Enzymes"),
            (40.0, 10.0, "Enzymes are biological"),
            (52.0, 10.0, "catalysts made of protein."),
            (100.0, 10.0, "They are not consumed."),
        ]);
        let screen = ScreenText::from_ocr(&lines, 2.0, (2000, 1000), BOUNDS, &[]);
        let blocks = screen.blocks(&RedactionRules::default());
        let read: Vec<(&str, &str)> = blocks
            .iter()
            .map(|b| (b.id.as_str(), b.text.as_str()))
            .collect();
        // The title (bigger) is its own block; two close lines are one; a far one is another.
        assert_eq!(
            read,
            [
                ("b1", "Enzymes"),
                ("b2", "Enzymes are biological catalysts made of protein."),
                ("b3", "They are not consumed."),
            ]
        );
        // The paragraph's box covers both of its lines (OCR ran at half size).
        assert_eq!((blocks[1].rect.top, blocks[1].rect.bottom), (180, 224));
    }

    #[test]
    fn notes_check_never_sends_sensitive_lines() {
        let screen = text(&["Key AKIAIOSFODNN7EXAMPLE here", "Plain words"], &[]);
        let blocks = screen.blocks(&RedactionRules::default());
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Plain words");
    }

    #[test]
    fn caps_how_much_text_a_check_sends() {
        let long: Vec<String> = (0..400)
            .map(|i| format!("line {i} {}", "word ".repeat(10)))
            .collect();
        let rows: Vec<(f32, f32, &str)> = long
            .iter()
            .enumerate()
            .map(|(i, l)| (i as f32 * 40.0, 10.0, l.trim_end()))
            .collect();
        let screen = ScreenText::from_ocr(&ocr_at(&rows), 1.0, (2000, 40_000), BOUNDS, &[]);
        let blocks = screen.blocks(&RedactionRules::default());
        assert!(!blocks.is_empty() && blocks.len() <= MAX_BLOCKS);
        assert!(blocks.iter().map(|b| b.text.len() + 1).sum::<usize>() <= SCREEN_CHARS);
        assert!(blocks.iter().all(|b| b.text.len() <= BLOCK_CHARS));
    }

    #[test]
    fn wont_guess_between_two_matches_or_from_too_little_text() {
        let twice = text(&["see figure two here", "see figure two here"], &[]);
        let anchor = text(&["see figure two here"], &[])
            .anchor_in(BOUNDS)
            .unwrap();
        assert_eq!(twice.locate(&anchor), None);
        assert_eq!(text(&["Hi there"], &[]).anchor_in(BOUNDS), None);
    }
}
