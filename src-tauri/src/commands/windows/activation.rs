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

pub fn is_workspace(label: &str) -> bool {
    label == "main" || is_remote_workspace(label)
}

/// Prefer the focused workspace, then one already on screen. If all are
/// dismissed, restore a remote before the local window. The label breaks ties
/// deterministically because Tauri returns windows in a HashMap.
pub fn activation_target<'a>(
    windows: impl IntoIterator<Item = (&'a str, bool, bool, bool)>,
) -> Option<&'a str> {
    windows
        .into_iter()
        .filter(|(label, _, _, _)| is_workspace(label))
        .max_by_key(|(label, visible, focused, minimized)| {
            let on_screen = *visible && !*minimized;
            (
                *focused && on_screen,
                on_screen,
                is_remote_workspace(label),
                *label,
            )
        })
        .map(|(label, _, _, _)| label)
}

#[cfg(test)]
mod tests {
    use super::{activation_target, LocalWorkspaceActivation};

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

    #[test]
    fn activating_remote_work_does_not_reopen_hidden_local_workspace() {
        assert_eq!(
            activation_target([
                // Focus loss can arrive after hide during a native animation.
                ("main", false, true, false),
                ("remote-workspace-2", true, false, false),
                ("settings", true, true, false),
            ]),
            Some("remote-workspace-2")
        );
    }

    #[test]
    fn dismissed_remote_can_be_recovered_while_local_stays_hidden() {
        for (visible, minimized) in [(false, false), (true, true)] {
            assert_eq!(
                activation_target([
                    ("main", false, false, false),
                    ("remote-workspace-2", visible, false, minimized),
                    ("pet", true, true, false),
                ]),
                Some("remote-workspace-2")
            );
        }
    }

    #[test]
    fn closing_all_remotes_leaves_the_local_workspace_recoverable() {
        assert_eq!(
            activation_target([
                ("main", false, false, false),
                ("remote-settings-2", true, true, false),
                ("pet", true, false, false),
            ]),
            Some("main")
        );
    }

    #[test]
    fn focused_workspace_wins_among_multiple_workspaces() {
        for focused in ["main", "remote-workspace-1", "remote-workspace-2"] {
            assert_eq!(
                activation_target(
                    ["main", "remote-workspace-1", "remote-workspace-2"].map(|label| (
                        label,
                        true,
                        label == focused,
                        false
                    ))
                ),
                Some(focused)
            );
        }
    }

    #[test]
    fn visible_workspace_wins_over_a_minimized_remote() {
        assert_eq!(
            activation_target([
                ("main", true, false, false),
                ("remote-workspace-2", true, false, true),
            ]),
            Some("main")
        );
    }

    #[test]
    fn auxiliary_windows_never_substitute_for_a_workspace() {
        assert_eq!(
            activation_target([
                ("settings", true, true, false),
                ("remote-settings-2", true, false, false),
                ("browser-tab", true, false, false),
                ("pet", true, false, false),
            ]),
            None
        );
    }
}
