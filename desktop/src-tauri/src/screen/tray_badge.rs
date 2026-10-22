//! Tray icon states: the app icon with a small coloured dot (pure pixel work, tested).

/// What Screen Coach is doing, as shown in the tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Not supported on this PC.
    Unsupported,
    /// Turned off (the default).
    Off,
    Idle,
    /// The talk hotkey is held.
    Listening,
    /// Capturing the screen.
    Looking,
    Speaking,
    Paused,
}

impl Status {
    /// Dot colour (RGB), or None for the plain icon.
    pub fn badge(self) -> Option<[u8; 3]> {
        match self {
            Status::Unsupported | Status::Off | Status::Idle => None,
            Status::Listening => Some([0x3e, 0x9a, 0x69]),
            Status::Looking => Some([0x8a, 0x7b, 0xf0]),
            Status::Speaking => Some([0x5b, 0x8d, 0xef]),
            Status::Paused => Some([0x8a, 0x8a, 0x8a]),
        }
    }

    pub fn tooltip(self) -> &'static str {
        match self {
            Status::Unsupported | Status::Off => "Mew",
            Status::Idle => "Mew · Screen Coach is on",
            Status::Listening => "Mew · Screen Coach is listening",
            Status::Looking => "Mew · Screen Coach is looking at your screen",
            Status::Speaking => "Mew · Screen Coach is speaking",
            Status::Paused => "Mew · Screen Coach is paused",
        }
    }
}

/// Returns `rgba` (width×height) with a filled dot in the bottom-right corner, ringed in white
/// so it reads on light and dark taskbars.
pub fn with_badge(rgba: &[u8], width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = width.min(height) as f32;
    let radius = size * 0.24;
    let ring = (size * 0.06).max(1.0);
    let (cx, cy) = (width as f32 - radius - ring, height as f32 - radius - ring);
    for y in 0..height {
        for x in 0..width {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let rgb = if d <= radius {
                colour
            } else if d <= radius + ring {
                [255, 255, 255]
            } else {
                continue;
            };
            let at = ((y * width + x) * 4) as usize;
            if at + 3 < out.len() {
                out[at..at + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_the_dot_bottom_right_only() {
        let (w, h) = (32u32, 32u32);
        let icon = vec![10u8; (w * h * 4) as usize];
        let out = with_badge(&icon, w, h, [1, 2, 3]);
        let px = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        assert_eq!(px(0, 0), &[10, 10, 10, 10], "top-left untouched");
        assert_eq!(px(23, 23), &[1, 2, 3, 255], "dot centre");
        assert_eq!(out.len(), icon.len());
    }

    #[test]
    fn idle_and_off_use_the_plain_icon() {
        assert_eq!(Status::Off.badge(), None);
        assert_eq!(Status::Idle.badge(), None);
        assert!(Status::Looking.badge().is_some());
        assert!(Status::Paused.tooltip().contains("paused"));
    }
}
