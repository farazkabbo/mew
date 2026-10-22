//! The privacy layer (S1): what Screen Coach must check before it looks, and what it covers
//! before anything leaves the device. Pure logic here; the Windows lookups are in `screen::win`.
//!
//! Order of checks for every capture (brief §7):
//!   1. microphone access off → no capture
//!   2. a call or screen share is running (setting, on by default) → no capture
//!   3. the app in front is blocked, unidentifiable, or a private browser window → no capture
//!   4. a password field has keyboard focus (or we can't tell) → no capture
//!   5. capture, then (monitor scope) black out windows of blocked apps
//!   6. OCR the frame and cover sensitive text; if OCR fails, nothing is sent (fail closed)

pub mod blocklist;
pub mod detect;
pub mod private_window;
pub mod redact;

/// What we know just before capturing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Situation {
    pub mic: MicAccess,
    pub in_call: bool,
    pub pause_during_calls: bool,
    /// The app in front (lowercase executable name), or None for just the desktop.
    pub app: Option<String>,
    /// There is an app in front, but Windows wouldn't tell us which one.
    pub app_unreadable: bool,
    pub app_blocked: bool,
    pub private_window: bool,
    pub focus: Focus,
}

/// What has keyboard focus, as far as UI Automation can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Ordinary,
    /// A password or other protected field.
    Password,
    /// UI Automation couldn't tell us.
    Unknown,
}

/// Microphone access for desktop apps, from Windows' privacy settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicAccess {
    Allowed,
    /// Off for the whole device, for this user, or for desktop apps.
    Denied,
    /// The setting couldn't be read; voice will tell us soon enough, so we don't block on it.
    Unknown,
}

/// Why Screen Coach won't look, phrased for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    MicOff,
    InCall,
    BlockedApp(String),
    UnknownApp,
    PrivateWindow,
    PasswordField,
    CantCheckFocus,
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::MicOff => "Microphone access is off for desktop apps, so Screen Coach is paused. Turn it on in Windows Settings → Privacy & security → Microphone.".into(),
            Refusal::InCall => "Screen Coach is paused while you're in a call or sharing your screen.".into(),
            Refusal::BlockedApp(app) => format!("I can't look at {app} because it's on your blocked list."),
            Refusal::UnknownApp => "I can't tell which app this is, so I won't look at it.".into(),
            Refusal::PrivateWindow => "I don't look at private browsing windows.".into(),
            Refusal::PasswordField => "A password field is selected, so I won't look right now. Click somewhere else and ask again.".into(),
            Refusal::CantCheckFocus => "I couldn't check whether a password field is selected, so I won't look right now.".into(),
        }
    }
}

/// Decides whether Screen Coach may capture now. Any doubt is a "no" (fail closed).
pub fn may_capture(situation: &Situation) -> Result<(), Refusal> {
    if situation.mic == MicAccess::Denied {
        return Err(Refusal::MicOff);
    }
    if situation.pause_during_calls && situation.in_call {
        return Err(Refusal::InCall);
    }
    if situation.app_unreadable {
        return Err(Refusal::UnknownApp);
    }
    if let (true, Some(app)) = (situation.app_blocked, &situation.app) {
        return Err(Refusal::BlockedApp(app.clone()));
    }
    if situation.private_window {
        return Err(Refusal::PrivateWindow);
    }
    match situation.focus {
        Focus::Ordinary => Ok(()),
        Focus::Password => Err(Refusal::PasswordField),
        Focus::Unknown => Err(Refusal::CantCheckFocus),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fine() -> Situation {
        Situation {
            mic: MicAccess::Allowed,
            in_call: false,
            pause_during_calls: true,
            app: Some("excel.exe".into()),
            app_unreadable: false,
            app_blocked: false,
            private_window: false,
            focus: Focus::Ordinary,
        }
    }

    #[test]
    fn allows_an_ordinary_app_or_the_bare_desktop() {
        assert_eq!(may_capture(&fine()), Ok(()));
        assert_eq!(
            may_capture(&Situation {
                mic: MicAccess::Unknown,
                ..fine()
            }),
            Ok(())
        );
        assert_eq!(
            may_capture(&Situation {
                app: None,
                ..fine()
            }),
            Ok(())
        );
    }

    #[test]
    fn refuses_every_risky_situation() {
        let cases = [
            (
                Situation {
                    mic: MicAccess::Denied,
                    ..fine()
                },
                Refusal::MicOff,
            ),
            (
                Situation {
                    in_call: true,
                    ..fine()
                },
                Refusal::InCall,
            ),
            (
                Situation {
                    app: None,
                    app_unreadable: true,
                    ..fine()
                },
                Refusal::UnknownApp,
            ),
            (
                Situation {
                    app: Some("1password.exe".into()),
                    app_blocked: true,
                    ..fine()
                },
                Refusal::BlockedApp("1password.exe".into()),
            ),
            (
                Situation {
                    private_window: true,
                    ..fine()
                },
                Refusal::PrivateWindow,
            ),
            (
                Situation {
                    focus: Focus::Password,
                    ..fine()
                },
                Refusal::PasswordField,
            ),
            (
                Situation {
                    focus: Focus::Unknown,
                    ..fine()
                },
                Refusal::CantCheckFocus,
            ),
        ];
        for (situation, refusal) in cases {
            assert_eq!(may_capture(&situation), Err(refusal), "{situation:?}");
        }
    }

    #[test]
    fn calls_only_pause_when_the_setting_is_on() {
        assert_eq!(
            may_capture(&Situation {
                in_call: true,
                pause_during_calls: false,
                ..fine()
            }),
            Ok(())
        );
    }

    #[test]
    fn messages_are_friendly() {
        let message = Refusal::BlockedApp("bitwarden.exe".into()).message();
        assert!(message.contains("bitwarden.exe") && message.contains("blocked list"));
    }
}
