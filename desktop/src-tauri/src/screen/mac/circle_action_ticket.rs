//! An originating Circle action cannot inherit a replacement session or account.
#[derive(Clone, Copy)]
pub(super) struct ActionTicket {
    pub serial: u64,
    pub generation: u64,
    pub stamp: [u8; 32],
}
impl ActionTicket {
    pub fn matches(self, serial: u64, generation: u64, stamp: [u8; 32]) -> bool {
        self.serial == serial && self.generation == generation && self.stamp == stamp
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deferred_save_and_question_never_inherit_replacement_session() {
        let ticket = ActionTicket {
            serial: 7,
            generation: 3,
            stamp: [1; 32],
        };
        assert!(ticket.matches(7, 3, [1; 32]));
        assert!(!ticket.matches(8, 3, [1; 32]));
        assert!(!ticket.matches(7, 4, [1; 32]));
        assert!(!ticket.matches(7, 3, [2; 32]));
    }
}
pub(super) fn displayed_matches(token: Option<&str>, session_id: &str, serial: u64) -> bool {
    token.is_some_and(|token| token == format!("{session_id}:{serial}"))
}
#[cfg(test)]
mod displayed_tests {
    use super::*;
    #[test]
    fn stale_displayed_save_close_and_fit_never_bind_to_current_session() {
        assert!(displayed_matches(Some("session-a:7"), "session-a", 7));
        assert!(!displayed_matches(Some("session-a:7"), "session-b", 8));
        assert!(!displayed_matches(Some("session-a:7"), "session-a", 8));
        assert!(!displayed_matches(None, "session-a", 7));
    }
}
