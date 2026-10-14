//! Workspace selection for Dock, tray and ordinary second-launch activation.

use std::sync::atomic::{AtomicU64, Ordering};

/// A local restore supersedes remote hides queued before it. A fullscreen
/// transition can defer the hide long enough for another user action to win.
#[derive(Default)]
pub struct LocalWorkspaceActivation(AtomicU64);

impl LocalWorkspaceActivation {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }

    pub fn snapshot(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn record_restore(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }

    pub fn unchanged_since(&self, snapshot: u64) -> bool {
        self.snapshot() == snapshot
    }
}

pub fn is_remote_workspace(label: &str) -> bool {
    label.starts_with("remote-workspace-")
}

#[cfg(test)]
mod tests {
    use super::LocalWorkspaceActivation;

    #[test]
    fn local_restore_cancels_a_pending_hide_but_allows_later_remote_requests() {
        let activation = LocalWorkspaceActivation::new();
        let before_fullscreen_drain = activation.snapshot();
        assert!(activation.unchanged_since(before_fullscreen_drain));

        activation.record_restore();
        assert!(!activation.unchanged_since(before_fullscreen_drain));

        let later_remote_request = activation.snapshot();
        assert!(activation.unchanged_since(later_remote_request));
        activation.record_restore();
        assert!(!activation.unchanged_since(later_remote_request));
    }
}
