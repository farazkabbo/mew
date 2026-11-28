//! Explicit per-user native-host registration. No privileged installer, shell or browser policy.
use crate::browser_companion_protocol::HostConfig;
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
const HOST: &str = "com.neb.browser_companion";
unsafe extern "C" {
    fn geteuid() -> u32;
}
fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Unsafe browser host installation",
    )
}
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Browser {
    Chrome,
    Brave,
    Edge,
    Chromium,
    Firefox,
}
impl Browser {
    fn directory(self) -> &'static str {
        match self {
            Self::Chrome => "Google/Chrome/NativeMessagingHosts",
            Self::Brave => "BraveSoftware/Brave-Browser/NativeMessagingHosts",
            Self::Edge => "Microsoft Edge/NativeMessagingHosts",
            Self::Chromium => "Chromium/NativeMessagingHosts",
            Self::Firefox => "Mozilla/NativeMessagingHosts",
        }
    }
}
fn directory(base: &Path, relative: &str, create: bool) -> io::Result<PathBuf> {
    let mut current = base.to_path_buf();
    for part in std::iter::once("").chain(relative.split('/')) {
        if !part.is_empty() {
            current.push(part);
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir(&current)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                fs::symlink_metadata(&current)?
            }
            Err(e) => return Err(e),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { geteuid() }
            || metadata.mode() & 0o022 != 0
        {
            return Err(refused());
        }
    }
    Ok(current)
}
fn helper() -> io::Result<PathBuf> {
    let app = std::env::current_exe()?.canonicalize()?;
    if app.file_name().and_then(|s| s.to_str()) != Some("mew-desktop")
        || app
            .parent()
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            != Some("MacOS")
        || app
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            != Some("Contents")
    {
        return Err(refused());
    }
    let host = app.with_file_name("neb-browser-host");
    let m = fs::symlink_metadata(&host)?;
    if !m.is_file() || m.file_type().is_symlink() || m.mode() & 0o111 == 0 {
        return Err(refused());
    }
    Ok(host)
}
fn manifest(browser: Browser, host: &Path) -> io::Result<serde_json::Value> {
    let config: HostConfig =
        serde_json::from_str(include_str!("../browser-companion.json")).map_err(|_| refused())?;
    config.validate().map_err(|_| refused())?;
    let mut value = serde_json::json!({"name":HOST,"description":"Neb local browser companion", "path":host,"type":"stdio"});
    if matches!(browser, Browser::Firefox) {
        value["allowed_extensions"] = serde_json::json!(config.firefox_addon_ids);
    } else {
        value["allowed_origins"] = serde_json::json!(config
            .chrome_extension_ids
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect::<Vec<_>>());
    }
    Ok(value)
}
fn read_owned(path: &Path) -> io::Result<serde_json::Value> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != unsafe { geteuid() }
        || m.nlink() != 1
        || m.mode() & 0o022 != 0
        || m.len() > 8192
    {
        return Err(refused());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x100)
        .open(path)?; // O_NOFOLLOW
    let opened = file.metadata()?;
    if opened.ino() != m.ino() || opened.dev() != m.dev() {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
fn registration(base: &Path, browser: Browser, host: &Path, install: bool) -> io::Result<()> {
    let dir = directory(base, browser.directory(), install)?;
    let path = dir.join(format!("{HOST}.json"));
    let expected = manifest(browser, host)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            // Never adopt or replace an unrelated registration, even at our host name.
            if read_owned(&path)? != expected {
                return Err(refused());
            }
            if !install {
                fs::remove_file(path)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if !install {
                return Ok(());
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            let result = file
                .write_all(&serde_json::to_vec_pretty(&expected).map_err(|_| refused())?)
                .and_then(|_| file.sync_all());
            if result.is_err() {
                let _ = fs::remove_file(path);
            }
            result
        }
        Err(e) => Err(e),
    }
}
pub fn set(browser: Browser, install: bool) -> io::Result<()> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(refused)?;
    // Check every user-controlled ancestor, not only the final NativeMessagingHosts folder.
    let base = directory(&home, "Library/Application Support", false)?;
    registration(&base, browser, &helper()?, install)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_is_exact_idempotent_and_refuses_foreign_files_and_symlinks() {
        let base =
            std::env::temp_dir().join(format!("neb-host-registration-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let host = Path::new("/Applications/Neb.app/Contents/MacOS/neb-browser-host");
        registration(&base, Browser::Chrome, host, true).unwrap();
        registration(&base, Browser::Chrome, host, true).unwrap();
        let path = base
            .join(Browser::Chrome.directory())
            .join(format!("{HOST}.json"));
        let value = read_owned(&path).unwrap();
        assert_eq!(
            value["allowed_origins"][0],
            "chrome-extension://pfhbenfkaplnblkoejeeonadkbajcamk/"
        );
        fs::write(&path, b"{}").unwrap();
        assert!(registration(&base, Browser::Chrome, host, true).is_err());
        assert!(registration(&base, Browser::Chrome, host, false).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(base.join("missing"), &path).unwrap();
        assert!(registration(&base, Browser::Chrome, host, true).is_err());
        fs::remove_file(&path).unwrap();
        registration(&base, Browser::Chrome, host, true).unwrap();
        registration(&base, Browser::Chrome, host, false).unwrap();
        assert!(!path.exists());
        registration(&base, Browser::Firefox, host, true).unwrap();
        let value = read_owned(
            &base
                .join(Browser::Firefox.directory())
                .join(format!("{HOST}.json")),
        )
        .unwrap();
        assert!(value.get("allowed_origins").is_none());
        assert_eq!(value["allowed_extensions"][0], "neb-companion@neb.app");
        fs::remove_dir_all(base).unwrap();
    }
}
