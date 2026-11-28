//! Bounded, read-only call/recording signals corresponding to Windows' limited detector.
//!
//! `KnownSignalsIdle` means all enumerated input-capable CoreAudio devices are idle and no
//! known call/recording app is in NSWorkspace's current inventory. It is NOT proof of no call
//! or screen share: browser calls without input, unknown recorders and non-app helpers may be
//! invisible. CoreAudio includes virtual/aggregate/non-default input devices and our own voice
//! input; even our own active input blocks until stopped. RunningSomewhere is device-wide,
//! so output playback on an input-capable duplex device can conservatively block too.
//! A running known app blocks even if
//! it is not currently recording. No capture, audio samples, names, URLs or IPC are involved.
//!
//! Schedule `sample` freshly on the main queue, after the main run loop can process app
//! changes; NSWorkspace's application inventory updates with the main run loop. Do not cache
//! idle across capture boundaries. Synchronous public OS queries cannot be interrupted, so
//! the deadline rejects a late result (it does not promise preemption of a stuck OS call).
use std::time::Instant;

const MAX_BYTES: usize = 65_536;
const MAX_DEVICES: usize = 4096;
const DEVICES: u32 = u32::from_be_bytes(*b"dev#");
const STREAM_CONFIG: u32 = u32::from_be_bytes(*b"slay");
const RUNNING: u32 = u32::from_be_bytes(*b"gone");
const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const INPUT: u32 = u32::from_be_bytes(*b"inpt");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignalState {
    Active,
    KnownSignalsIdle,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnknownReason {
    CancelledOrDeadline,
    AudioUnavailable,
    MalformedAudio,
    DeviceInventoryChanged,
    AppInventoryUnavailable,
}
/// Metadata contains no persistent device IDs, bundle identifiers or user content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SignalSample {
    pub state: SignalState,
    pub reason: Option<UnknownReason>,
    pub input_devices_checked: u32,
    pub applications_checked: u32,
}
impl SignalSample {
    fn unknown(reason: UnknownReason) -> Self {
        Self {
            state: SignalState::Unknown,
            reason: Some(reason),
            input_devices_checked: 0,
            applications_checked: 0,
        }
    }
}

struct Guard<'a> {
    deadline: Instant,
    valid: &'a dyn Fn() -> bool,
}
impl Guard<'_> {
    fn check(&self) -> Result<(), UnknownReason> {
        // Also check after the callback: cancellation callbacks must not make a late sample valid.
        if Instant::now() >= self.deadline || !(self.valid)() || Instant::now() >= self.deadline {
            Err(UnknownReason::CancelledOrDeadline)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy)]
struct AppInventory {
    count: u32,
    active: bool,
}
trait Source {
    fn property(
        &mut self,
        object: u32,
        selector: u32,
        scope: u32,
        guard: &Guard<'_>,
    ) -> Result<Vec<u8>, UnknownReason>;
    fn applications(&mut self, guard: &Guard<'_>) -> Result<AppInventory, UnknownReason>;
}

fn read(
    source: &mut impl Source,
    object: u32,
    selector: u32,
    scope: u32,
    guard: &Guard<'_>,
) -> Result<Vec<u8>, UnknownReason> {
    guard.check()?;
    let result = source.property(object, selector, scope, guard)?;
    guard.check()?;
    if result.len() > MAX_BYTES {
        return Err(UnknownReason::MalformedAudio);
    }
    Ok(result)
}
fn inventory(source: &mut impl Source, guard: &Guard<'_>) -> Result<Vec<u32>, UnknownReason> {
    let bytes = read(source, 1, DEVICES, GLOBAL, guard)?;
    if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() / 4 > MAX_DEVICES {
        return Err(UnknownReason::MalformedAudio);
    }
    let mut ids: Vec<_> = bytes
        .chunks_exact(4)
        .map(|b| u32::from_ne_bytes(b.try_into().unwrap()))
        .collect();
    ids.sort_unstable();
    if ids[0] == 0 || ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(UnknownReason::MalformedAudio);
    }
    Ok(ids)
}
/// Decode the SDK's 64-bit AudioBufferList layout without dereferencing returned data pointers.
fn has_input(bytes: &[u8]) -> Result<bool, UnknownReason> {
    let invalid = UnknownReason::MalformedAudio;
    if bytes.len() < 8 {
        return Err(invalid);
    }
    let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
    if count > MAX_DEVICES || bytes.len() != 8 + count * 16 {
        return Err(invalid);
    }
    let mut input = false;
    for buffer in bytes[8..].chunks_exact(16) {
        // AudioHardware documents NULL data pointers for this metadata-only property.
        if buffer[8..16].iter().any(|byte| *byte != 0) {
            return Err(invalid);
        }
        input |= u32::from_ne_bytes(buffer[..4].try_into().unwrap()) > 0;
    }
    Ok(input)
}
fn collect(source: &mut impl Source, guard: &Guard<'_>) -> Result<SignalSample, UnknownReason> {
    guard.check()?;
    let before = inventory(source, guard)?;
    let mut input_devices_checked = 0;
    let mut active = false;
    for &device in &before {
        if has_input(&read(source, device, STREAM_CONFIG, INPUT, guard)?)? {
            input_devices_checked += 1;
            let bytes = read(source, device, RUNNING, GLOBAL, guard)?;
            let bytes: [u8; 4] = bytes
                .try_into()
                .map_err(|_| UnknownReason::MalformedAudio)?;
            match u32::from_ne_bytes(bytes) {
                0 => (),
                1 => active = true,
                _ => return Err(UnknownReason::MalformedAudio),
            }
        }
    }
    guard.check()?;
    let apps = source.applications(guard)?;
    guard.check()?;
    if apps.count == 0 || apps.count > 4096 {
        return Err(UnknownReason::AppInventoryUnavailable);
    }
    // Re-enumerate after all reads, including AppKit, to reject hot-unplug and inventory races.
    if before != inventory(source, guard)? {
        return Err(UnknownReason::DeviceInventoryChanged);
    }
    guard.check()?;
    Ok(SignalSample {
        state: if active || apps.active {
            SignalState::Active
        } else {
            SignalState::KnownSignalsIdle
        },
        reason: None,
        input_devices_checked,
        applications_checked: apps.count,
    })
}

// A deliberately finite policy, not an inventory of every recorder or conferencing helper.
// Bundle IDs are compared exactly; browser presence alone never implies an active call.
fn classify_bundle(bytes: &[u8]) -> u8 {
    let Ok(bundle) = std::str::from_utf8(bytes) else {
        return 0;
    };
    if bundle.is_empty() || bundle.len() > 512 || bundle.chars().any(char::is_control) {
        return 0;
    }
    match bundle {
        "us.zoom.xos"
        | "com.microsoft.teams"
        | "com.microsoft.teams2"
        | "com.apple.FaceTime"
        | "com.obsproject.obs-studio"
        | "com.apple.QuickTimePlayerX" => 2,
        _ => 1,
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::{
        ffi::c_void,
        panic::{catch_unwind, AssertUnwindSafe},
    };
    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }
    extern "C" {
        fn neb_call_app_inventory(
            count: *mut u32,
            active: *mut u32,
            valid: extern "C" fn(*mut c_void) -> bool,
            context: *mut c_void,
            classify: extern "C" fn(*const u8, usize) -> u8,
        ) -> i32;
    }
    extern "C" fn valid(context: *mut c_void) -> bool {
        // SAFETY: synchronous helper callback borrows the Guard only for its enclosing call.
        catch_unwind(AssertUnwindSafe(|| unsafe {
            (&*(context.cast::<Guard<'_>>())).check().is_ok()
        }))
        .unwrap_or(false)
    }
    extern "C" fn classify(bytes: *const u8, len: usize) -> u8 {
        if bytes.is_null() || len == 0 || len > 512 {
            return 0;
        }
        // SAFETY: AppKit helper supplies a live UTF-8 buffer and its bounded length synchronously.
        classify_bundle(unsafe { std::slice::from_raw_parts(bytes, len) })
    }
    pub(super) struct Native;
    impl Source for Native {
        fn property(
            &mut self,
            object: u32,
            selector: u32,
            scope: u32,
            guard: &Guard<'_>,
        ) -> Result<Vec<u8>, UnknownReason> {
            let address = Address {
                selector,
                scope,
                element: 0,
            };
            let failure = UnknownReason::AudioUnavailable;
            let mut size = 0;
            guard.check()?;
            // SAFETY: SDK-declared C ABI, valid address/out pointer, no qualifier.
            let status = unsafe {
                AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut size)
            };
            guard.check()?;
            if status != 0 || size as usize > MAX_BYTES {
                return Err(failure);
            }
            // u64 allocation provides AudioBufferList's required alignment; only bytes are read.
            let mut storage = vec![0u64; (size as usize).div_ceil(8).max(1)];
            let expected = size;
            guard.check()?;
            // SAFETY: writable aligned allocation covers the advertised capacity passed in size.
            let status = unsafe {
                AudioObjectGetPropertyData(
                    object,
                    &address,
                    0,
                    std::ptr::null(),
                    &mut size,
                    storage.as_mut_ptr().cast(),
                )
            };
            guard.check()?;
            if status != 0 || size != expected {
                return Err(failure);
            }
            let mut after = 0;
            // SAFETY: same property, valid size output; detect property-size races rather than retry.
            let status = unsafe {
                AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut after)
            };
            guard.check()?;
            if status != 0 || after != expected {
                return Err(failure);
            }
            // SAFETY: all bytes in the bounded allocation were initialized; copy only returned size.
            Ok(
                unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), size as usize) }
                    .to_vec(),
            )
        }
        fn applications(&mut self, guard: &Guard<'_>) -> Result<AppInventory, UnknownReason> {
            guard.check()?;
            let (mut count, mut active) = (0, 0);
            // SAFETY: all output pointers and synchronous callbacks remain live through this call.
            let ok = unsafe {
                neb_call_app_inventory(
                    &mut count,
                    &mut active,
                    valid,
                    (guard as *const Guard<'_>).cast_mut().cast(),
                    classify,
                )
            };
            guard.check()?;
            if ok != 1 || active > 1 {
                return Err(UnknownReason::AppInventoryUnavailable);
            }
            Ok(AppInventory {
                count,
                active: active == 1,
            })
        }
    }
}

/// Read fresh signals on the main queue. No permissions are requested and no state is retained.
#[cfg(target_os = "macos")]
pub fn sample(deadline: Instant, valid: &dyn Fn() -> bool) -> SignalSample {
    let guard = Guard { deadline, valid };
    collect(&mut native::Native, &guard).unwrap_or_else(SignalSample::unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::VecDeque, time::Duration};
    type Read = (u32, u32, u32, Result<Vec<u8>, UnknownReason>);
    struct Fake {
        reads: VecDeque<Read>,
        apps: Result<AppInventory, UnknownReason>,
        apps_read: bool,
    }
    impl Source for Fake {
        fn property(
            &mut self,
            object: u32,
            selector: u32,
            scope: u32,
            _: &Guard<'_>,
        ) -> Result<Vec<u8>, UnknownReason> {
            let (expected_object, expected_selector, expected_scope, result) =
                self.reads.pop_front().expect("unexpected property read");
            assert_eq!(
                (object, selector, scope),
                (expected_object, expected_selector, expected_scope)
            );
            result
        }
        fn applications(&mut self, _: &Guard<'_>) -> Result<AppInventory, UnknownReason> {
            self.apps_read = true;
            self.apps
        }
    }
    fn ids(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|id| id.to_ne_bytes()).collect()
    }
    fn config(channels: &[u32]) -> Vec<u8> {
        let mut bytes = vec![0; 8 + channels.len() * 16];
        bytes[..4].copy_from_slice(&(channels.len() as u32).to_ne_bytes());
        for (index, channels) in channels.iter().enumerate() {
            bytes[8 + index * 16..12 + index * 16].copy_from_slice(&channels.to_ne_bytes());
        }
        bytes
    }
    fn fixture(running: u32) -> Fake {
        Fake {
            reads: VecDeque::from([
                (1, DEVICES, GLOBAL, Ok(ids(&[10, 20, 30]))),
                (10, STREAM_CONFIG, INPUT, Ok(config(&[0]))), // output-only device
                (20, STREAM_CONFIG, INPUT, Ok(config(&[1]))), // ordinary input
                (20, RUNNING, GLOBAL, Ok(0u32.to_ne_bytes().to_vec())),
                (30, STREAM_CONFIG, INPUT, Ok(config(&[0, 2]))), // non-default/virtual/aggregate input
                (30, RUNNING, GLOBAL, Ok(running.to_ne_bytes().to_vec())),
                (1, DEVICES, GLOBAL, Ok(ids(&[30, 20, 10]))), // order is irrelevant
            ]),
            apps: Ok(AppInventory {
                count: 10,
                active: false,
            }),
            apps_read: false,
        }
    }
    fn run(fake: &mut Fake) -> SignalSample {
        collect(
            fake,
            &Guard {
                deadline: Instant::now() + Duration::from_secs(1),
                valid: &|| true,
            },
        )
        .unwrap_or_else(SignalSample::unknown)
    }
    #[test]
    fn idle_requires_every_input_and_both_device_inventories() {
        let mut fake = fixture(0);
        let sample = run(&mut fake);
        assert_eq!(sample.state, SignalState::KnownSignalsIdle);
        assert_eq!(sample.input_devices_checked, 2);
        assert_eq!(sample.applications_checked, 10);
        assert!(fake.apps_read && fake.reads.is_empty());
    }
    #[test]
    fn any_running_input_including_nondefault_or_own_voice_blocks() {
        // No process exemption exists: a device active solely in Neb also yields Active.
        let sample = run(&mut fixture(1));
        assert_eq!(sample.state, SignalState::Active);
    }
    #[test]
    fn known_app_blocks_even_without_active_audio() {
        let mut fake = fixture(0);
        fake.apps = Ok(AppInventory {
            count: 4,
            active: true,
        });
        assert_eq!(run(&mut fake).state, SignalState::Active);
        for id in [
            "us.zoom.xos",
            "com.microsoft.teams",
            "com.microsoft.teams2",
            "com.apple.FaceTime",
            "com.obsproject.obs-studio",
            "com.apple.QuickTimePlayerX",
        ] {
            assert_eq!(classify_bundle(id.as_bytes()), 2);
        }
        assert_eq!(classify_bundle(b"com.apple.Safari"), 1);
        assert_eq!(classify_bundle(b"com.obsproject.obs-studio.fake"), 1);
        assert_eq!(classify_bundle(b""), 0);
        assert_eq!(classify_bundle(b"\xff"), 0);
        assert_eq!(classify_bundle(b"secret\nname"), 0);
        assert_eq!(classify_bundle(&[b'a'; 513]), 0);
    }
    #[test]
    fn unplug_or_new_device_during_sample_is_unknown_even_with_active_input() {
        for after in [vec![10, 20], vec![10, 20, 30, 40]] {
            let mut fake = fixture(1);
            fake.reads.back_mut().unwrap().3 = Ok(ids(&after));
            assert_eq!(
                run(&mut fake).reason,
                Some(UnknownReason::DeviceInventoryChanged)
            );
        }
    }
    #[test]
    fn device_read_failures_and_size_races_never_become_idle() {
        for index in 0..7 {
            let mut fake = fixture(0);
            // Native property adapter reports OSStatus failures and changing sizes with this error.
            fake.reads[index].3 = Err(UnknownReason::AudioUnavailable);
            assert_eq!(run(&mut fake).reason, Some(UnknownReason::AudioUnavailable));
        }
    }
    #[test]
    fn app_failure_or_unusable_inventory_is_unknown() {
        for apps in [
            Err(UnknownReason::AppInventoryUnavailable),
            Ok(AppInventory {
                count: 0,
                active: false,
            }),
            Ok(AppInventory {
                count: 4097,
                active: false,
            }),
        ] {
            let mut fake = fixture(0);
            fake.apps = apps;
            assert_eq!(
                run(&mut fake).reason,
                Some(UnknownReason::AppInventoryUnavailable)
            );
        }
    }
    #[test]
    fn malformed_device_ids_running_values_and_stream_configs_fail_closed() {
        for bytes in [
            vec![],
            vec![1],
            ids(&[0]),
            ids(&[10, 10]),
            vec![0; MAX_BYTES + 1],
        ] {
            let mut fake = fixture(0);
            fake.reads[0].3 = Ok(bytes);
            assert_eq!(run(&mut fake).reason, Some(UnknownReason::MalformedAudio));
        }
        for bytes in [vec![], vec![1], 2u32.to_ne_bytes().to_vec(), vec![0; 8]] {
            let mut fake = fixture(0);
            fake.reads[5].3 = Ok(bytes);
            assert_eq!(run(&mut fake).reason, Some(UnknownReason::MalformedAudio));
        }
        assert_eq!(has_input(&config(&[])), Ok(false));
        assert_eq!(has_input(&config(&[0, 2])), Ok(true));
        let mut pointer = config(&[1]);
        pointer[16] = 1;
        for bytes in [
            vec![],
            vec![0; 4],
            vec![0; 9],
            pointer,
            config(&[1])[..23].to_vec(),
        ] {
            assert_eq!(has_input(&bytes), Err(UnknownReason::MalformedAudio));
        }
    }
    #[test]
    fn cancellation_and_deadline_before_or_mid_sample_reject_all_results() {
        let mut fake = fixture(0);
        let expired = Guard {
            deadline: Instant::now(),
            valid: &|| true,
        };
        assert_eq!(
            collect(&mut fake, &expired),
            Err(UnknownReason::CancelledOrDeadline)
        );
        assert_eq!(fake.reads.len(), 7);
        let baseline_calls = Cell::new(0);
        let baseline_valid = || {
            baseline_calls.set(baseline_calls.get() + 1);
            true
        };
        assert!(collect(
            &mut fixture(1),
            &Guard {
                deadline: Instant::now() + Duration::from_secs(1),
                valid: &baseline_valid,
            }
        )
        .is_ok());
        // Cancel at every check, including after the final inventory has been returned.
        for stop_at in 0..baseline_calls.get() {
            let mut fake = fixture(1);
            let calls = Cell::new(0);
            let valid = || {
                let count = calls.get();
                calls.set(count + 1);
                count < stop_at
            };
            assert_eq!(
                collect(
                    &mut fake,
                    &Guard {
                        deadline: Instant::now() + Duration::from_secs(1),
                        valid: &valid
                    }
                ),
                Err(UnknownReason::CancelledOrDeadline)
            );
        }
        // Callback overruns the deadline; the guard checks time after it returns as well.
        let valid = || {
            std::thread::sleep(Duration::from_millis(3));
            true
        };
        assert_eq!(
            collect(
                &mut fixture(0),
                &Guard {
                    deadline: Instant::now() + Duration::from_millis(1),
                    valid: &valid
                }
            ),
            Err(UnknownReason::CancelledOrDeadline)
        );
    }
}
