//! Installed native-messaging relay. It never invokes a shell, HTTP, Keychain or arbitrary file.
#[cfg(target_os = "macos")]
#[path = "../browser_companion_auth.rs"]
mod auth;
#[allow(dead_code)]
#[path = "../browser_companion_protocol.rs"]
mod protocol;
#[cfg(target_os = "macos")]
fn relay() -> Result<(), ()> {
    use protocol::{HostConfig, HostHello, Message, VERSION};
    use std::{io, net::Shutdown, os::unix::net::UnixStream, path::PathBuf};
    let config: HostConfig =
        serde_json::from_str(include_str!("../../browser-companion.json")).map_err(|_| ())?;
    let args = std::env::args_os()
        .skip(1)
        .map(|s| s.into_string().map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    let origin = config.caller(&args).map_err(|_| ())?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or(())?;
    let path = home.join("Library/Application Support/app.mew.desktop/browser.sock");
    let mut socket = UnixStream::connect(path).map_err(|_| ())?;
    auth::authenticate_server(&socket).map_err(|_| ())?;
    protocol::write_message(
        &mut socket,
        &Message::HostHello(HostHello {
            version: VERSION,
            origin,
        }),
    )
    .map_err(|_| ())?;
    let mut outbound = socket.try_clone().map_err(|_| ())?;
    std::thread::Builder::new()
        .name("neb-browser-host-input".into())
        .spawn(move || {
            let mut input = io::stdin().lock();
            while let Ok(Some(message)) = protocol::read_message(&mut input) {
                if !matches!(
                    message,
                    Message::Hello(_) | Message::Pair(_) | Message::Response(_)
                ) {
                    break;
                }
                if protocol::write_message(&mut outbound, &message).is_err() {
                    break;
                }
            }
            let _ = outbound.shutdown(Shutdown::Both);
        })
        .map_err(|_| ())?;
    let mut output = io::stdout().lock();
    let result = (|| {
        while let Some(message) = protocol::read_message(&mut socket).map_err(|_| ())? {
            if !matches!(message, Message::Request(_)) {
                return Err(());
            }
            protocol::write_message(&mut output, &message).map_err(|_| ())?;
        }
        Ok(())
    })();
    let _ = socket.shutdown(Shutdown::Both);
    result
}
fn main() {
    #[cfg(target_os = "macos")]
    let ok = relay().is_ok();
    #[cfg(not(target_os = "macos"))]
    let ok = false;
    if !ok {
        std::process::exit(1);
    }
}
