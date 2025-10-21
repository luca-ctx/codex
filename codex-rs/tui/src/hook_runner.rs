use std::process::Command;
use std::sync::Arc;

use tracing::debug;
use tracing::warn;

pub trait TurnFinishedHookRunner: Send + Sync {
    fn run(&self, command: &str);
}

#[derive(Default)]
pub struct ShellTurnFinishedHookRunner;

impl TurnFinishedHookRunner for ShellTurnFinishedHookRunner {
    fn run(&self, command: &str) {
        if command.trim().is_empty() {
            return;
        }

        debug!("running onAgentTurnFinished hook: {command}");

        #[cfg(windows)]
        let spawn_result = Command::new("cmd").args(["/C", command]).spawn();

        #[cfg(not(windows))]
        let spawn_result = Command::new("sh").arg("-lc").arg(command).spawn();

        if let Err(err) = spawn_result {
            warn!("failed to run onAgentTurnFinished hook: {err}");
        }
    }
}

pub fn default_turn_finished_hook_runner() -> Arc<dyn TurnFinishedHookRunner> {
    Arc::new(ShellTurnFinishedHookRunner)
}
