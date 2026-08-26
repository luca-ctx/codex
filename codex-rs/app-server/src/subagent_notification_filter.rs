use std::collections::HashSet;
use std::ffi::OsStr;
use std::sync::RwLock;

use codex_protocol::ThreadId;

pub(crate) const SUPPRESS_SUBAGENT_NOTIFICATIONS_ENV_VAR: &str =
    "CODEX_APP_SERVER_SUPPRESS_SUBAGENT_NOTIFICATIONS";

/// Tracks subagent threads whose app-server notifications should not leave the process.
///
/// The filter is deliberately limited to notifications. Requests, responses, and errors
/// continue to use the normal transport path so subagents can still request approvals and
/// participate in parent-thread orchestration.
pub(crate) struct SubagentNotificationFilter {
    enabled: bool,
    thread_ids: RwLock<HashSet<ThreadId>>,
}

impl SubagentNotificationFilter {
    pub(crate) fn from_env() -> Self {
        Self::new(env_value_is_enabled(std::env::var_os(
            SUPPRESS_SUBAGENT_NOTIFICATIONS_ENV_VAR,
        )))
    }

    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            thread_ids: RwLock::new(HashSet::new()),
        }
    }

    pub(crate) fn register(&self, thread_id: ThreadId) {
        if !self.enabled {
            return;
        }
        self.thread_ids
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread_id);
    }

    pub(crate) fn should_suppress(&self, thread_id: ThreadId) -> bool {
        self.enabled
            && self
                .thread_ids
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&thread_id)
    }

    pub(crate) fn unregister(&self, thread_id: ThreadId) {
        if !self.enabled {
            return;
        }
        self.thread_ids
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&thread_id);
    }

    #[cfg(test)]
    pub(crate) fn enabled_for_test() -> Self {
        Self::new(true)
    }
}

fn env_value_is_enabled(value: Option<impl AsRef<OsStr>>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value
                .as_ref()
                .to_string_lossy()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(test)]
#[path = "subagent_notification_filter_tests.rs"]
mod tests;
