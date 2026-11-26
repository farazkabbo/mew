//! Shared allowlisted model input vocabulary. Native implementations map these to OS keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    Left,
    Right,
}

/// A key or shortcut Neb's hand may press: moving about, and a few shortcuts that open or find
/// something. Nothing that closes, deletes, cuts, pastes, sends or runs (no Alt+F4, Ctrl+W,
/// Delete, Ctrl+Enter, Win+R). The same list as `SCREEN_ACT_KEYS` in
/// packages/shared/src/screen-act.ts; anything else in a reply doesn't parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlainKey {
    Enter,
    Escape,
    Tab,
    Backspace,
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Home,
    End,
    F5,
    /// The Start menu.
    Windows,
    #[serde(rename = "shift+tab")]
    ShiftTab,
    /// Back.
    #[serde(rename = "alt+left")]
    AltLeft,
    #[serde(rename = "ctrl+home")]
    CtrlHome,
    #[serde(rename = "ctrl+end")]
    CtrlEnd,
    /// A browser's address bar.
    #[serde(rename = "ctrl+l")]
    CtrlL,
    /// A new browser tab.
    #[serde(rename = "ctrl+t")]
    CtrlT,
    /// Find.
    #[serde(rename = "ctrl+f")]
    CtrlF,
    /// A new document or window.
    #[serde(rename = "ctrl+n")]
    CtrlN,
    /// Save.
    #[serde(rename = "ctrl+s")]
    CtrlS,
}

impl PlainKey {
    /// As it's said in the history ("Pressed Ctrl+L.").
    pub fn name(self) -> &'static str {
        match self {
            Self::Enter => "Enter",
            Self::Escape => "Escape",
            Self::Tab => "Tab",
            Self::Backspace => "Backspace",
            Self::Up => "Up",
            Self::Down => "Down",
            Self::Left => "Left",
            Self::Right => "Right",
            Self::PageUp => "Page Up",
            Self::PageDown => "Page Down",
            Self::Home => "Home",
            Self::End => "End",
            Self::F5 => "F5",
            Self::Windows => "the Windows key",
            Self::ShiftTab => "Shift+Tab",
            Self::AltLeft => "Alt+Left",
            Self::CtrlHome => "Ctrl+Home",
            Self::CtrlEnd => "Ctrl+End",
            Self::CtrlL => "Ctrl+L",
            Self::CtrlT => "Ctrl+T",
            Self::CtrlF => "Ctrl+F",
            Self::CtrlN => "Ctrl+N",
            Self::CtrlS => "Ctrl+S",
        }
    }
}
