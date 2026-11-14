//! Has the screen changed since a walkthrough step was shown? (docs/PLAN.md, Part 3; the idea
//! and its thresholds come from Plip's `watch.py`, MIT.) A tiny grey thumbnail of each capture is
//! compared with the one taken when the step was shown: "Done" on an unchanged screen is answered
//! here, without asking the model, the first time. Pure and tested; the thumbnail never leaves
//! memory and is dropped with the walkthrough.

use super::image::Pixels;

/// The thumbnail's size: enough to see a dialog open or a tab change, nothing readable.
const SIZE: (usize, usize) = (64, 40);
/// Grey levels a thumbnail pixel must move to count (JPEG noise moves none, a tick ~4).
const LEVEL: u8 = 24;
/// Pixels that must move for the screen to count as changed.
const PIXELS: usize = 3;

/// A 64 × 40 grey thumbnail of a BGRA or BGR capture (box-averaged).
pub fn fingerprint(image: &Pixels) -> Vec<u8> {
    let (w, h) = (image.width as usize, image.height as usize);
    let channels = image.channels as usize;
    let data = image.data.as_slice();
    let mut out = Vec::with_capacity(SIZE.0 * SIZE.1);
    for ty in 0..SIZE.1 {
        let (y0, y1) = (
            ty * h / SIZE.1,
            ((ty + 1) * h / SIZE.1).max(ty * h / SIZE.1 + 1),
        );
        for tx in 0..SIZE.0 {
            let (x0, x1) = (
                tx * w / SIZE.0,
                ((tx + 1) * w / SIZE.0).max(tx * w / SIZE.0 + 1),
            );
            let (mut sum, mut count) = (0u64, 0u64);
            for y in y0..y1.min(h) {
                for x in x0..x1.min(w) {
                    let at = y * image.stride() + x * channels;
                    if let Some(p) = data.get(at..at + channels.min(3)) {
                        let grey = match p {
                            [b, g, r] => {
                                (u64::from(*r) * 299 + u64::from(*g) * 587 + u64::from(*b) * 114)
                                    / 1000
                            }
                            [v, ..] => u64::from(*v),
                            [] => 0,
                        };
                        sum += grey;
                        count += 1;
                    }
                }
            }
            out.push((sum / count.max(1)) as u8);
        }
    }
    out
}

/// Whether two thumbnails differ enough to say something happened on screen.
pub fn changed(before: &[u8], after: &[u8]) -> bool {
    before.len() != after.len()
        || before
            .iter()
            .zip(after)
            .filter(|(a, b)| a.abs_diff(**b) >= LEVEL)
            .count()
            >= PIXELS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::secret::SecretBytes;

    fn screen(width: u32, height: u32, fill: impl Fn(u32, u32) -> u8) -> Pixels {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let v = fill(x, y);
                data.extend_from_slice(&[v, v, v, 255]);
            }
        }
        Pixels {
            width,
            height,
            channels: 4,
            data: SecretBytes::from_vec(data),
        }
    }

    #[test]
    fn the_same_screen_or_noise_is_not_a_change() {
        let page = screen(1280, 800, |x, _| if x % 7 == 0 { 30 } else { 240 });
        let noisy = screen(1280, 800, |x, y| {
            let base: u8 = if x % 7 == 0 { 30 } else { 240 };
            if (x + y) % 13 == 0 {
                base.saturating_sub(6)
            } else {
                base
            }
        });
        assert!(!changed(&fingerprint(&page), &fingerprint(&page)));
        assert!(!changed(&fingerprint(&page), &fingerprint(&noisy)));
    }

    #[test]
    fn a_dialog_opening_is_a_change() {
        let page = screen(1280, 800, |_, _| 240);
        let dialog = screen(1280, 800, |x, y| {
            if (400..880).contains(&x) && (250..550).contains(&y) {
                60
            } else {
                240
            }
        });
        assert!(changed(&fingerprint(&page), &fingerprint(&dialog)));
    }

    #[test]
    fn a_different_capture_size_counts_as_changed() {
        assert!(changed(&[1, 2, 3], &[1, 2]));
    }
}
