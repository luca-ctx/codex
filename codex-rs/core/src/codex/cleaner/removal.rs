use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;

use super::history::HistoryView;
use super::response::CleanerModelResponse;
use super::response::CleanerRemoval;
use crate::codex::Session;
use crate::config_types::ContextCleanerConfig;
use crate::truncate::truncate_middle;
use codex_protocol::models::ResponseItem;

#[derive(Debug)]
pub(super) struct CleanerOutcome {
    pub(super) removed_entries: Vec<AppliedRemoval>,
    pub(super) model_summary: Option<String>,
}

#[derive(Debug)]
pub(super) struct AppliedRemoval {
    entry_id: usize,
    label: String,
    approx_chars: usize,
    reason: Option<String>,
}

pub(super) async fn apply_removals(
    sess: Arc<Session>,
    parent_sub_id: &str,
    cleaner_sub_id: &str,
    history: Vec<ResponseItem>,
    model_response: CleanerModelResponse,
    view: HistoryView,
    cfg: &ContextCleanerConfig,
) -> Result<CleanerOutcome> {
    let CleanerModelResponse { removals, summary } = model_response;
    let accepted = select_removals(&view, removals, cfg.max_removals_per_turn);

    if accepted.is_empty() {
        return Ok(CleanerOutcome {
            removed_entries: Vec::new(),
            model_summary: summary,
        });
    }

    let skip: HashSet<usize> = accepted.iter().map(|entry| entry.entry_id).collect();
    let mut new_history = Vec::with_capacity(history.len().saturating_sub(skip.len()));
    for (idx, item) in history.into_iter().enumerate() {
        if skip.contains(&idx) {
            continue;
        }
        new_history.push(item);
    }
    sess.replace_history(new_history).await;

    // Propagate token/event updates so the UI refreshes.
    sess.send_token_count_event(parent_sub_id).await;
    sess.send_token_count_event(cleaner_sub_id).await;

    Ok(CleanerOutcome {
        removed_entries: accepted,
        model_summary: summary,
    })
}

pub(super) fn format_removed_summary(outcome: &CleanerOutcome) -> String {
    let total_chars: usize = outcome
        .removed_entries
        .iter()
        .map(|entry| entry.approx_chars)
        .sum();
    let mut segments = Vec::new();
    for entry in &outcome.removed_entries {
        let reason = entry
            .reason
            .as_ref()
            .and_then(|r| {
                let trimmed = r.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    let (truncated, _) = truncate_middle(trimmed, 120);
                    Some(format!(" – {truncated}"))
                }
            })
            .unwrap_or_default();
        segments.push(format!(
            "#{} {} (~{} chars{})",
            entry.entry_id, entry.label, entry.approx_chars, reason
        ));
    }
    let joined = segments.join("; ");
    format!(
        "Context cleaner removed {} item(s) (~{} chars): {joined}",
        outcome.removed_entries.len(),
        pretty_print_chars(total_chars)
    )
}

fn select_removals(
    view: &HistoryView,
    requested: Vec<CleanerRemoval>,
    max_removals_per_turn: usize,
) -> Vec<AppliedRemoval> {
    let mut accepted = Vec::<AppliedRemoval>::new();
    let mut seen = HashSet::new();

    for removal in requested {
        if accepted.len() >= max_removals_per_turn {
            break;
        }
        if !seen.insert(removal.entry_id) {
            continue;
        }
        let Some(entry) = view.entry(removal.entry_id) else {
            continue;
        };
        if !entry.removal_allowed {
            continue;
        }

        accepted.push(AppliedRemoval {
            entry_id: removal.entry_id,
            label: entry.label.clone(),
            approx_chars: entry.approx_chars,
            reason: removal.reason.clone(),
        });
    }

    accepted
}

fn pretty_print_chars(chars: usize) -> String {
    if chars >= 10_000 {
        format!("{:.1}k", chars as f64 / 1000.0)
    } else {
        chars.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::cleaner::history::HistoryView;
    use codex_protocol::models::FunctionCallOutputPayload;
    use codex_protocol::models::LocalShellAction;
    use codex_protocol::models::LocalShellExecAction;
    use codex_protocol::models::LocalShellStatus;
    use pretty_assertions::assert_eq;

    fn shell_call(call_id: &str, command: &[&str]) -> ResponseItem {
        ResponseItem::LocalShellCall {
            id: None,
            call_id: Some(call_id.to_string()),
            status: LocalShellStatus::Completed,
            action: LocalShellAction::Exec(LocalShellExecAction {
                command: command
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect(),
                timeout_ms: None,
                working_directory: None,
                env: None,
                user: None,
            }),
        }
    }

    fn shell_output(call_id: &str, text: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload {
                content: text.to_string(),
                success: Some(true),
            },
        }
    }

    #[test]
    fn skips_disallowed_entries_and_duplicates() {
        let history = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![codex_protocol::models::ContentItem::InputText {
                    text: "instructions".to_string(),
                }],
            },
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "chunk a"),
            shell_output("1", "chunk b"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };
        let view = HistoryView::build(&history, &cfg);

        let removals = vec![
            CleanerRemoval {
                entry_id: 0,
                reason: Some("should skip user message".to_string()),
            },
            CleanerRemoval {
                entry_id: 2,
                reason: Some("first chunk".to_string()),
            },
            CleanerRemoval {
                entry_id: 2,
                reason: Some("duplicate".to_string()),
            },
            CleanerRemoval {
                entry_id: 3,
                reason: None,
            },
            CleanerRemoval {
                entry_id: 42,
                reason: Some("unknown".to_string()),
            },
        ];

        let selected = select_removals(&view, removals, 5);
        let summary: Vec<(usize, Option<String>)> = selected
            .into_iter()
            .map(|entry| (entry.entry_id, entry.reason))
            .collect();

        assert_eq!(
            summary,
            vec![(2, Some("first chunk".to_string())), (3, None),]
        );
    }

    #[test]
    fn honors_max_removals() {
        let history = vec![
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "chunk a"),
            shell_output("1", "chunk b"),
            shell_output("1", "chunk c"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };
        let view = HistoryView::build(&history, &cfg);

        let removals = vec![
            CleanerRemoval {
                entry_id: 1,
                reason: None,
            },
            CleanerRemoval {
                entry_id: 2,
                reason: None,
            },
            CleanerRemoval {
                entry_id: 3,
                reason: None,
            },
        ];

        let selected = select_removals(&view, removals, 2);
        let ids: Vec<usize> = selected.into_iter().map(|entry| entry.entry_id).collect();

        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn removed_summary_truncates_reason() {
        let outcome = CleanerOutcome {
            removed_entries: vec![AppliedRemoval {
                entry_id: 5,
                label: "shell output for `pnpm test`".to_string(),
                approx_chars: 1200,
                reason: Some("a".repeat(200)),
            }],
            model_summary: None,
        };

        let summary = format_removed_summary(&outcome);

        assert!(summary.contains("~1200 chars"));
        assert!(summary.contains("#5"));
        assert!(!summary.contains(&"a".repeat(200)));
    }
}
