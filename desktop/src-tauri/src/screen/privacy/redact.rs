//! Turning OCR results into rectangles to cover, and covering them in the captured pixels.
//!
//! Covered areas are filled with a flat colour rather than blurred: a blur of short text (a
//! six-digit code) can sometimes be reversed; a flat fill can't.

use super::detect::{find_sensitive, RedactionRules};
use crate::screen::frame::ScreenRect;
use crate::screen::image::Pixels;

/// One recognised word and where it is, in OCR-image pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OcrLine {
    pub words: Vec<OcrWord>,
}

/// A rectangle in captured-image pixels (left, top inclusive; right, bottom exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

/// Mid grey: clearly "something was hidden here", in light and dark apps alike.
pub const REDACTED: [u8; 3] = [0x80, 0x80, 0x80];
pub const BLACKED_OUT: [u8; 3] = [0, 0, 0];

/// Rectangles (in captured-image pixels) covering every word that holds sensitive text.
///
/// `scale` converts OCR-image pixels to captured-image pixels (OCR may run on a smaller copy).
/// Each rectangle is padded so anti-aliased edges of the text are covered too.
pub fn rects_to_cover(
    lines: &[OcrLine],
    rules: &RedactionRules,
    scale: f32,
    image_width: u32,
    image_height: u32,
) -> Vec<PixelRect> {
    let mut rects = Vec::new();
    for line in lines {
        // Rebuild the line's text with one space between words, remembering where each word is.
        let mut text = String::new();
        let mut spans = Vec::with_capacity(line.words.len());
        for word in &line.words {
            if !text.is_empty() {
                text.push(' ');
            }
            let start = text.len();
            text.push_str(&word.text);
            spans.push(start..text.len());
        }
        for (range, _) in find_sensitive(&text, rules) {
            for (word, span) in line.words.iter().zip(&spans) {
                if span.start < range.end && range.start < span.end {
                    rects.push(to_pixels(word, scale, image_width, image_height));
                }
            }
        }
    }
    rects
}

fn to_pixels(word: &OcrWord, scale: f32, image_width: u32, image_height: u32) -> PixelRect {
    let pad = (word.height * 0.25).max(2.0);
    let clamp = |v: f32, max: u32| (v.max(0.0) as u32).min(max);
    PixelRect {
        left: clamp((word.x - pad) * scale, image_width),
        top: clamp((word.y - pad) * scale, image_height),
        right: clamp(((word.x + word.width + pad) * scale).ceil(), image_width),
        bottom: clamp(((word.y + word.height + pad) * scale).ceil(), image_height),
    }
}

/// Maps a rectangle on screen to the captured image of `captured` (the screen area the image
/// shows, `width`×`height` pixels). None when it doesn't overlap the image.
pub fn screen_to_pixels(
    rect: ScreenRect,
    captured: ScreenRect,
    width: u32,
    height: u32,
) -> Option<PixelRect> {
    if captured.width() <= 0 || captured.height() <= 0 {
        return None;
    }
    let sx = f64::from(width) / f64::from(captured.width());
    let sy = f64::from(height) / f64::from(captured.height());
    let x = |v: i32| ((f64::from(v - captured.left) * sx).clamp(0.0, f64::from(width))) as u32;
    let y = |v: i32| ((f64::from(v - captured.top) * sy).clamp(0.0, f64::from(height))) as u32;
    let (left, right) = (
        x(rect.left),
        (f64::from(rect.right - captured.left) * sx)
            .ceil()
            .clamp(0.0, f64::from(width)) as u32,
    );
    let (top, bottom) = (
        y(rect.top),
        (f64::from(rect.bottom - captured.top) * sy)
            .ceil()
            .clamp(0.0, f64::from(height)) as u32,
    );
    (left < right && top < bottom).then_some(PixelRect {
        left,
        top,
        right,
        bottom,
    })
}

/// Fills `rects` of BGRA `pixels` with `colour` (RGB).
pub fn fill(pixels: &mut Pixels, rects: &[PixelRect], colour: [u8; 3]) {
    debug_assert_eq!(pixels.channels, 4);
    let stride = pixels.stride();
    let (width, height) = (pixels.width, pixels.height);
    let bgra = [colour[2], colour[1], colour[0], 255];
    let data = pixels.data.as_mut_slice();
    for rect in rects {
        let (right, bottom) = (rect.right.min(width), rect.bottom.min(height));
        for y in rect.top.min(bottom)..bottom {
            let row = y as usize * stride;
            for x in rect.left.min(right)..right {
                let at = row + x as usize * 4;
                data[at..at + 4].copy_from_slice(&bgra);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::secret::SecretBytes;

    fn word(text: &str, x: f32) -> OcrWord {
        OcrWord {
            text: text.into(),
            x,
            y: 10.0,
            width: 40.0,
            height: 12.0,
        }
    }

    #[test]
    fn covers_every_word_of_a_split_card_number_and_nothing_else() {
        let line = OcrLine {
            words: vec![
                word("Card", 0.0),
                word("4111", 50.0),
                word("1111", 100.0),
                word("1111", 150.0),
                word("1111", 200.0),
                word("exp", 250.0),
            ],
        };
        let rects = rects_to_cover(&[line], &RedactionRules::default(), 1.0, 1000, 1000);
        assert_eq!(rects.len(), 4);
        assert!(
            rects.iter().all(|r| r.left >= 47 && r.right <= 243),
            "{rects:?}"
        );
    }

    #[test]
    fn scales_and_clamps_to_the_image() {
        let line = OcrLine {
            words: vec![OcrWord {
                text: "AKIAIOSFODNN7EXAMPLE".into(),
                x: 90.0,
                y: 0.0,
                width: 20.0,
                height: 8.0,
            }],
        };
        let rects = rects_to_cover(&[line], &RedactionRules::default(), 2.0, 200, 100);
        assert_eq!(
            rects,
            vec![PixelRect {
                left: 176,
                top: 0,
                right: 200,
                bottom: 20
            }]
        );
    }

    #[test]
    fn maps_screen_rectangles_into_the_image() {
        // A monitor left of the primary (negative x), captured at full size.
        let monitor = ScreenRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        let window = ScreenRect {
            left: -2000,
            top: 100,
            right: -1800,
            bottom: 300,
        };
        assert_eq!(
            screen_to_pixels(window, monitor, 1920, 1080),
            Some(PixelRect {
                left: 0,
                top: 100,
                right: 120,
                bottom: 300
            })
        );
        // The same monitor captured at half size (a 200% monitor's frame, say).
        assert_eq!(
            screen_to_pixels(window, monitor, 960, 540),
            Some(PixelRect {
                left: 0,
                top: 50,
                right: 60,
                bottom: 150
            })
        );
        // Entirely on another monitor.
        let elsewhere = ScreenRect {
            left: 10,
            top: 10,
            right: 50,
            bottom: 50,
        };
        assert_eq!(screen_to_pixels(elsewhere, monitor, 1920, 1080), None);
    }

    #[test]
    fn fills_only_inside_the_rectangles() {
        let mut pixels = Pixels {
            width: 4,
            height: 2,
            channels: 4,
            data: SecretBytes::zeroed(32),
        };
        fill(
            &mut pixels,
            &[
                PixelRect {
                    left: 1,
                    top: 0,
                    right: 3,
                    bottom: 1,
                },
                PixelRect {
                    left: 3,
                    top: 1,
                    right: 99,
                    bottom: 99,
                },
            ],
            [0x10, 0x20, 0x30],
        );
        let px = |x: usize, y: usize| &pixels.data.as_slice()[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        assert_eq!(px(0, 0), &[0, 0, 0, 0]);
        assert_eq!(px(1, 0), &[0x30, 0x20, 0x10, 255]);
        assert_eq!(px(2, 0), &[0x30, 0x20, 0x10, 255]);
        assert_eq!(px(3, 0), &[0, 0, 0, 0]);
        assert_eq!(px(3, 1), &[0x30, 0x20, 0x10, 255], "clamped to the image");
    }
}
