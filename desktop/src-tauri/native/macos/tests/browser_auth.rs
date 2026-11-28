//! Isolated process-signature smoke fixture; run through verify_browser_auth.sh.
#[path = "../../../src/browser_companion_auth.rs"]
mod auth;
use std::{
    os::unix::net::{UnixListener, UnixStream},
    process::Command,
};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args[1] == "client" {
        let socket = UnixStream::connect(&args[2]).unwrap();
        std::process::exit(if auth::authenticate_server(&socket).is_ok() {
            0
        } else {
            1
        });
    }
    let root = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let socket = root.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    let mut child = Command::new(root.join("neb-browser-host"))
        .arg("client")
        .arg(&socket)
        .spawn()
        .unwrap();
    let (stream, _) = listener.accept().unwrap();
    assert!(
        auth::authenticate_host(&stream).is_err(),
        "a test process must never masquerade as a signed browser"
    );
    let status = child.wait().unwrap();
    let real = std::env::current_exe().unwrap().file_name().unwrap() == "mew-desktop";
    assert_eq!(
        status.success(),
        real,
        "only the exact signed sibling app can authenticate"
    );
    std::fs::remove_file(socket).unwrap();
    println!("native peer authentication smoke passed");
}
