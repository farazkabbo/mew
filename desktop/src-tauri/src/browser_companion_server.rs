//! Local browser relay broker. This module grants transport trust only, never capture authority.
use crate::{browser_companion_auth as auth, browser_companion_protocol as wire};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    sync::{atomic::AtomicUsize, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
const MAX_CLIENTS: usize = 8;
const MAX_PAIRINGS: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const PAIR_TIMEOUT: Duration = Duration::from_secs(60);
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Browser connection refused",
    )
}
fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "Browser connection unavailable",
    )
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid browser connection data",
    )
}
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    // OS randomness only; errors never produce a predictable capability.
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_err()
    {
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pairing {
    pub pairing_id: String,
    pub browser_identifier: String,
    pub team: String,
    pub origin: String,
    pub profile_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPair {
    pub connection_id: String,
    pub browser_pid: i32,
    pub browser_identifier: String,
    pub team: String,
    pub signer: String,
    pub origin: String,
    pub profile_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connection_id: String,
    pub browser_pid: i32,
    pub browser_identifier: String,
    pub profile_id: String,
    pub trusted: bool,
}
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub window_id: Option<i64>,
    pub tab_id: Option<i64>,
    pub document_id: Option<String>,
    pub media_id: Option<String>,
    pub action: Option<wire::Action>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u8,
    pairings: Vec<Pairing>,
}
fn same_identity(a: &Pairing, b: &Pairing) -> bool {
    a.browser_identifier == b.browser_identifier
        && a.team == b.team
        && a.origin == b.origin
        && a.profile_id == b.profile_id
}
fn bounded_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn valid_registry(r: &Registry) -> bool {
    r.version == 1
        && r.pairings.len() <= MAX_PAIRINGS
        && r.pairings.iter().enumerate().all(|(i, p)| {
            wire::is_id(&p.pairing_id)
                && wire::is_id(&p.profile_id)
                && auth::browser_identifier(&p.browser_identifier)
                && bounded_text(&p.team, 128)
                && bounded_text(&p.origin, 512)
                && r.pairings[..i]
                    .iter()
                    .all(|prior| prior.pairing_id != p.pairing_id && !same_identity(prior, p))
        })
}
unsafe extern "C" {
    fn geteuid() -> u32;
}
fn secure_metadata(path: &Path, directory: bool) -> io::Result<()> {
    let m = fs::symlink_metadata(path)?;
    let kind = if directory {
        m.is_dir()
    } else {
        m.is_file() && m.nlink() == 1
    };
    if !kind
        || m.uid() != unsafe { geteuid() }
        || m.permissions().mode() & 0o777 != if directory { 0o700 } else { 0o600 }
    {
        return Err(denied());
    }
    Ok(())
}
fn load_registry(path: &Path) -> io::Result<Registry> {
    if !path.try_exists()? {
        return Ok(Registry {
            version: 1,
            pairings: vec![],
        });
    }
    secure_metadata(path, false)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x100)
        .open(path)?; // O_NOFOLLOW, macOS SDK.
    let before = fs::symlink_metadata(path)?;
    let opened = file.metadata()?;
    if before.ino() != opened.ino() || before.dev() != opened.dev() || opened.len() > 32_768 {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    file.take(32_769).read_to_end(&mut bytes)?;
    if bytes.len() > 32_768 {
        return Err(invalid());
    }
    let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !valid_registry(&registry) {
        return Err(invalid());
    }
    Ok(registry)
}
fn store_registry(path: &Path, registry: &Registry) -> io::Result<()> {
    if !valid_registry(registry) {
        return Err(invalid());
    }
    let parent = path.parent().ok_or_else(denied)?;
    secure_metadata(parent, true)?;
    if fs::symlink_metadata(path).is_ok() {
        secure_metadata(path, false)?;
    }
    let id = random_id();
    if !wire::is_id(&id) {
        return Err(unavailable());
    }
    let temp = parent.join(format!(".browser-pairings-{id}.tmp"));
    let result = (|| {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        let bytes = serde_json::to_vec(registry).map_err(|_| invalid())?;
        if bytes.len() > 32_768 {
            return Err(invalid());
        }
        out.write_all(&bytes)?;
        out.sync_all()?;
        fs::rename(&temp, path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
pub type Gate = Arc<dyn Fn() -> bool + Send + Sync>;
struct Work {
    request: wire::Request,
    deadline: Instant,
    reply: mpsc::SyncSender<io::Result<wire::Response>>,
    gate: Option<Gate>,
}
impl Work {
    fn live(&self) -> bool {
        Instant::now() < self.deadline
            && self.gate.as_ref().is_none_or(|current| current())
            && (self.request.operation != wire::Operation::Control || self.gate.is_some())
    }
}
struct Connection {
    peer: auth::BrowserPeer,
    identity: Pairing,
    pair_requested: bool,
    pending_until: Instant,
    queue: mpsc::SyncSender<Work>,
    socket: UnixStream,
}
struct State {
    registry: Registry,
    connections: HashMap<String, Connection>,
}
pub struct Server {
    registry_path: PathBuf,
    socket_path: PathBuf,
    socket_inode: u64,
    state: Mutex<State>,
    clients: AtomicUsize,
}
impl Server {
    pub fn pending(&self) -> Vec<PendingPair> {
        let Ok(state) = self.state.lock() else {
            return vec![];
        };
        state
            .connections
            .iter()
            .filter(|(_, c)| {
                c.pair_requested
                    && c.pending_until > Instant::now()
                    && auth::browser_alive(&c.peer)
                    && !trusted(&state.registry, &c.identity)
            })
            .map(|(id, c)| PendingPair {
                connection_id: id.clone(),
                browser_pid: c.peer.pid,
                browser_identifier: c.peer.identifier.clone(),
                team: c.peer.team.clone(),
                signer: c.peer.signer.clone(),
                origin: c.identity.origin.clone(),
                profile_id: c.identity.profile_id.clone(),
            })
            .collect()
    }
    pub fn status(&self) -> Vec<ConnectionStatus> {
        let Ok(state) = self.state.lock() else {
            return vec![];
        };
        state
            .connections
            .iter()
            .filter(|(_, c)| auth::browser_alive(&c.peer))
            .map(|(id, c)| ConnectionStatus {
                connection_id: id.clone(),
                browser_pid: c.peer.pid,
                browser_identifier: c.peer.identifier.clone(),
                profile_id: c.identity.profile_id.clone(),
                trusted: trusted(&state.registry, &c.identity),
            })
            .collect()
    }
    pub fn pairings(&self) -> Vec<Pairing> {
        self.state
            .lock()
            .map(|s| s.registry.pairings.clone())
            .unwrap_or_default()
    }
    pub fn approve(&self, connection_id: &str) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        let c = state
            .connections
            .get(connection_id)
            .ok_or_else(unavailable)?;
        if !c.pair_requested || c.pending_until <= Instant::now() || !auth::browser_alive(&c.peer) {
            return Err(denied());
        }
        if trusted(&state.registry, &c.identity) {
            return Ok(());
        }
        let mut registry = Registry {
            version: 1,
            pairings: state.registry.pairings.clone(),
        };
        registry.pairings.push(c.identity.clone());
        store_registry(&self.registry_path, &registry)?;
        state.registry = registry;
        Ok(())
    }
    pub fn revoke_pairing(&self, pairing_id: &str) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        let Some(removed) = state
            .registry
            .pairings
            .iter()
            .find(|p| p.pairing_id == pairing_id)
            .cloned()
        else {
            return Err(unavailable());
        };
        let registry = Registry {
            version: 1,
            pairings: state
                .registry
                .pairings
                .iter()
                .filter(|p| p.pairing_id != pairing_id)
                .cloned()
                .collect(),
        };
        // Revoke in memory and stop I/O even if persistence fails; never re-enable this process's trust.
        state.registry = registry;
        state.connections.retain(|_, c| {
            if same_identity(&removed, &c.identity) {
                let _ = c.socket.shutdown(Shutdown::Both);
                false
            } else {
                true
            }
        });
        store_registry(&self.registry_path, &state.registry)
    }
    pub fn request(
        &self,
        connection_id: &str,
        generation: u64,
        operation: wire::Operation,
        target: Target,
    ) -> io::Result<wire::Response> {
        // Mutations must carry a native cancellation gate, not just an echoed number.
        if operation == wire::Operation::Control {
            return Err(denied());
        }
        self.request_with_gate(connection_id, generation, operation, target, None)
    }
    pub fn request_guarded(
        &self,
        connection_id: &str,
        generation: u64,
        target: Target,
        gate: Gate,
    ) -> io::Result<wire::Response> {
        self.request_with_gate(
            connection_id,
            generation,
            wire::Operation::Control,
            target,
            Some(gate),
        )
    }
    fn request_with_gate(
        &self,
        connection_id: &str,
        generation: u64,
        operation: wire::Operation,
        target: Target,
        gate: Option<Gate>,
    ) -> io::Result<wire::Response> {
        if gate.as_ref().is_some_and(|current| !current()) {
            return Err(denied());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let nonce = random_id();
        let (request, deadline) = {
            let state = self.state.lock().map_err(|_| unavailable())?;
            let c = state
                .connections
                .get(connection_id)
                .ok_or_else(unavailable)?;
            if !trusted(&state.registry, &c.identity) || !auth::browser_alive(&c.peer) {
                return Err(denied());
            }
            let request = wire::Request {
                version: wire::VERSION,
                nonce,
                generation,
                sequence: 1,
                profile_id: c.identity.profile_id.clone(),
                operation,
                window_id: target.window_id,
                tab_id: target.tab_id,
                document_id: target.document_id,
                media_id: target.media_id,
                action: target.action,
            };
            request.validate().map_err(|_| invalid())?;
            let deadline = Instant::now() + REQUEST_TIMEOUT;
            c.queue
                .try_send(Work {
                    request: request.clone(),
                    deadline,
                    reply: tx,
                    gate: gate.clone(),
                })
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::WouldBlock, "Browser request queue busy")
                })?;
            (request, deadline)
        };
        let response = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "Browser reply deadline exceeded")
            })??;
        let state = self.state.lock().map_err(|_| unavailable())?;
        let c = state
            .connections
            .get(connection_id)
            .ok_or_else(unavailable)?;
        if Instant::now() >= deadline
            || gate.as_ref().is_some_and(|current| !current())
            || !trusted(&state.registry, &c.identity)
            || !auth::browser_alive(&c.peer)
            || response.nonce != request.nonce
            || response.generation != generation
        {
            return Err(denied());
        }
        Ok(response)
    }
    fn current(&self, id: &str) -> bool {
        self.state.lock().is_ok_and(|s| {
            s.connections
                .get(id)
                .is_some_and(|c| trusted(&s.registry, &c.identity) && auth::browser_alive(&c.peer))
        })
    }
}
fn trusted(registry: &Registry, identity: &Pairing) -> bool {
    registry.pairings.iter().any(|p| same_identity(p, identity))
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(state) = self.state.lock() {
            for c in state.connections.values() {
                let _ = c.socket.shutdown(Shutdown::Both);
            }
        }
        if fs::symlink_metadata(&self.socket_path)
            .is_ok_and(|m| m.ino() == self.socket_inode && m.file_type().is_socket())
        {
            let _ = fs::remove_file(&self.socket_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pairing() -> Pairing {
        Pairing {
            pairing_id: "1".repeat(32),
            browser_identifier: "com.google.Chrome".into(),
            team: "SIGNEDTEAM".into(),
            origin: format!("chrome-extension://{}/", "a".repeat(32)),
            profile_id: "2".repeat(32),
        }
    }
    #[test]
    fn queued_control_requires_a_live_native_owner_at_dispatch() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let alive = Arc::new(AtomicBool::new(true));
        let owner = alive.clone();
        let (reply, _) = mpsc::sync_channel(1);
        let mut work = Work {
            request: wire::Request {
                version: 1,
                nonce: "1".repeat(32),
                generation: 3,
                sequence: 1,
                profile_id: "2".repeat(32),
                operation: wire::Operation::Control,
                window_id: Some(4),
                tab_id: Some(5),
                document_id: Some("3".repeat(32)),
                media_id: Some("4".repeat(32)),
                action: Some(wire::Action::Pause),
            },
            deadline: Instant::now() + Duration::from_secs(1),
            reply,
            gate: Some(Arc::new(move || owner.load(Ordering::Acquire))),
        };
        assert!(work.live());
        alive.store(false, Ordering::Release);
        assert!(!work.live());
        work.gate = None;
        assert!(!work.live());
        work.request.operation = wire::Operation::Probe;
        assert!(work.live());
        work.deadline = Instant::now();
        assert!(!work.live());
    }
    #[test]
    fn registry_requires_unique_bounded_exact_signing_and_profile_identity() {
        let p = pairing();
        assert!(valid_registry(&Registry {
            version: 1,
            pairings: vec![p.clone()]
        }));
        assert!(!valid_registry(&Registry {
            version: 2,
            pairings: vec![]
        }));
        assert!(!valid_registry(&Registry {
            version: 1,
            pairings: vec![p.clone(), p.clone()]
        }));
        let mut changed = p.clone();
        changed.team = "OTHERTEAM".into();
        assert!(!same_identity(&p, &changed));
        changed = p.clone();
        changed.profile_id = "3".repeat(32);
        assert!(!same_identity(&p, &changed));
        changed = p.clone();
        changed.origin.push_str("evil");
        assert!(!same_identity(&p, &changed));
        changed = p;
        changed.profile_id = "A".repeat(32);
        assert!(!valid_registry(&Registry {
            version: 1,
            pairings: vec![changed]
        }));
    }
    #[test]
    fn filesystem_boundary_refuses_symlinks_and_world_readable_pairings() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("neb-broker-test-{}", random_id()));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(secure_metadata(&dir, true).is_ok());
        let path = dir.join("registry");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(secure_metadata(&path, false).is_ok());
        let link = dir.join("link");
        symlink(&path, &link).unwrap();
        assert!(secure_metadata(&link, false).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(secure_metadata(&path, false).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[path = "browser_companion_transport.rs"]
mod transport;
pub use transport::start;
