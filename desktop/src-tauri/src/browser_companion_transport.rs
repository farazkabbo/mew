//! Authenticated socket lifecycle and deadline-bound request exchange for the pairing broker.
use super::*;
use std::{os::unix::net::UnixListener, sync::atomic::Ordering};

/// Every read/write shares one wall-clock deadline, including deliberately fragmented frames.
struct DeadlineIo<'a> {
    socket: &'a mut UnixStream,
    deadline: Instant,
}
impl Read for DeadlineIo<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        self.socket.set_read_timeout(Some(remaining))?;
        self.socket.read(bytes)
    }
}
impl Write for DeadlineIo<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        self.socket.set_write_timeout(Some(remaining))?;
        self.socket.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}
fn exchange(
    socket: &mut UnixStream,
    request: wire::Request,
    guard: &mut wire::ReplyGuard,
    deadline: Instant,
) -> io::Result<wire::Response> {
    let mut stream = DeadlineIo { socket, deadline };
    wire::write_message(&mut stream, &wire::Message::Request(request.clone()))
        .map_err(|_| invalid())?;
    let Some(wire::Message::Response(response)) =
        wire::read_message(&mut stream).map_err(|_| invalid())?
    else {
        return Err(invalid());
    };
    if Instant::now() >= deadline {
        return Err(unavailable());
    }
    guard.accept(&request, &response).map_err(|_| invalid())?;
    Ok(response)
}
fn idle_socket_is_open(socket: &UnixStream) -> bool {
    use std::{ffi::c_void, os::fd::AsRawFd};
    unsafe extern "C" {
        fn recv(fd: i32, buffer: *mut c_void, length: usize, flags: i32) -> isize;
    }
    let mut byte = 0u8;
    let result = unsafe {
        recv(
            socket.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            2 | 0x80,
        )
    };
    // EOF or unsolicited bytes invalidate the connection; only an empty, open socket waits.
    result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock
}
fn configured_origin(origin: &str) -> bool {
    let Ok(config) =
        serde_json::from_str::<wire::HostConfig>(include_str!("../browser-companion.json"))
    else {
        return false;
    };
    config.validate().is_ok()
        && (config.firefox_addon_ids.iter().any(|id| id == origin)
            || config
                .chrome_extension_ids
                .iter()
                .any(|id| origin == format!("chrome-extension://{id}/")))
}
fn serve(server: &Arc<Server>, mut socket: UnixStream) -> io::Result<()> {
    let peer = auth::authenticate_host(&socket)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut stream = DeadlineIo {
        socket: &mut socket,
        deadline,
    };
    let Some(wire::Message::HostHello(host)) =
        wire::read_message(&mut stream).map_err(|_| invalid())?
    else {
        return Err(invalid());
    };
    if !configured_origin(&host.origin) {
        return Err(denied());
    }
    let first = wire::read_message(&mut stream).map_err(|_| invalid())?;
    let (hello, pair_requested) = match first {
        Some(wire::Message::Hello(h)) => (h, false),
        Some(wire::Message::Pair(h)) => (h, true),
        _ => return Err(invalid()),
    };
    let id = random_id();
    let pairing_id = random_id();
    if !wire::is_id(&id) || !wire::is_id(&pairing_id) || !auth::browser_alive(&peer) {
        return Err(denied());
    }
    let identity = Pairing {
        pairing_id,
        browser_identifier: peer.identifier.clone(),
        team: peer.team.clone(),
        origin: host.origin,
        profile_id: hello.profile_id.clone(),
    };
    let (tx, rx) = mpsc::sync_channel(1);
    {
        let mut state = server.state.lock().map_err(|_| unavailable())?;
        if !pair_requested && !trusted(&state.registry, &identity) {
            return Err(denied());
        }
        // A new authenticated connection for this exact profile replaces its previous epoch.
        state.connections.retain(|_, c| {
            if same_identity(&c.identity, &identity) {
                let _ = c.socket.shutdown(Shutdown::Both);
                false
            } else {
                true
            }
        });
        state.connections.insert(
            id.clone(),
            Connection {
                peer,
                identity,
                pair_requested,
                pending_until: Instant::now() + PAIR_TIMEOUT,
                queue: tx,
                socket: socket.try_clone()?,
            },
        );
    }
    let result = connection_loop(server, &id, &hello.profile_id, &mut socket, rx);
    let _ = socket.shutdown(Shutdown::Both);
    if let Ok(mut state) = server.state.lock() {
        state.connections.remove(&id);
    }
    result
}
fn connection_loop(
    server: &Arc<Server>,
    id: &str,
    profile: &str,
    socket: &mut UnixStream,
    rx: mpsc::Receiver<Work>,
) -> io::Result<()> {
    let mut guard = wire::ReplyGuard::new(profile).map_err(|_| invalid())?;
    let mut sequence = 0u64;
    let mut warmed = false;
    loop {
        if !idle_socket_is_open(socket) {
            return Err(unavailable());
        }
        let current = server.current(id);
        if !current {
            let state = server.state.lock().map_err(|_| unavailable())?;
            let c = state.connections.get(id).ok_or_else(unavailable)?;
            if !c.pair_requested
                || Instant::now() >= c.pending_until
                || !auth::browser_alive(&c.peer)
            {
                return Err(denied());
            }
        }
        if current && !warmed {
            sequence = sequence.checked_add(1).ok_or_else(invalid)?;
            let request = wire::Request {
                version: wire::VERSION,
                nonce: random_id(),
                generation: 1,
                sequence,
                profile_id: profile.into(),
                operation: wire::Operation::Probe,
                window_id: None,
                tab_id: None,
                document_id: None,
                media_id: None,
                action: None,
            };
            exchange(
                socket,
                request,
                &mut guard,
                Instant::now() + REQUEST_TIMEOUT,
            )?;
            warmed = true;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(mut work) => {
                if !server.current(id) || !work.live() {
                    let _ = work.reply.send(Err(denied()));
                    continue;
                }
                sequence = sequence.checked_add(1).ok_or_else(invalid)?;
                work.request.sequence = sequence;
                let result = exchange(socket, work.request, &mut guard, work.deadline);
                let fatal = result.is_err();
                let _ = work.reply.send(result);
                if fatal {
                    return Err(unavailable());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}
fn prepare_directory(path: &Path) -> io::Result<()> {
    if let Err(e) = fs::create_dir(path) {
        if e.kind() != io::ErrorKind::AlreadyExists {
            return Err(e);
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { geteuid() }
    {
        return Err(denied());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    secure_metadata(path, true)
}
fn bind_socket(path: &Path) -> io::Result<UnixListener> {
    if let Ok(before) = fs::symlink_metadata(path) {
        if !before.file_type().is_socket() || before.uid() != unsafe { geteuid() } {
            return Err(denied());
        }
        match UnixStream::connect(path) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "Browser companion already running",
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {}
            Err(e) => return Err(e),
        }
        let after = fs::symlink_metadata(path)?;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || !after.file_type().is_socket()
        {
            return Err(denied());
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}
pub fn start() -> io::Result<Arc<Server>> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(denied)?;
    let mut parent = home.clone();
    for part in ["Library", "Application Support"] {
        parent.push(part);
        let m = fs::symlink_metadata(&parent)?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.uid() != unsafe { geteuid() }
            || m.mode() & 0o022 != 0
        {
            return Err(denied());
        }
    }
    let directory = parent.join("app.mew.desktop");
    prepare_directory(&directory)?;
    let registry_path = directory.join("browser-pairings.json");
    let registry = load_registry(&registry_path)?;
    let socket_path = directory.join("browser.sock");
    let listener = bind_socket(&socket_path)?;
    let server = Arc::new(Server {
        registry_path,
        socket_inode: fs::symlink_metadata(&socket_path)?.ino(),
        socket_path,
        state: Mutex::new(State {
            registry,
            connections: HashMap::new(),
        }),
        clients: AtomicUsize::new(0),
    });
    let weak = Arc::downgrade(&server);
    std::thread::Builder::new()
        .name("neb-browser-listener".into())
        .spawn(move || loop {
            let Some(server) = weak.upgrade() else {
                break;
            };
            match listener.accept() {
                Ok((socket, _)) => {
                    if server.clients.fetch_add(1, Ordering::AcqRel) >= MAX_CLIENTS {
                        server.clients.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                    let handle = server.clone();
                    if std::thread::Builder::new()
                        .name("neb-browser-profile".into())
                        .spawn(move || {
                            let _ = serve(&handle, socket);
                            handle.clients.fetch_sub(1, Ordering::AcqRel);
                        })
                        .is_err()
                    {
                        server.clients.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    drop(server);
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        })?;
    Ok(server)
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    fn request(sequence: u64) -> wire::Request {
        wire::Request {
            version: 1,
            nonce: "1".repeat(32),
            generation: 3,
            sequence,
            profile_id: "2".repeat(32),
            operation: wire::Operation::Probe,
            window_id: None,
            tab_id: None,
            document_id: None,
            media_id: None,
            action: None,
        }
    }
    #[test]
    fn error_reply_is_bound_and_consumes_sequence_without_becoming_proof() {
        let (mut app, mut extension) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            for _ in 0..2 {
                let Some(wire::Message::Request(r)) = wire::read_message(&mut extension).unwrap()
                else {
                    panic!("request required")
                };
                let response = wire::Response {
                    version: 1,
                    nonce: r.nonce,
                    generation: r.generation,
                    sequence: r.sequence,
                    profile_id: r.profile_id,
                    status: wire::Status::Error,
                    window: None,
                    media: None,
                    error: Some(wire::ErrorCode::Private),
                };
                wire::write_message(&mut extension, &wire::Message::Response(response)).unwrap();
            }
        });
        let mut guard = wire::ReplyGuard::new(&"2".repeat(32)).unwrap();
        let response = exchange(
            &mut app,
            request(1),
            &mut guard,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(response.status, wire::Status::Error);
        assert!(response.window.is_none());
        assert!(exchange(
            &mut app,
            request(1),
            &mut guard,
            Instant::now() + Duration::from_secs(1)
        )
        .is_err());
        worker.join().unwrap();
    }
    #[test]
    fn fragmented_frame_cannot_extend_the_native_deadline() {
        let (mut app, mut extension) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let _ = wire::read_message(&mut extension).unwrap();
            extension.write_all(&[100]).unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });
        let start = Instant::now();
        let mut guard = wire::ReplyGuard::new(&"2".repeat(32)).unwrap();
        assert!(exchange(
            &mut app,
            request(1),
            &mut guard,
            start + Duration::from_millis(30)
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_millis(130));
        worker.join().unwrap();
    }
    #[test]
    fn stale_socket_cleanup_never_unlinks_a_live_listener_or_regular_file() {
        let dir = PathBuf::from("/tmp").join(format!("neb-broker-socket-{}", random_id()));
        prepare_directory(&dir).unwrap();
        let path = dir.join("browser.sock");
        let listener = bind_socket(&path).unwrap();
        assert!(bind_socket(&path).is_err());
        assert!(path.exists());
        drop(listener);
        let listener = bind_socket(&path).unwrap();
        drop(listener);
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"unrelated").unwrap();
        assert!(bind_socket(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unrelated");
        fs::remove_dir_all(dir).unwrap();
    }
}
