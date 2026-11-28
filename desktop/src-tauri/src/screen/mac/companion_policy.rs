//! Pure companion visibility and coordinate math, independent of native permissions.
pub fn track_allowed(
    on: bool,
    paused: bool,
    visible: bool,
    fullscreen: bool,
    calls_clear: bool,
) -> bool {
    on && !paused && visible && !fullscreen && calls_clear
}
pub fn shifted(base: (f64, f64), now: (f64, f64)) -> Option<(f64, f64)> {
    [base.0, base.1, now.0, now.1]
        .iter()
        .all(|v| v.is_finite())
        .then_some((now.0 - base.0, now.1 - base.1))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_or_disabled_contexts_hide_the_companion() {
        assert!(track_allowed(true, false, true, false, true));
        for args in [
            (false, false, true, false, true),
            (true, true, true, false, true),
            (true, false, false, false, true),
            (true, false, true, true, true),
            (true, false, true, false, false),
        ] {
            assert!(!track_allowed(args.0, args.1, args.2, args.3, args.4));
        }
    }
    #[test]
    fn scroll_offsets_are_relative_not_cumulative_and_reject_nonfinite() {
        assert_eq!(shifted((0., -20.), (0., -120.)), Some((0., -100.)));
        assert_eq!(shifted((-800., 20.), (-850., 25.)), Some((-50., 5.)));
        assert_eq!(shifted((0., 0.), (f64::NAN, 0.)), None);
    }
}
