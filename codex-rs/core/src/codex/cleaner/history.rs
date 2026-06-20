use std::collections::HashMap;
use std::fmt::Write as _;

use serde::Deserialize;

use crate::codex::compact::content_items_to_text;
use crate::config_types::ContextCleanerConfig;
use crate::truncate::truncate_middle;
use codex_protocol::models::LocalShellAction;
use codex_protocol::models::ReasoningItemReasoningSummary;
use codex_protocol::models::ResponseItem;

pub(super) struct HistoryView {
    entries: Vec<HistoryEntry>,
    pub(super) formatted: String,
    entry_map: HashMap<usize, HistoryEntry>,
}

impl HistoryView {
    pub(super) fn build(history: &[ResponseItem], cfg: &ContextCleanerConfig) -> Self {
        let start = history.len().saturating_sub(cfg.max_history_items);
        let tail_guard_start = history.len().saturating_sub(cfg.protected_tail_items);
        let shell_calls = collect_shell_calls(history);

        let mut entries = Vec::new();
        for (idx, item) in history.iter().enumerate().skip(start) {
            let mut entry = describe_entry(idx, item, &shell_calls, cfg.max_item_bytes);
            let tail_protected =
                idx >= tail_guard_start && !matches!(entry.kind, CleanerEntryKind::ShellOutput);
            if tail_protected {
                entry.removal_allowed = false;
                entry.notes.push("tail-protected".to_string());
            }
            entries.push(entry);
        }

        let mut formatted_entries = Vec::with_capacity(entries.len());
        let mut entry_map = HashMap::with_capacity(entries.len());
        for entry in &entries {
            entry_map.insert(entry.entry_id, entry.clone());
            formatted_entries.push(format_entry(entry));
        }

        Self {
            entries,
            formatted: formatted_entries.join("\n\n"),
            entry_map,
        }
    }

    pub(super) fn has_actionable_entries(&self) -> bool {
        self.entries.iter().any(|entry| entry.removal_allowed)
    }

    pub(super) fn entry(&self, entry_id: usize) -> Option<&HistoryEntry> {
        self.entry_map.get(&entry_id)
    }
}

#[derive(Debug, Clone)]
pub(super) struct HistoryEntry {
    pub(super) entry_id: usize,
    pub(super) label: String,
    snippet: String,
    pub(super) approx_chars: usize,
    truncated_tokens: Option<u64>,
    pub(super) removal_allowed: bool,
    kind: CleanerEntryKind,
    notes: Vec<String>,
}

#[derive(Debug, Clone)]
enum CleanerEntryKind {
    UserMessage,
    AssistantMessage,
    ShellCall,
    ShellOutput,
    ToolCall,
    ToolOutput,
    Other,
}

#[derive(Debug, Deserialize)]
struct ShellFunctionArgs {
    #[serde(default)]
    command: Vec<String>,
}

fn collect_shell_calls(history: &[ResponseItem]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for item in history {
        match item {
            ResponseItem::LocalShellCall {
                call_id: Some(call_id),
                action: LocalShellAction::Exec(exec),
                ..
            } => {
                map.insert(call_id.clone(), format_shell_command(&exec.command));
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } if name == "shell" => {
                let command = serde_json::from_str::<ShellFunctionArgs>(arguments)
                    .map(|args| format_shell_command(&args.command))
                    .unwrap_or_else(|_| arguments.clone());
                map.insert(call_id.clone(), command);
            }
            _ => {}
        }
    }
    map
}

fn format_shell_command(parts: &[String]) -> String {
    if parts.is_empty() {
        "<empty command>".to_string()
    } else {
        parts.join(" ")
    }
}

fn describe_entry(
    entry_id: usize,
    item: &ResponseItem,
    shell_calls: &HashMap<String, String>,
    max_item_bytes: usize,
) -> HistoryEntry {
    match item {
        ResponseItem::Message { role, content, .. } => {
            let text = content_items_to_text(content).unwrap_or_default();
            let approx_chars = text.len();
            let (snippet, truncated_tokens) = truncate_middle(&text, max_item_bytes);
            let kind = if role == "user" {
                CleanerEntryKind::UserMessage
            } else {
                CleanerEntryKind::AssistantMessage
            };
            HistoryEntry {
                entry_id,
                label: format!("{role} message"),
                snippet,
                approx_chars,
                truncated_tokens,
                removal_allowed: false,
                kind,
                notes: Vec::new(),
            }
        }
        ResponseItem::LocalShellCall {
            call_id,
            status,
            action,
            ..
        } => {
            let command = match action {
                LocalShellAction::Exec(exec) => format_shell_command(&exec.command),
            };
            let mut notes = vec![format!("status: {status:?}")];
            if call_id.is_none() {
                notes.push("missing call_id; paired output may be unavailable".to_string());
            }
            HistoryEntry {
                entry_id,
                label: format!("shell call `{command}`"),
                snippet: command.clone(),
                approx_chars: command.len(),
                truncated_tokens: None,
                removal_allowed: false,
                kind: CleanerEntryKind::ShellCall,
                notes,
            }
        }
        ResponseItem::FunctionCallOutput { call_id, output } => {
            let text = output.content.clone();
            let approx_chars = text.len();
            let (snippet, truncated_tokens) = truncate_middle(&text, max_item_bytes);
            if let Some(command) = shell_calls.get(call_id) {
                HistoryEntry {
                    entry_id,
                    label: format!("shell output for `{command}`"),
                    snippet,
                    approx_chars,
                    truncated_tokens,
                    removal_allowed: true,
                    kind: CleanerEntryKind::ShellOutput,
                    notes: Vec::new(),
                }
            } else {
                HistoryEntry {
                    entry_id,
                    label: format!("tool output (call_id={call_id})"),
                    snippet,
                    approx_chars,
                    truncated_tokens,
                    removal_allowed: false,
                    kind: CleanerEntryKind::ToolOutput,
                    notes: vec!["non-shell output".to_string()],
                }
            }
        }
        ResponseItem::FunctionCall {
            name, arguments, ..
        } => {
            let (snippet, truncated_tokens) = truncate_middle(arguments, max_item_bytes);
            HistoryEntry {
                entry_id,
                label: format!("tool call `{name}`"),
                snippet,
                approx_chars: arguments.len(),
                truncated_tokens,
                removal_allowed: false,
                kind: CleanerEntryKind::ToolCall,
                notes: Vec::new(),
            }
        }
        ResponseItem::CustomToolCall { name, input, .. } => {
            let (snippet, truncated_tokens) = truncate_middle(input, max_item_bytes);
            HistoryEntry {
                entry_id,
                label: format!("custom tool call `{name}`"),
                snippet,
                approx_chars: input.len(),
                truncated_tokens,
                removal_allowed: false,
                kind: CleanerEntryKind::ToolCall,
                notes: Vec::new(),
            }
        }
        ResponseItem::CustomToolCallOutput { call_id, output } => {
            let (snippet, truncated_tokens) = truncate_middle(output, max_item_bytes);
            HistoryEntry {
                entry_id,
                label: format!("custom tool output (call_id={call_id})"),
                snippet,
                approx_chars: output.len(),
                truncated_tokens,
                removal_allowed: false,
                kind: CleanerEntryKind::ToolOutput,
                notes: Vec::new(),
            }
        }
        ResponseItem::Reasoning { summary, .. } => {
            let mut buffer = String::new();
            for item in summary {
                match item {
                    ReasoningItemReasoningSummary::SummaryText { text } => {
                        let _ = writeln!(&mut buffer, "{text}");
                    }
                }
            }
            let (snippet, truncated_tokens) = truncate_middle(&buffer, max_item_bytes);
            HistoryEntry {
                entry_id,
                label: "assistant reasoning".to_string(),
                snippet,
                approx_chars: buffer.len(),
                truncated_tokens,
                removal_allowed: false,
                kind: CleanerEntryKind::Other,
                notes: Vec::new(),
            }
        }
        _ => HistoryEntry {
            entry_id,
            label: format!("{} item", std::any::type_name::<ResponseItem>()),
            snippet: String::new(),
            approx_chars: 0,
            truncated_tokens: None,
            removal_allowed: false,
            kind: CleanerEntryKind::Other,
            notes: vec!["unsupported entry type".to_string()],
        },
    }
}

fn format_entry(entry: &HistoryEntry) -> String {
    let removable = if entry.removal_allowed { "yes" } else { "no" };
    let mut lines = Vec::new();
    lines.push(format!(
        "[{}] {} | removable: {} | chars: {}",
        entry.entry_id, entry.label, removable, entry.approx_chars
    ));
    if let Some(tokens) = entry.truncated_tokens {
        lines.push(format!("note: truncated (~{tokens} tokens removed)"));
    }
    if !entry.notes.is_empty() {
        lines.push(format!("notes: {}", entry.notes.join(", ")));
    }
    if entry.snippet.trim().is_empty() {
        lines.push("snippet: (none)".to_string());
    } else {
        lines.push("snippet:".to_string());
        lines.push(entry.snippet.clone());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::ContentItem;
    use codex_protocol::models::FunctionCallOutputPayload;
    use codex_protocol::models::LocalShellExecAction;
    use codex_protocol::models::LocalShellStatus;
    use pretty_assertions::assert_eq;
    use serde_json::json;

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

    fn remote_shell_call(call_id: &str, command: &[&str]) -> ResponseItem {
        let args = json!({
            "command": command,
            "workdir": "/workspace/codex"
        });
        ResponseItem::FunctionCall {
            id: None,
            name: "shell".to_string(),
            arguments: args.to_string(),
            call_id: call_id.to_string(),
        }
    }

    fn message(role: &str, text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.to_string(),
            content: vec![ContentItem::InputText {
                text: text.to_string(),
            }],
        }
    }

    #[test]
    fn marks_shell_output_removable() {
        let history = vec![
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            message("assistant", "done"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            min_usage_percent: 10,
            max_history_items: 10,
            max_item_bytes: 256,
            max_removals_per_turn: 3,
            protected_tail_items: 0,
        };

        let view = HistoryView::build(&history, &cfg);

        assert!(view.has_actionable_entries());
        let entry = view.entry(1).expect("shell output entry");
        assert!(entry.removal_allowed);
    }

    #[test]
    fn marks_remote_shell_output_removable() {
        let history = vec![
            remote_shell_call("abc", &["bash", "-lc", "echo hello"]),
            shell_output("abc", "hello"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            max_history_items: 10,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };

        let view = HistoryView::build(&history, &cfg);

        assert!(view.has_actionable_entries());
        let entry = view.entry(1).expect("shell output entry");
        assert!(entry.removal_allowed);
    }

    #[test]
    fn protects_tail_messages_without_blocking_tail_shell_outputs() {
        let history = vec![
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            message("assistant", "done"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            min_usage_percent: 10,
            max_history_items: 10,
            max_item_bytes: 256,
            max_removals_per_turn: 3,
            protected_tail_items: 2,
        };

        let view = HistoryView::build(&history, &cfg);

        assert!(view.entry(1).expect("shell output entry").removal_allowed);
        assert!(
            !view
                .entry(2)
                .expect("assistant message entry")
                .removal_allowed
        );
        assert!(view.has_actionable_entries());
    }

    #[test]
    fn respects_max_history_items() {
        let history = vec![
            message("user", "turn 1"),
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            message("assistant", "done"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            max_history_items: 2,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };

        let view = HistoryView::build(&history, &cfg);
        let ids: Vec<usize> = view.entries.iter().map(|entry| entry.entry_id).collect();

        assert_eq!(ids, vec![2, 3]);
        assert!(view.entry(0).is_none());
    }

    #[test]
    fn keeps_non_shell_tool_output_non_removable() {
        let history = vec![
            ResponseItem::FunctionCall {
                id: None,
                name: "read_file".to_string(),
                arguments: "{}".to_string(),
                call_id: "tool-1".to_string(),
            },
            shell_output("tool-1", "important file contents"),
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };

        let view = HistoryView::build(&history, &cfg);
        let entry = view.entry(1).expect("tool output entry");

        assert!(!entry.removal_allowed);
        assert!(!view.has_actionable_entries());
    }
}
