//! System state Screen Coach respects: microphone permission, calls and screen sharing, and
//! the display preferences ink follows (animations, contrast themes).
//!
//! Microphone permission and use come from Windows' capability consent store in the registry
//! (what Settings → Privacy & security → Microphone shows). It isn't a documented API, so it is
//! read defensively: anything unreadable counts as "unknown", never as a reason to capture.

use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
use windows::Win32::Graphics::Gdi::{GetSysColor, COLOR_HIGHLIGHT};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_QWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SW_SHOWNORMAL,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

use crate::screen::privacy::MicAccess;

const MIC_STORE: PCWSTR = w!(
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
);
const MIC_STORE_DESKTOP_APPS: PCWSTR = w!(
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged"
);
const MIC_STORE_MACHINE: PCWSTR = w!(
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
);

/// Apps that record or stream the screen: while one runs, Screen Coach stays out of the way.
const SCREEN_RECORDERS: &[&str] = &[
    "obs64.exe",
    "obs32.exe",
    "obs.exe",
    "streamlabs obs.exe",
    "xsplit.core.exe",
    "camtasiarecorder.exe",
    "sharex.exe",
];

/// Microphone access for desktop apps (device-wide, this user, and desktop apps).
pub fn mic_access() -> MicAccess {
    let settings = [
        read_string(HKEY_LOCAL_MACHINE, MIC_STORE_MACHINE, w!("Value")),
        read_string(HKEY_CURRENT_USER, MIC_STORE, w!("Value")),
        read_string(HKEY_CURRENT_USER, MIC_STORE_DESKTOP_APPS, w!("Value")),
    ];
    mic_access_from(&settings)
}

/// "Deny" anywhere wins; all three readable and none "Deny" is allowed.
pub fn mic_access_from(values: &[Option<String>]) -> MicAccess {
    if values
        .iter()
        .flatten()
        .any(|value| value.eq_ignore_ascii_case("deny"))
    {
        MicAccess::Denied
    } else if values.iter().all(Option::is_some) {
        MicAccess::Allowed
    } else {
        MicAccess::Unknown
    }
}

/// True while a call or screen recording is likely running: another app holds the microphone
/// right now, or a screen recorder is open. Our own microphone use (in WebView2) doesn't count.
pub fn call_or_recording_in_progress() -> bool {
    other_app_using_mic() || screen_recorder_running()
}

/// Another app is using the microphone at this moment. Desktop apps are listed under
/// `NonPackaged`; Store apps (including the new Teams) directly under the microphone key.
fn other_app_using_mic() -> bool {
    [MIC_STORE_DESKTOP_APPS, MIC_STORE].into_iter().any(|path| {
        let Some(store) = open_key(HKEY_CURRENT_USER, path) else {
            return false;
        };
        subkey_names(store.0)
            .iter()
            .filter(|name| name.as_str() != "NonPackaged" && !is_own_mic_entry(name))
            .any(|name| {
                let start = read_qword(store.0, name, w!("LastUsedTimeStart"));
                let stop = read_qword(store.0, name, w!("LastUsedTimeStop"));
                matches!((start, stop), (Some(start), Some(stop)) if mic_in_use(start, stop))
            })
    })
}

/// Windows records when an app started and stopped using the microphone; a start with no
/// later stop means it's using it now.
pub fn mic_in_use(start: u64, stop: u64) -> bool {
    start > 0 && (stop == 0 || stop < start)
}

/// Entries for our own process or the WebView2 runtime (where Mew's own voice input runs).
/// Key names are executable paths with `#` instead of `\`.
pub fn is_own_mic_entry(key_name: &str) -> bool {
    let exe = key_name
        .rsplit(['#', '\\'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    let own = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
    });
    exe == "msedgewebview2.exe" || own.is_some_and(|own| own == exe)
}

fn screen_recorder_running() -> bool {
    running_process_names()
        .iter()
        .any(|name| SCREEN_RECORDERS.contains(&name.as_str()))
}

/// Lowercase executable names of every running process.
fn running_process_names() -> Vec<String> {
    let mut names = Vec::new();
    // SAFETY: a process snapshot, read with a correctly sized entry and closed at the end.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase());
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

/// How this computer appears in the account's "Signed-in devices" list, e.g. "DESKTOP-1A2B (Windows)".
pub fn device_name() -> String {
    let mut buffer = [0u16; 256];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer and its length in characters are passed together.
    let name = match unsafe {
        GetComputerNameExW(
            ComputerNameDnsHostname,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut len,
        )
    } {
        Ok(()) => String::from_utf16_lossy(&buffer[..len as usize]),
        Err(_) => "This computer".to_owned(),
    };
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    format!("{} (Windows)", name.trim())
}

/// Opens Windows Settings at the microphone privacy page (a fixed URI, never from a page).
pub fn open_microphone_settings() {
    // SAFETY: a fixed, constant URI opened with the default handler.
    unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            w!("ms-settings:privacy-microphone"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
}

// ─── Registry helpers ──────────────────────────────────────────────────────────────────────────

/// An open registry key, closed when dropped.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the key was opened by `open_key` and is closed once.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn open_key(root: HKEY, path: PCWSTR) -> Option<Key> {
    let mut key = HKEY::default();
    // SAFETY: read-only open with a valid out pointer.
    (unsafe { RegOpenKeyExW(root, path, None, KEY_READ, &mut key) } == ERROR_SUCCESS)
        .then_some(Key(key))
}

fn subkey_names(key: HKEY) -> Vec<String> {
    let mut names = Vec::new();
    let mut buffer = [0u16; 512];
    for index in 0..4096 {
        let mut len = buffer.len() as u32;
        // SAFETY: the buffer and its length in characters are passed together.
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            )
        };
        if status != ERROR_SUCCESS {
            break;
        }
        names.push(String::from_utf16_lossy(&buffer[..len as usize]));
    }
    names
}

fn read_string(root: HKEY, path: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buffer = [0u16; 64];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the buffer and its size in bytes are passed together; RRF_RT_REG_SZ only.
    let status = unsafe {
        RegGetValueW(
            root,
            path,
            value,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

fn read_qword(key: HKEY, subkey: &str, value: PCWSTR) -> Option<u64> {
    let subkey = HSTRING::from(subkey);
    let mut data = 0u64;
    let mut size = std::mem::size_of::<u64>() as u32;
    // SAFETY: an 8-byte out buffer with its size; RRF_RT_REG_QWORD only.
    let status = unsafe {
        RegGetValueW(
            key,
            &subkey,
            value,
            RRF_RT_REG_QWORD,
            None,
            Some((&mut data as *mut u64).cast()),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(data)
}

/// Opens an https link in the default browser (a link the web page opened in a new window).
/// Anything else is refused: no files, no other schemes, nothing with credentials in it.
pub fn open_in_browser(url: &tauri::Url) -> bool {
    if !is_openable(url) {
        return false;
    }
    let target = HSTRING::from(url.as_str());
    // SAFETY: plain strings that outlive the call; "open" on an https URL starts the browser.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success as a value above 32.
    result.0 as isize > 32
}

/// Opens a pinned playlist or album in the Spotify app (`spotify:playlist:<id>`). Nothing else:
/// the URI must be exactly one a pin makes. False if Spotify isn't installed (then the caller
/// opens the web link instead).
pub fn open_spotify(uri: &str) -> bool {
    if !crate::screen::music::parse_link(uri).is_some_and(|_| uri.starts_with("spotify:")) {
        return false;
    }
    let target = HSTRING::from(uri);
    // SAFETY: plain strings that outlive the call; "open" hands the URI to its registered app.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

/// https, a host, and no user name or password.
pub fn is_openable(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
}

/// Windows Settings → Accessibility → Visual effects → "Animation effects".
pub fn animations_enabled() -> bool {
    let mut enabled = windows::core::BOOL(1);
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes a BOOL to the pointer.
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled as *mut windows::core::BOOL).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    result.is_err() || enabled.as_bool()
}

/// A contrast theme is on: use the system highlight colour instead of our violet.
pub fn high_contrast() -> bool {
    let mut info = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is valid with cbSize set, as SPI_GETHIGHCONTRAST requires.
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            info.cbSize,
            Some((&mut info as *mut HIGHCONTRASTW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    result.is_ok() && info.dwFlags.0 & HCF_HIGHCONTRASTON.0 != 0
}

/// The system highlight colour as "#rrggbb" when a contrast theme is on (ink then uses it
/// instead of our violet, brief §4.3); None otherwise.
pub fn contrast_highlight() -> Option<String> {
    if !high_contrast() {
        return None;
    }
    // SAFETY: reads a system colour; no pointers.
    let colour = unsafe { GetSysColor(COLOR_HIGHLIGHT) };
    let [r, g, b] = [colour & 0xFF, (colour >> 8) & 0xFF, (colour >> 16) & 0xFF];
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_deny_turns_the_microphone_off() {
        let allow = || Some("Allow".to_owned());
        assert_eq!(
            mic_access_from(&[allow(), allow(), allow()]),
            MicAccess::Allowed
        );
        assert_eq!(
            mic_access_from(&[allow(), Some("Deny".into()), allow()]),
            MicAccess::Denied
        );
        assert_eq!(
            mic_access_from(&[None, allow(), Some("deny".into())]),
            MicAccess::Denied
        );
        assert_eq!(
            mic_access_from(&[None, allow(), allow()]),
            MicAccess::Unknown
        );
    }

    #[test]
    fn in_use_means_started_and_not_stopped_since() {
        assert!(mic_in_use(200, 0));
        assert!(mic_in_use(200, 100));
        assert!(!mic_in_use(100, 200));
        assert!(!mic_in_use(0, 0));
    }

    #[test]
    fn our_own_voice_input_is_not_a_call() {
        assert!(is_own_mic_entry(
            "C:#Program Files (x86)#Microsoft#EdgeWebView#Application#131.0#msedgewebview2.exe"
        ));
        assert!(!is_own_mic_entry(
            "C:#Users#me#AppData#Local#Microsoft#Teams#current#ms-teams.exe"
        ));
        assert!(!is_own_mic_entry("C:#Program Files#Zoom#bin#Zoom.exe"));
    }

    #[test]
    fn reads_this_machines_settings_without_failing() {
        // Whatever this PC's settings are, reading them must not panic or block.
        let _ = mic_access();
        let _ = call_or_recording_in_progress();
    }
}
