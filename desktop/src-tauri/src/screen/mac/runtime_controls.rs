//! Pure timer ownership: a later preference or pause decision supersedes automatic resume.
pub fn resume_due(
    timer_generation: u64,
    current_generation: u64,
    paused: bool,
    enabled: bool,
) -> bool {
    timer_generation == current_generation && paused && enabled
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_choices_and_disabled_coach_never_resume() {
        assert!(resume_due(4, 4, true, true));
        assert!(!resume_due(4, 5, true, true));
        assert!(!resume_due(4, 4, false, true));
        assert!(!resume_due(4, 4, true, false));
    }
}
