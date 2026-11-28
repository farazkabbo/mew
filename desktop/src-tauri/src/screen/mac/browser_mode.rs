//! Browser mode evidence. Production uses same-process read-only AppleEvents with the public
//! no-user-consent send flag, exact native AX/CG focused-window geometry, and unique script
//! geometry. Chrome stable and Brave have inspected installed dictionaries; Safari has no private-window
//! property in its public dictionary, so other browsers remain Unknown.
//!
//! The older JXA runner remains an unbound testable adapter foundation. Its numeric IDs
//! inhabit a different namespace and its `sample()` output never authorizes capture. Installed
//! capture code calls `sample_native()`; it does not spawn osascript or trigger TCC consent.
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
#[path = "browser_mode_native.rs"]
mod native;
#[cfg(target_os = "macos")]
pub fn sample_native(
    request: &FocusRequest,
    bounds: super::target::Rect,
    current: &dyn Fn() -> bool,
) -> Mode {
    native::sample(request, bounds, current)
}

pub(crate) fn saved_source(
    request: &FocusRequest,
    bounds: super::target::Rect,
    current: &dyn Fn() -> bool,
) -> Option<(String, String)> {
    native::source(request, bounds, current)
}

const SCRIPT: &str = include_str!("browser_mode.js");
const LIMIT: usize = 64;
const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Private,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusRequest {
    pub pid: i32,
    pub bundle: String,
    /// NSRunningApplication.launchDate.timeIntervalSince1970 as a decimal string.
    pub launch: String,
    pub cg_window_id: u32,
    pub generation: u64,
}

/// Intentionally no Bound variant. Browser script IDs inhabit a different namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    Unbound { script_window_id: String },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub mode: Mode,
    pub binding: Binding,
}
impl Sample {
    fn unknown() -> Self {
        Self {
            mode: Mode::Unknown,
            binding: Binding::Unavailable,
        }
    }

    /// A public script-window sample cannot identify the requested capture window.
    pub fn focused_window_mode(&self) -> Mode {
        Mode::Unknown
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Unavailable,
    Timeout,
    Cancelled,
    OutputLimit,
}

/// Implementations must bound runtime/output and honour revocation while pending.
pub trait Runner {
    fn run(&mut self, argv: &[String], current: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure>;
}

/// No implicit permission grant: caller must separately obtain explicit consent.
pub struct Osascript;
impl Runner for Osascript {
    fn run(&mut self, argv: &[String], current: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure> {
        if !current() {
            return Err(Failure::Cancelled);
        }
        #[cfg(target_os = "macos")]
        if !argv
            .first()
            .and_then(|pid| pid.parse().ok())
            .is_some_and(automation_previously_allowed)
        {
            return Err(Failure::Unavailable);
        }
        let mut command = Command::new("/usr/bin/osascript");
        command
            .args(["-l", "JavaScript", "-e", SCRIPT, "--"])
            .args(argv);
        run_command(command, current, TIMEOUT)
    }
}

fn run_command(
    mut command: Command,
    current: &dyn Fn() -> bool,
    timeout: Duration,
) -> Result<Vec<u8>, Failure> {
    if !current() {
        return Err(Failure::Cancelled);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| Failure::Unavailable)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Failure::Unavailable);
    };
    let (tx, rx) = mpsc::sync_channel(1);
    // The fixed script spawns no descendants. Do not block on a reader join.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.take((LIMIT + 1) as u64).read_to_end(&mut bytes);
        let _ = tx.send(read.map(|_| bytes).map_err(|_| Failure::Unavailable));
    });
    let start = Instant::now();
    let mut output = None;
    let result = loop {
        if !current() {
            break Err(Failure::Cancelled);
        }
        if start.elapsed() >= timeout {
            break Err(Failure::Timeout);
        }
        if output.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) if bytes.len() > LIMIT => break Err(Failure::OutputLimit),
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(error)) => break Err(error),
                Err(mpsc::TryRecvError::Disconnected) => break Err(Failure::Unavailable),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => break Err(Failure::Unavailable),
            Ok(Some(_)) if output.is_some() => break Ok(output.take().unwrap()),
            Ok(_) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break Err(Failure::Unavailable),
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    if !current() {
        return Err(Failure::Cancelled);
    }
    result
}

/// Samples only inspected Chrome stable; derivatives require their own evidence.
/// Revocation, unsupported identity, every error and malformed output are Unknown.
pub fn sample(
    runner: &mut dyn Runner,
    request: &FocusRequest,
    current: &dyn Fn() -> bool,
) -> Sample {
    let launch_valid = request.launch.len() <= 64
        && request
            .launch
            .parse::<f64>()
            .is_ok_and(|v| v.is_finite() && v > 0.)
        && request
            .launch
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'.');
    if !current()
        || request.bundle != "com.google.Chrome"
        || request.pid <= 0
        || request.cg_window_id == 0
        || !launch_valid
    {
        return Sample::unknown();
    }
    let argv = [
        request.pid.to_string(),
        request.bundle.clone(),
        request.launch.clone(),
    ];
    let result = runner.run(&argv, current);
    if !current() {
        return Sample::unknown();
    }
    result
        .ok()
        .map(|bytes| parse(&bytes))
        .unwrap_or_else(Sample::unknown)
}

fn parse(bytes: &[u8]) -> Sample {
    if bytes.len() > LIMIT {
        return Sample::unknown();
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Sample::unknown();
    };
    let text = text.strip_suffix('\n').unwrap_or(text);
    let Some((mode, id)) = text.split_once('\t') else {
        return Sample::unknown();
    };
    if id.is_empty()
        || id.len() > 20
        || id.starts_with('0')
        || !id.bytes().all(|b| b.is_ascii_digit())
    {
        return Sample::unknown();
    }
    let mode = match mode {
        "normal" => Mode::Normal,
        "incognito" => Mode::Private,
        _ => return Sample::unknown(),
    };
    Sample {
        mode,
        binding: Binding::Unbound {
            script_window_id: id.to_owned(),
        },
    }
}

/// Exact native AX/CG geometry binding is supplied by the caller and freshly rechecked before
/// and after JXA. Unique script-window geometry binds namespaces; numeric IDs are never
/// compared. This only supports Chrome stable's inspected public dictionary.
pub fn sample_bound(
    runner: &mut dyn Runner,
    request: &FocusRequest,
    bounds: super::target::Rect,
    current: &dyn Fn() -> bool,
) -> Mode {
    if request.bundle != "com.google.Chrome"
        || request.pid <= 0
        || request.cg_window_id == 0
        || request.generation == 0
        || !current()
        || super::target::Rect::new(bounds.x, bounds.y, bounds.width, bounds.height).is_none()
    {
        return Mode::Unknown;
    }
    let launch_valid = request.launch.len() <= 64
        && request
            .launch
            .parse::<f64>()
            .is_ok_and(|v| v.is_finite() && v > 0.)
        && request
            .launch
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'.');
    if !launch_valid {
        return Mode::Unknown;
    }
    let argv = [
        request.pid.to_string(),
        request.bundle.clone(),
        request.launch.clone(),
        bounds.x.to_string(),
        bounds.y.to_string(),
        bounds.width.to_string(),
        bounds.height.to_string(),
    ];
    let result = runner.run(&argv, current);
    if !current() {
        return Mode::Unknown;
    }
    match result.as_deref() {
        Ok(b"bound-normal") | Ok(b"bound-normal\n") => Mode::Normal,
        Ok(b"bound-private") | Ok(b"bound-private\n") => Mode::Private,
        _ => Mode::Unknown,
    }
}

#[cfg(target_os = "macos")]
pub fn automation_previously_allowed(pid: i32) -> bool {
    use std::ffi::c_void;
    #[repr(C, packed(2))]
    struct Desc {
        kind: u32,
        data: *mut c_void,
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn AECreateDesc(kind: u32, bytes: *const c_void, size: isize, out: *mut Desc) -> i16;
        fn AEDisposeDesc(desc: *mut Desc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const Desc,
            event_class: u32,
            event_id: u32,
            ask_user: u8,
        ) -> i32;
    }
    if pid <= 0 {
        return false;
    }
    let mut desc = Desc {
        kind: 0,
        data: std::ptr::null_mut(),
    };
    // Public SDK query only, explicitly askUserIfNeeded=false. An ungranted permission stays
    // Unknown; neither setup nor capture asks the user or opens privacy settings.
    let created = unsafe {
        AECreateDesc(
            u32::from_be_bytes(*b"kpid"),
            (&pid as *const i32).cast(),
            std::mem::size_of::<i32>() as isize,
            &mut desc,
        )
    };
    if created != 0 {
        return false;
    }
    let status = unsafe {
        AEDeterminePermissionToAutomateTarget(
            &desc,
            u32::from_be_bytes(*b"****"),
            u32::from_be_bytes(*b"****"),
            0,
        )
    };
    unsafe { AEDisposeDesc(&mut desc) };
    status == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Fake {
        calls: usize,
        result: Result<Vec<u8>, Failure>,
    }
    impl Runner for Fake {
        fn run(&mut self, argv: &[String], _: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure> {
            assert_eq!(argv, &["123", "com.google.Chrome", "100.5"]);
            self.calls += 1;
            self.result.clone()
        }
    }
    fn request() -> FocusRequest {
        FocusRequest {
            pid: 123,
            bundle: "com.google.Chrome".into(),
            launch: "100.5".into(),
            cg_window_id: 42,
            generation: 7,
        }
    }
    #[test]
    fn positive_modes_are_always_unbound_even_if_numeric_ids_match() {
        for (wire, mode) in [
            ("normal\t42\n", Mode::Normal),
            ("incognito\t42\n", Mode::Private),
        ] {
            let mut runner = Fake {
                calls: 0,
                result: Ok(wire.as_bytes().to_vec()),
            };
            let got = sample(&mut runner, &request(), &|| true);
            assert_eq!(got.mode, mode);
            assert!(matches!(got.binding, Binding::Unbound { .. }));
            assert_eq!(got.focused_window_mode(), Mode::Unknown);
        }
    }
    #[test]
    fn safari_and_unverified_derivatives_do_not_query() {
        for bundle in [
            "com.apple.Safari",
            "com.microsoft.edgemac",
            "com.brave.Browser",
            "org.chromium.Chromium",
            "invalid",
        ] {
            let mut r = request();
            r.bundle = bundle.into();
            let mut runner = Fake {
                calls: 0,
                result: Ok(b"normal\t42".to_vec()),
            };
            assert_eq!(sample(&mut runner, &r, &|| true), Sample::unknown());
            assert_eq!(runner.calls, 0);
        }
    }
    #[test]
    fn malformed_errors_and_revocation_fail_closed() {
        for bytes in [
            b"unknown".as_slice(),
            b"Normal\t42",
            b"normal\t0",
            b"normal\t42\nextra",
            b"normal\t42\t3",
            &[255],
            &[b'a'; LIMIT + 1],
        ] {
            assert_eq!(parse(bytes), Sample::unknown());
        }
        for error in [
            Failure::Cancelled,
            Failure::Timeout,
            Failure::Unavailable,
            Failure::OutputLimit,
        ] {
            let mut runner = Fake {
                calls: 0,
                result: Err(error),
            };
            assert_eq!(sample(&mut runner, &request(), &|| true), Sample::unknown());
        }
        let mut runner = Fake {
            calls: 0,
            result: Ok(b"normal\t42".to_vec()),
        };
        let checks = Cell::new(0);
        let current = || {
            checks.set(checks.get() + 1);
            checks.get() == 1
        };
        assert_eq!(sample(&mut runner, &request(), &current), Sample::unknown());
        assert_eq!(runner.calls, 1);
        assert_eq!(
            sample(&mut runner, &request(), &|| false),
            Sample::unknown()
        );
        assert_eq!(runner.calls, 1);
    }

    #[test]
    fn subprocess_timeout_cancellation_and_output_are_bounded() {
        // Synthetic native commands only. Never invoke osascript in a test.
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("5");
        let start = Instant::now();
        assert_eq!(
            run_command(sleep, &|| true, Duration::from_millis(40)),
            Err(Failure::Timeout)
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("5");
        let checks = Cell::new(0);
        let current = || {
            checks.set(checks.get() + 1);
            checks.get() < 3
        };
        assert_eq!(
            run_command(sleep, &current, TIMEOUT),
            Err(Failure::Cancelled)
        );
        let writer = Command::new("/usr/bin/yes");
        assert_eq!(
            run_command(writer, &|| true, TIMEOUT),
            Err(Failure::OutputLimit)
        );
        let mut echo = Command::new("/bin/echo");
        echo.arg("normal\t42");
        assert_eq!(
            run_command(echo, &|| true, TIMEOUT),
            Ok(b"normal\t42\n".to_vec())
        );
    }
    #[test]
    fn bound_browser_output_cannot_promote_unbound_or_cancelled_results() {
        struct BoundRunner(Vec<u8>);
        impl Runner for BoundRunner {
            fn run(&mut self, argv: &[String], _: &dyn Fn() -> bool) -> Result<Vec<u8>, Failure> {
                assert_eq!(argv.len(), 7);
                Ok(self.0.clone())
            }
        }
        let bounds = super::super::target::Rect::new(-1440., -200., 1200., 800.).unwrap();
        for (bytes, expected) in [
            (b"bound-normal".to_vec(), Mode::Normal),
            (b"bound-private".to_vec(), Mode::Private),
            (b"normal\t42".to_vec(), Mode::Unknown),
            (b"bound-normal\nsecret".to_vec(), Mode::Unknown),
        ] {
            assert_eq!(
                sample_bound(&mut BoundRunner(bytes), &request(), bounds, &|| true),
                expected
            );
        }
        assert_eq!(
            sample_bound(
                &mut BoundRunner(b"bound-normal".to_vec()),
                &request(),
                bounds,
                &|| false
            ),
            Mode::Unknown
        );
    }
}
