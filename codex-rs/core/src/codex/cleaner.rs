use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Arc;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use askama::Template;
use futures::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use tracing::trace;
use tracing::warn;

use super::Session;
use super::TurnContext;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::codex::compact::content_items_to_text;
use crate::config_types::ContextCleanerConfig;
use crate::protocol::AgentMessageEvent;
use crate::protocol::BackgroundEventEvent;
use crate::protocol::Event;
use crate::protocol::EventMsg;
use crate::protocol::TaskStartedEvent;
use crate::state::TaskKind;
use crate::truncate::truncate_middle;
use codex_protocol::models::ContentItem;
use codex_protocol::models::LocalShellAction;
use codex_protocol::models::ReasoningItemReasoningSummary;
use codex_protocol::models::ResponseItem;

#[derive(Template)]
#[template(path = "cleaner/prompt.md", escape = "none")]
struct CleanerPromptTemplate<'a> {
    history: &'a str,
    max_removals: usize,
}

pub(crate) async fn maybe_run_context_cleaner(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    parent_sub_id: &str,
) {
    if let Err(err) = run_context_cleaner(sess, turn_context, parent_sub_id).await {
        warn!("context cleaner failed: {err:#}");
    }
}

async fn run_context_cleaner(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    parent_sub_id: &str,
) -> Result<()> {
    let config = Arc::clone(turn_context.client.get_config());
    let cleaner_cfg = &config.context_cleaner;
    if !cleaner_cfg.enabled || turn_context.is_review_mode {
        return Ok(());
    }

    let usage_percent = sess.context_usage_percent().await;
    let min_threshold = f32::from(cleaner_cfg.min_usage_percent);
    if usage_below_threshold(usage_percent, min_threshold) {
        if let Some(percent) = usage_percent {
            trace!(
                percent,
                minimum = min_threshold,
                "context cleaner skipping because usage below threshold"
            );
        } else {
            trace!(
                minimum = min_threshold,
                "context cleaner skipping because usage percent unavailable"
            );
        }
        return Ok(());
    }

    let history = sess.history_snapshot().await;
    if history.is_empty() {
        return Ok(());
    }

    let view = HistoryView::build(&history, cleaner_cfg);
    if !view.has_actionable_entries() {
        return Ok(());
    }

    let prompt_text = CleanerPromptTemplate {
        history: &view.formatted,
        max_removals: cleaner_cfg.max_removals_per_turn,
    }
    .render()
    .context("render cleaner prompt")?;

    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText { text: prompt_text }],
        }],
        tools: Vec::new(),
        parallel_tool_calls: false,
        base_instructions_override: None,
        output_schema: Some(build_output_schema(cleaner_cfg)),
    };

    let sub_id = sess.next_internal_sub_id_with_prefix("context-cleaner-");
    let start_event = Event {
        id: sub_id.clone(),
        msg: EventMsg::TaskStarted(TaskStartedEvent {
            model_context_window: turn_context.client.get_model_context_window(),
        }),
    };
    sess.send_event(start_event).await;
    sess.send_event(Event {
        id: sub_id.clone(),
        msg: EventMsg::BackgroundEvent(BackgroundEventEvent {
            message: "Context cleaner inspecting conversation history…".to_string(),
        }),
    })
    .await;

    let mut stream = turn_context
        .client
        .clone()
        .stream_with_task_kind(&prompt, TaskKind::Cleaner)
        .await
        .context("stream cleaner request")?;

    let mut raw_response = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(ResponseEvent::OutputTextDelta(delta)) => raw_response.push_str(&delta),
            Ok(ResponseEvent::OutputItemDone(item)) => {
                if raw_response.is_empty()
                    && let Some(text) = message_text_from_item(&item)
                {
                    raw_response.push_str(&text);
                }
            }
            Ok(ResponseEvent::RateLimits(snapshot)) => {
                sess.update_rate_limits(&sub_id, snapshot).await;
            }
            Ok(ResponseEvent::Completed { token_usage, .. }) => {
                sess.update_token_usage_info(&sub_id, turn_context.as_ref(), token_usage.as_ref())
                    .await;
                break;
            }
            Ok(_) => continue,
            Err(e) => {
                return Err(anyhow!(e).context("context cleaner stream error"));
            }
        }
    }

    if raw_response.trim().is_empty() {
        sess.send_event(Event {
            id: sub_id,
            msg: EventMsg::BackgroundEvent(BackgroundEventEvent {
                message: "Context cleaner produced no output; leaving transcript untouched."
                    .to_string(),
            }),
        })
        .await;
        return Ok(());
    }

    let model_response =
        parse_cleaner_response(&raw_response).context("parse cleaner JSON response")?;
    let outcome = apply_removals(
        Arc::clone(&sess),
        parent_sub_id,
        &sub_id,
        history,
        model_response,
        view,
        cleaner_cfg,
    )
    .await?;

    let summary_message = if outcome.removed_entries.is_empty() {
        "Context cleaner inspected the transcript; no changes were needed.".to_string()
    } else {
        format_removed_summary(&outcome)
    };
    sess.send_event(Event {
        id: sub_id.clone(),
        msg: EventMsg::BackgroundEvent(BackgroundEventEvent {
            message: summary_message,
        }),
    })
    .await;

    if let Some(model_summary) = outcome.model_summary.and_then(normalize_summary) {
        sess.send_event(Event {
            id: sub_id,
            msg: EventMsg::AgentMessage(AgentMessageEvent {
                message: model_summary,
            }),
        })
        .await;
    }

    Ok(())
}

fn build_output_schema(cfg: &ContextCleanerConfig) -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "removals": {
                "type": "array",
                "maxItems": cfg.max_removals_per_turn,
                "items": {
                    "type": "object",
                    "properties": {
                        "entry_id": { "type": "integer", "minimum": 0 },
                        "reason": { "type": ["string", "null"] }
                    },
                    "required": ["entry_id", "reason"],
                    "additionalProperties": false
                }
            },
            "summary": { "type": "string" }
        },
        "required": ["removals", "summary"],
        "additionalProperties": false
    })
}

fn parse_cleaner_response(raw: &str) -> Result<CleanerModelResponse> {
    match serde_json::from_str::<CleanerModelResponse>(raw) {
        Ok(parsed) => Ok(parsed),
        Err(_) => {
            let trimmed = raw.trim();
            if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
                && start < end
            {
                let candidate = &trimmed[start..=end];
                Ok(serde_json::from_str(candidate)?)
            } else {
                Err(anyhow!("context cleaner returned non-JSON output: {raw}"))
            }
        }
    }
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
        let Some(entry) = view.entry_map.get(&removal.entry_id) else {
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

async fn apply_removals(
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

fn format_removed_summary(outcome: &CleanerOutcome) -> String {
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

fn pretty_print_chars(chars: usize) -> String {
    if chars >= 10_000 {
        format!("{:.1}k", chars as f64 / 1000.0)
    } else {
        chars.to_string()
    }
}

fn message_text_from_item(item: &ResponseItem) -> Option<String> {
    if let ResponseItem::Message { content, .. } = item {
        content_items_to_text(content)
    } else {
        None
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CleanerRemoval {
    entry_id: usize,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CleanerModelResponse {
    removals: Vec<CleanerRemoval>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug)]
struct CleanerOutcome {
    removed_entries: Vec<AppliedRemoval>,
    model_summary: Option<String>,
}

#[derive(Debug)]
struct AppliedRemoval {
    entry_id: usize,
    label: String,
    approx_chars: usize,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
enum CleanerEntryKind {
    UserMessage,
    AssistantMessage,
    ShellCall { _command: String },
    ShellOutput { _command: String },
    ToolCall { _name: String },
    ToolOutput { _name: String },
    Other,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    entry_id: usize,
    label: String,
    snippet: String,
    approx_chars: usize,
    truncated_tokens: Option<u64>,
    removal_allowed: bool,
    _kind: CleanerEntryKind,
    notes: Vec<String>,
}

struct HistoryView {
    entries: Vec<HistoryEntry>,
    formatted: String,
    entry_map: HashMap<usize, HistoryEntry>,
}

impl HistoryView {
    fn build(history: &[ResponseItem], cfg: &ContextCleanerConfig) -> Self {
        let start = history.len().saturating_sub(cfg.max_history_items);
        let tail_guard_start = history.len().saturating_sub(cfg.protected_tail_items);
        let shell_calls = collect_shell_calls(history);

        let mut entries = Vec::new();
        for (idx, item) in history.iter().enumerate().skip(start) {
            let mut entry = describe_entry(idx, item, &shell_calls, cfg.max_item_bytes);
            let tail_protected = idx >= tail_guard_start
                && !matches!(entry._kind, CleanerEntryKind::ShellOutput { .. });
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

    fn has_actionable_entries(&self) -> bool {
        self.entries.iter().any(|entry| entry.removal_allowed)
    }
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
            let _kind = if role == "user" {
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
                _kind,
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
                _kind: CleanerEntryKind::ShellCall { _command: command },
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
                    _kind: CleanerEntryKind::ShellOutput {
                        _command: command.clone(),
                    },
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
                    _kind: CleanerEntryKind::ToolOutput {
                        _name: call_id.clone(),
                    },
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
                _kind: CleanerEntryKind::ToolCall {
                    _name: name.clone(),
                },
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
                _kind: CleanerEntryKind::ToolCall {
                    _name: name.clone(),
                },
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
                _kind: CleanerEntryKind::ToolOutput {
                    _name: call_id.clone(),
                },
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
                _kind: CleanerEntryKind::Other,
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
            _kind: CleanerEntryKind::Other,
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

fn usage_below_threshold(usage_percent: Option<f64>, minimum: f32) -> bool {
    match usage_percent {
        Some(percent) => percent < f64::from(minimum),
        None => minimum > 0.0,
    }
}
fn normalize_summary(summary: String) -> Option<String> {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.len() == summary.len() {
        Some(summary)
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;
    use codex_protocol::models::LocalShellExecAction;
    use codex_protocol::models::LocalShellStatus;
    use codex_protocol::models::ResponseItem;
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

    #[test]
    fn history_view_marks_shell_output_removable() {
        let history = vec![
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::InputText {
                    text: "done".to_string(),
                }],
            },
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
        let entry = view.entry_map.get(&1).unwrap();
        assert!(entry.removal_allowed);
    }

    #[test]
    fn history_view_marks_remote_shell_output_removable() {
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
        let entry = view.entry_map.get(&1).unwrap();
        assert!(entry.removal_allowed);
    }

    #[test]
    fn history_view_protects_tail_messages() {
        let history = vec![
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::InputText {
                    text: "done".to_string(),
                }],
            },
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
        assert!(view.entry_map.get(&1).unwrap().removal_allowed);
        assert!(!view.entry_map.get(&2).unwrap().removal_allowed);
        assert!(view.has_actionable_entries());
    }

    #[test]
    fn parse_cleaner_response_extracts_embedded_json() {
        let raw = "Helper note: {\"removals\":[{\"entry_id\":42,\"reason\":\"junk\"}],\"summary\":\"trimmed logs\"}";
        let parsed = parse_cleaner_response(raw).expect("parse fallback");
        assert_eq!(parsed.removals.len(), 1);
        assert_eq!(parsed.removals[0].entry_id, 42);
        assert_eq!(parsed.removals[0].reason.as_deref(), Some("junk"));
        assert_eq!(parsed.summary.as_deref(), Some("trimmed logs"));
    }

    #[test]
    fn history_view_respects_max_history_items() {
        let history = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "turn 1".to_string(),
                }],
            },
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "ok 1"),
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::InputText {
                    text: "done".to_string(),
                }],
            },
        ];
        let cfg = ContextCleanerConfig {
            enabled: true,
            max_history_items: 2,
            protected_tail_items: 0,
            ..ContextCleanerConfig::default()
        };
        let view = HistoryView::build(&history, &cfg);
        assert_eq!(view.entries.len(), 2);
        assert!(view.entry_map.contains_key(&2));
        assert!(view.entry_map.contains_key(&3));
        assert!(!view.entry_map.contains_key(&0));
    }

    #[test]
    fn select_removals_skips_disallowed_entries_and_duplicates() {
        let history = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "instructions".to_string(),
                }],
            },
            shell_call("1", &["pnpm", "test"]),
            shell_output("1", "chunk a"),
            shell_output("1", "chunk b"),
        ];
        let mut cfg = ContextCleanerConfig::default();
        cfg.enabled = true;
        cfg.protected_tail_items = 0;
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
    fn select_removals_honors_max_removals() {
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
    fn format_removed_summary_truncates_reason() {
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

    #[test]
    fn usage_threshold_allows_unknown_usage_when_minimum_zero() {
        assert!(!usage_below_threshold(None, 0.0));
        assert!(!usage_below_threshold(Some(12.5), 0.0));
    }

    #[test]
    fn usage_threshold_skips_when_unknown_usage_and_minimum_positive() {
        assert!(usage_below_threshold(None, 10.0));
        assert!(usage_below_threshold(Some(4.9), 5.0));
        assert!(!usage_below_threshold(Some(5.0), 5.0));
    }
}
