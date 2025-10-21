use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;

use codex_core::protocol::SessionName;
use codex_protocol::ConversationId;
use tracing::debug;
use tracing::warn;

pub struct TurnFinishedHookContext<'a> {
    pub conversation_id: Option<&'a ConversationId>,
    pub session_name: Option<&'a SessionName>,
}

pub trait TurnFinishedHookRunner: Send + Sync {
    fn run(&self, command: &str, context: &TurnFinishedHookContext);
}

#[derive(Default)]
pub struct ShellTurnFinishedHookRunner;

impl TurnFinishedHookRunner for ShellTurnFinishedHookRunner {
    fn run(&self, command: &str, context: &TurnFinishedHookContext) {
        if command.trim().is_empty() {
            return;
        }

        debug!("running onAgentTurnFinished hook: {command}");

        #[cfg(windows)]
        let spawn_result = {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", command]);
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
            if let Some(id) = context.conversation_id {
                cmd.env("CODEX_SESSION_ID", id.to_string());
            }
            if let Some(name) = context.session_name {
                cmd.env("CODEX_SESSION_NAME", &name.title);
                cmd.env("CODEX_SESSION_SLUG", &name.slug);
            }
            cmd.spawn()
        };

        #[cfg(not(windows))]
        let spawn_result = {
            let mut cmd = Command::new("sh");
            cmd.arg("-lc").arg(command);
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
            if let Some(id) = context.conversation_id {
                cmd.env("CODEX_SESSION_ID", id.to_string());
            }
            if let Some(name) = context.session_name {
                cmd.env("CODEX_SESSION_NAME", &name.title);
                cmd.env("CODEX_SESSION_SLUG", &name.slug);
            }
            cmd.spawn()
        };

        if let Err(err) = spawn_result {
            warn!("failed to run onAgentTurnFinished hook: {err}");
        }
    }
}

pub fn default_turn_finished_hook_runner() -> Arc<dyn TurnFinishedHookRunner> {
    Arc::new(ShellTurnFinishedHookRunner)
}
