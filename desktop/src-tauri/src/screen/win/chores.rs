//! DO IT's Windows side (docs/CURSOR_MODES.md, F): the Windows Search index, File Explorer's
//! selection, opening a document or a Settings page, dark or light mode (two registry values
//! under the current user, as Settings writes them), and the confirmation dialogs.
//!
//! The two helpers (the index and Explorer's selection) are fixed PowerShell scripts, run the way
//! `launch.rs` runs `Get-StartApps`: no window, no profile, no console input, and their only
//! inputs come through environment variables (a query built from checked words, a window handle
//! as a number), never through the command line or the script's text. They read; they change
//! nothing. Nothing they return is logged.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, WPARAM};
use windows::Win32::System::Registry::{
    RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD,
};
use windows::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDCBF_CANCEL_BUTTON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_SIZE_TO_CONTENT,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, SW_SHOWNORMAL, WM_SETTINGCHANGE,
};

use crate::screen::cursor::find::{parse_found, runs_something, Found};
use crate::screen::cursor::rename::Photo;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Prints the list as JSON in plain ASCII (other characters as \uXXXX): with no console, the
/// output's code page can't be trusted with non-English file names.
const PRINT_ASCII_JSON: &str = r#"$json = ConvertTo-Json -InputObject $out -Compress
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })"#;

const SEARCH_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$r = New-Object -ComObject ADODB.Recordset
$r.Open($env:NEB_SEARCH_QUERY, $c)
$out = @()
while (-not $r.EOF -and $out.Count -lt 10) {
  $m = $r.Fields.Item('System.DateModified').Value
  $out += [pscustomobject]@{
    path = [string]$r.Fields.Item('System.ItemPathDisplay').Value
    modified = $(if ($m) { ([datetime]$m).ToString('s') } else { '' })
    rank = [double]$r.Fields.Item('System.Search.Rank').Value
  }
  $r.MoveNext()
}
$r.Close(); $c.Close()
"#;

const PHOTOS_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$h = [int64]$env:NEB_EXPLORER_WINDOW
$w = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.HWND -eq $h } | Select-Object -First 1
if (-not $w) { '[]'; exit }
$items = @($w.Document.SelectedItems())
if ($items.Count -eq 0) { $items = @($w.Document.Folder.Items()) }
$exts = '.jpg','.jpeg','.png','.heic','.heif','.gif','.webp','.tif','.tiff','.bmp','.dng','.nef','.cr2','.arw'
$out = @()
foreach ($i in $items) {
  if ($out.Count -ge 500) { break }
  if ($i.IsFolder) { continue }
  $p = [string]$i.Path
  if ($exts -notcontains [IO.Path]::GetExtension($p).ToLower()) { continue }
  $t = $i.ExtendedProperty('System.Photo.DateTaken')
  $m = $i.ExtendedProperty('System.DateModified')
  $out += [pscustomobject]@{
    path = $p
    taken = $(if ($t) { ([datetime]$t).ToString('s') } else { $null })
    modified = $(if ($m) { ([datetime]$m).ToString('s') } else { '' })
  }
}
"#;

/// The items selected in one Explorer window (files and folders), and nothing when none is:
/// a rename asked for in words never takes a whole folder's contents by itself.
const SELECTION_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$h = [int64]$env:NEB_EXPLORER_WINDOW
$w = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.HWND -eq $h } | Select-Object -First 1
if (-not $w) { '[]'; exit }
$out = @()
foreach ($i in @($w.Document.SelectedItems())) {
  if ($out.Count -ge 500) { break }
  $p = [string]$i.Path
  if ([IO.Path]::IsPathRooted($p)) { $out += [pscustomobject]@{ path = $p } }
}
"#;

/// The files and folders selected in the File Explorer window `window`.
pub fn explorer_selection(window: isize) -> Vec<PathBuf> {
    #[derive(serde::Deserialize)]
    struct Row {
        path: String,
    }
    let Some(out) = powershell(
        SELECTION_SCRIPT,
        ("NEB_EXPLORER_WINDOW", &window.to_string()),
    ) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out);
    let text = text.trim().trim_start_matches('\u{feff}');
    let rows: Vec<Row> = serde_json::from_str::<Vec<Row>>(text)
        .or_else(|_| serde_json::from_str::<Row>(text).map(|r| vec![r]))
        .unwrap_or_default();
    rows.into_iter()
        .filter(|r| !r.path.chars().any(char::is_control) && Path::new(&r.path).is_absolute())
        .map(|r| PathBuf::from(r.path))
        .collect()
}

fn powershell(script: &str, env: (&str, &str)) -> Option<Vec<u8>> {
    let script = format!("{script}{PRINT_ASCII_JSON}");
    // Passed encoded (UTF-16LE, base64): a script with quotes and line breaks can't survive the
    // command line's quoting otherwise, and nothing in it is ever interpreted by a shell.
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = Vec::with_capacity(crate::screen::base64::encoded_len(utf16.len()));
    crate::screen::base64::encode_into(&utf16, &mut out);
    let encoded = String::from_utf8(out).ok()?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .env(env.0, env.1)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// What the Windows Search index finds for `sql` (built by `find::search_sql`).
pub fn search_index(sql: &str) -> Vec<Found> {
    powershell(SEARCH_SCRIPT, ("NEB_SEARCH_QUERY", sql))
        .map(|out| parse_found(&out))
        .unwrap_or_default()
}

/// The photos selected in the File Explorer window `window` (all the photos in its folder when
/// none is selected), with when each was taken.
pub fn explorer_photos(window: isize) -> Vec<Photo> {
    #[derive(serde::Deserialize)]
    struct Row {
        path: String,
        taken: Option<String>,
        #[serde(default)]
        modified: String,
    }
    let Some(out) = powershell(PHOTOS_SCRIPT, ("NEB_EXPLORER_WINDOW", &window.to_string())) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out);
    let text = text.trim().trim_start_matches('\u{feff}');
    let rows: Vec<Row> = serde_json::from_str::<Vec<Row>>(text)
        .or_else(|_| serde_json::from_str::<Row>(text).map(|r| vec![r]))
        .unwrap_or_default();
    rows.into_iter()
        .filter(|r| !r.path.chars().any(char::is_control) && Path::new(&r.path).is_absolute())
        .map(|r| Photo {
            path: PathBuf::from(r.path),
            taken: r.taken,
            modified: r.modified,
        })
        .collect()
}

fn shell_open(target: &str) -> bool {
    // SAFETY: plain strings for the call's duration; no window owner.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(target),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

/// Opens a document in its own app; a file that would run something is only shown in its
/// folder (DO IT never runs anything).
pub fn open_document(path: &str) -> bool {
    if runs_something(path) || !Path::new(path).is_absolute() {
        return reveal(path);
    }
    shell_open(path)
}

/// Shows a file selected in its folder.
pub fn reveal(path: &str) -> bool {
    Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// Opens a Settings page by its `ms-settings:` address (from `settings_uri`, never the model).
pub fn open_settings(uri: &str) -> bool {
    uri.starts_with("ms-settings:")
        && uri[12..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-')
        && shell_open(uri)
}

/// Where Windows keeps the app and system theme (Settings → Personalization → Colors → "Choose
/// your mode" writes the same two values).
const PERSONALIZE: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");

fn read_light(value: PCWSTR) -> Option<bool> {
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: a 4-byte out buffer with its size; RRF_RT_REG_DWORD only.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some((&mut data as *mut u32).cast()),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(data != 0)
}

/// Dark mode is on for both apps and Windows. A value that isn't there (or can't be read)
/// means light, as Windows reads it.
pub fn dark_mode() -> bool {
    let apps = read_light(w!("AppsUseLightTheme")).unwrap_or(true);
    let system = read_light(w!("SystemUsesLightTheme")).unwrap_or(true);
    !apps && !system
}

/// Dark (or light) mode for apps and Windows, as "Choose your mode" sets it, then every window
/// is told the colours changed so it repaints now. No click or key is sent.
pub fn set_dark_mode(dark: bool) -> bool {
    let light = u32::from(!dark).to_le_bytes();
    let written = [w!("AppsUseLightTheme"), w!("SystemUsesLightTheme")]
        .iter()
        .all(|value| {
            // SAFETY: a 4-byte REG_DWORD from a live buffer, under the current user's key.
            let status = unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    PERSONALIZE,
                    *value,
                    REG_DWORD.0,
                    Some(light.as_ptr().cast()),
                    light.len() as u32,
                )
            };
            status == ERROR_SUCCESS
        });
    if written {
        let area = w!("ImmersiveColorSet");
        // SAFETY: a broadcast with a static string; hung windows are skipped after 1 s.
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(area.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                1_000,
                None,
            );
        }
    }
    written
}

const OK_ID: i32 = 1001;

/// A Neb dialog. `choices`: radio buttons (the first is chosen at first). Returns the choice
/// (0 without choices) if the student pressed `ok`, None if they cancelled or closed it.
pub fn dialog(
    main: &str,
    content: &str,
    details: Option<&str>,
    choices: &[String],
    ok: &str,
) -> Option<usize> {
    let (title, main, content) = (
        HSTRING::from("Neb"),
        HSTRING::from(main),
        HSTRING::from(content),
    );
    let details = details.map(HSTRING::from);
    let ok_text = HSTRING::from(ok);
    let buttons = [TASKDIALOG_BUTTON {
        nButtonID: OK_ID,
        pszButtonText: PCWSTR(ok_text.as_ptr()),
    }];
    let labels: Vec<HSTRING> = choices.iter().map(HSTRING::from).collect();
    let radios: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(i, label)| TASKDIALOG_BUTTON {
            nButtonID: 2000 + i as i32,
            pszButtonText: PCWSTR(label.as_ptr()),
        })
        .collect();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: HWND::default(),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        dwCommonButtons: TDCBF_CANCEL_BUTTON,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszMainInstruction: PCWSTR(main.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        // A change is never the default: Enter cancels.
        nDefaultButton: if choices.is_empty() { 2 } else { OK_ID },
        cRadioButtons: radios.len() as u32,
        pRadioButtons: if radios.is_empty() {
            std::ptr::null()
        } else {
            radios.as_ptr()
        },
        nDefaultRadioButton: 2000,
        pszExpandedInformation: details
            .as_ref()
            .map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
        ..Default::default()
    };
    let (mut button, mut radio) = (0i32, 0i32);
    // SAFETY: every string and array the config points to lives until this call returns.
    let shown = unsafe { TaskDialogIndirect(&config, Some(&mut button), Some(&mut radio), None) };
    (shown.is_ok() && button == OK_ID).then(|| usize::try_from(radio - 2000).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_settings_addresses_open_as_settings() {
        // Refused before Windows is asked (no page is opened by this test).
        assert!(!open_settings("https://example.com"));
        assert!(!open_settings("ms-settings:colors & calc"));
        assert!(!open_settings("ms-settings:../../x"));
    }

    /// Live: the Windows Search index answers a harmless query (ignored by default; it reads
    /// this computer's index and prints only a count).
    #[test]
    #[ignore]
    fn the_index_answers() {
        use crate::screen::cursor::find::{search_sql, terms};
        use crate::screen::cursor::plan::FileKind;
        let sql = search_sql(&terms("readme"), FileKind::Any, None).unwrap();
        let started = std::time::Instant::now();
        let found = search_index(&sql);
        println!("index: {} results in {:?}", found.len(), started.elapsed());
    }
}
