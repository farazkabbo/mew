//! Typing text into the app in front, as if from the keyboard (typing into a document,
//! `screen_write.rs`): `SendInput` with Unicode key events, one character at a time at about a
//! fast typist's pace, with the small pauses a person makes after a comma, a sentence and a
//! paragraph, so the student watches it being written rather than pasted.
//!
//! Typing stops at once if the window in front changes, or the student presses Esc. It never
//! starts while a modifier key is held (Ctrl or Alt with a letter would be a shortcut), and the
//! only keys it ever sends besides characters are Enter (a new line) and Tab.

use std::time::{Duration, Instant};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU,
    VK_RETURN, VK_RWIN, VK_SHIFT, VK_TAB,
};

use super::input::foreground;

/// How long to wait for the student to let go of Ctrl, Alt, Shift or Windows.
const MODIFIER_WAIT: Duration = Duration::from_secs(3);

/// How typing ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typed {
    All,
    /// Stopped part way: the window in front changed.
    WindowChanged,
    /// Stopped part way: the student pressed Esc.
    Cancelled,
    /// Never started: a modifier key stayed down.
    KeysHeld,
    /// Windows refused the keys (an app running as administrator ignores them).
    Refused,
}

/// One key: a character, or Enter or Tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Unit(u16),
    Virtual(u16),
}

/// The keys for `text`: UTF-16 units, Enter for each new line, Tab for tabs. Other control
/// characters are dropped (the server never sends them; this is the last guard).
pub fn keys_for(text: &str) -> Vec<Key> {
    let mut keys = Vec::with_capacity(text.len());
    let mut buf = [0u16; 2];
    for c in text.chars() {
        match c {
            '\n' => keys.push(Key::Virtual(VK_RETURN.0)),
            '\t' => keys.push(Key::Virtual(VK_TAB.0)),
            c if c.is_control() => {}
            c => keys.extend(c.encode_utf16(&mut buf).iter().map(|&u| Key::Unit(u))),
        }
    }
    keys
}

fn down(key: VIRTUAL_KEY) -> bool {
    // SAFETY: a plain value argument; reads the key's state only.
    let state = unsafe { GetAsyncKeyState(i32::from(key.0)) };
    state < 0
}

fn modifiers_down() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .into_iter()
        .any(down)
}

fn event(key: Key, up: bool) -> INPUT {
    let (vk, scan, mut flags) = match key {
        Key::Unit(unit) => (VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE),
        Key::Virtual(vk) => (VIRTUAL_KEY(vk), 0, KEYBD_EVENT_FLAGS(0)),
    };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Types into one window as the text arrives, a key at a time.
pub struct Typist {
    /// A raw HWND from `input::foreground`: it must stay in front.
    window: isize,
    /// The state of a small random generator (the pauses vary a little, like a person's).
    roll: u32,
}

impl Typist {
    /// Ready to type into `window`, once the student has let go of Ctrl, Alt, Shift and Windows
    /// (with one held, a letter would be a shortcut).
    pub fn start(window: isize) -> Result<Self, Typed> {
        if !modifiers_released() {
            return Err(Typed::KeysHeld);
        }
        // Clears Esc's "pressed since" bit, so only a press from now on cancels.
        // SAFETY: a plain value argument; reads the key's state only.
        let _ = unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) };
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0x9e37_79b9, |since| since.subsec_nanos());
        Ok(Self {
            window,
            roll: seed | 1,
        })
    }

    /// Types `text`, stopping at once if another window comes in front or Esc is pressed.
    pub fn type_text(&mut self, text: &str) -> Typed {
        let mut buf = [0u8; 4];
        for c in text.chars() {
            if foreground() != self.window {
                return Typed::WindowChanged;
            }
            // SAFETY: as above.
            if unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) } as u16 & 0x8001 != 0 {
                return Typed::Cancelled;
            }
            // A shortcut of the student's own, part way through: wait for it to end.
            if !modifiers_released() {
                return Typed::KeysHeld;
            }
            let inputs: Vec<INPUT> = keys_for(c.encode_utf8(&mut buf))
                .into_iter()
                .flat_map(|key| [event(key, false), event(key, true)])
                .collect();
            if inputs.is_empty() {
                continue;
            }
            // SAFETY: `inputs` is a valid slice of initialised INPUT structs for the call, and
            // the size passed is that of one INPUT, as the API requires.
            let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
            if sent as usize != inputs.len() {
                return Typed::Refused;
            }
            std::thread::sleep(pause_after(c, self.next()));
        }
        Typed::All
    }

    /// The next random number (xorshift: plenty for varying a pause).
    fn next(&mut self) -> u32 {
        self.roll ^= self.roll << 13;
        self.roll ^= self.roll >> 17;
        self.roll ^= self.roll << 5;
        self.roll
    }
}

/// Waits for Ctrl, Alt, Shift and Windows to be up; false if one stays down.
fn modifiers_released() -> bool {
    let waited = Instant::now();
    while modifiers_down() {
        if waited.elapsed() >= MODIFIER_WAIT {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// How long to wait after typing `c` (`roll`: any number, for the variation): 8 to 21 ms for a
/// letter, about 70 characters a second, with a breath after a comma, a longer one after a
/// sentence, and the longest at a new paragraph.
pub fn pause_after(c: char, roll: u32) -> Duration {
    let key = 8 + roll % 14;
    let breath = match c {
        '\n' => 160 + (roll >> 8) % 120,
        '.' | '!' | '?' => 80 + (roll >> 8) % 90,
        ',' | ';' | ':' => 35 + (roll >> 8) % 40,
        // Now and then, a word takes a moment to come.
        ' ' if (roll >> 4).is_multiple_of(19) => 90 + (roll >> 8) % 110,
        _ => 0,
    };
    Duration::from_millis(u64::from(key + breath))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_lines_are_enter_and_other_controls_are_dropped() {
        assert_eq!(
            keys_for("a\nb\tc\u{1b}"),
            vec![
                Key::Unit(u16::from(b'a')),
                Key::Virtual(VK_RETURN.0),
                Key::Unit(u16::from(b'b')),
                Key::Virtual(VK_TAB.0),
                Key::Unit(u16::from(b'c')),
            ]
        );
    }

    #[test]
    fn types_at_a_persons_pace_with_breaths_at_punctuation() {
        let ms = |c, roll| pause_after(c, roll).as_millis();
        for roll in [0u32, 1, 13, 255, 4096, 0xdead_beef, u32::MAX] {
            // A letter: quick, and never instant.
            assert!((8..=21).contains(&ms('a', roll)), "{roll}");
            // Longer after a comma, longer still after a sentence, longest at a new paragraph.
            assert!(ms(',', roll) >= 43);
            assert!(ms('.', roll) >= 88);
            assert!(ms('\n', roll) >= 168);
            assert!(ms('\n', roll) <= 301);
        }
        // An essay of 2,500 characters takes well under a minute and a half.
        let total: u128 = (0..2500u32)
            .map(|i| {
                ms(
                    if i % 6 == 5 { ' ' } else { 'e' },
                    i.wrapping_mul(2_654_435_761),
                )
            })
            .sum();
        assert!((20_000..90_000).contains(&total), "{total}");
    }

    #[test]
    fn characters_beyond_the_basic_plane_are_two_units() {
        assert_eq!(keys_for("é∑😀").len(), 4);
    }
}
