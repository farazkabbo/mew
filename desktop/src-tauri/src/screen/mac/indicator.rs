//! Fixed, non-activating native capture border. A visible window is insufficient: native proof
//! comes only from Metal's presented handler and is revalidated on the main thread each poll.
//! This owns no pixels or caller pointers. Bind it to the independent intent/target/privacy
//! guard at EVERY capture boundary, then drop it as soon as pixel acquisition completes.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::target::Rect;

unsafe extern "C" {
    fn neb_indicator_begin(token: u64, x: f64, y: f64, width: f64, height: f64) -> i32;
    fn neb_indicator_poll(token: u64) -> i32;
    fn neb_indicator_end(token: u64);
}
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
const WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Busy,
    Timeout,
    Cancelled,
    Native,
}
fn status(code: i32) -> Result<bool, Error> {
    match code {
        0 => Ok(false),
        1 => Ok(true),
        -1 => Err(Error::Invalid),
        -3 => Err(Error::Timeout),
        -4 => Err(Error::Busy),
        _ => Err(Error::Native),
    }
}
fn valid_bounds(rect: Rect) -> bool {
    Rect::new(rect.x, rect.y, rect.width, rect.height).is_some()
        && rect.width >= 8.
        && rect.height >= 8.
        && rect.width <= 16384.
        && rect.height <= 16384.
}

/// Non-cloneable, owned lease. Creation/wait must run on a worker, never AppKit's main
/// thread. A caller cannot fabricate presentation proof from a label, timer or window order.
pub struct Indicator {
    token: u64,
}

/// Revocable scalar check for an owned main-thread policy snapshot. A copied handle does
/// not prolong the lease or permit presentation; native active-token checks fail after Drop.
#[derive(Clone, Copy)]
pub struct IndicatorCheck {
    token: u64,
}
impl IndicatorCheck {
    /// Safe on main (direct AppKit validation) or worker (bounded main-queue validation).
    pub fn is_presented(self) -> bool {
        // SAFETY: scalar token only. Native checks current owned panel and Metal proof.
        matches!(status(unsafe { neb_indicator_poll(self.token) }), Ok(true))
    }
}
impl Indicator {
    pub fn begin(rect: Rect) -> Result<Self, Error> {
        if !valid_bounds(rect) {
            return Err(Error::Invalid);
        }
        let token = NEXT_TOKEN
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| Error::Invalid)?;
        // SAFETY: scalar-only arguments; native copies rect/token and retains no Rust pointer.
        status(unsafe { neb_indicator_begin(token, rect.x, rect.y, rect.width, rect.height) })?;
        Ok(Self { token })
    }

    /// Wait only for actual presentation. Cancellation revokes native proof immediately;
    /// timeouts fail closed. The lease can then remain visible up to its native 15s hard cap.
    pub fn wait_presented(&self, current: &mut dyn FnMut() -> bool) -> Result<(), Error> {
        let started = Instant::now();
        loop {
            if !current() {
                self.cancel();
                return Err(Error::Cancelled);
            }
            if started.elapsed() >= WAIT {
                self.cancel();
                return Err(Error::Timeout);
            }
            let proof = status(unsafe { neb_indicator_poll(self.token) });
            match proof {
                Ok(true) if current() => return Ok(()),
                Ok(true) => {
                    self.cancel();
                    return Err(Error::Cancelled);
                }
                Ok(false) => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    self.cancel();
                    return Err(error);
                }
            }
        }
    }

    pub fn check_handle(&self) -> IndicatorCheck {
        IndicatorCheck { token: self.token }
    }

    /// Revalidate at the point of use; do not cache the returned bool. Unknown/busy/hidden/
    /// changed-display/expired/cancelled states all return false. Main-thread calls validate
    /// AppKit directly, permitting one main-thread target/privacy/indicator policy snapshot.
    pub fn is_presented(&self) -> bool {
        self.check_handle().is_presented()
    }

    pub fn cancel(&self) {
        // SAFETY: scalar token; invalidation is synchronous, AppKit cleanup is main-queued.
        unsafe { neb_indicator_end(self.token) };
    }
}
impl Drop for Indicator {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_native_presentation_status_is_proof() {
        assert_eq!(status(0), Ok(false));
        assert_eq!(status(1), Ok(true));
        for code in [-100, -4, -3, -1, 2, 100] {
            assert!(status(code).is_err());
        }
    }
    #[test]
    fn bounds_fail_before_creating_a_native_lease() {
        assert!(valid_bounds(Rect::new(-500., 10., 500., 400.).unwrap()));
        assert!(!valid_bounds(Rect::new(0., 0., 1., 1.).unwrap()));
        assert!(!valid_bounds(Rect::new(0., 0., 20_000., 20.).unwrap()));
    }
}
