//! Account-local counts with fixed keys; no screen text, geometry, names or provider calls.
use crate::screen::cursor::telemetry::Counts;
use std::{io::Read, sync::Mutex};
use tauri::{AppHandle, Manager};
static FILE: Mutex<()> = Mutex::new(());
fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let stamp = super::service_call::credential_stamp(app).ok()?;
    let scope = stamp[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Some(
        app.path()
            .app_config_dir()
            .ok()?
            .join(format!("mac-cursor-counts-{scope}.json")),
    )
}
fn read(path: &std::path::Path) -> Counts {
    let mut text = String::new();
    let _ = std::fs::File::open(path).and_then(|f| f.take(16385).read_to_string(&mut text));
    if text.len() > 16384 {
        return Counts::default();
    }
    Counts::parse(&text)
}
pub fn view(app: &AppHandle) -> Counts {
    let _guard = FILE.lock().unwrap_or_else(|p| p.into_inner());
    path(app).map(|p| read(&p)).unwrap_or_default()
}
pub fn add(app: &AppHandle, key: &str) {
    if !crate::screen::cursor::telemetry::KEYS.contains(&key) {
        return;
    }
    let Some(path) = path(app) else {
        return;
    };
    let _guard = FILE.lock().unwrap_or_else(|p| p.into_inner());
    let mut counts = read(&path);
    let entry = counts.0.entry(key.into()).or_default();
    *entry = entry.saturating_add(1);
    if let Ok(bytes) = serde_json::to_vec(&counts) {
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, bytes).is_ok() {
            let _ = std::fs::rename(temp, path);
        }
    }
}
