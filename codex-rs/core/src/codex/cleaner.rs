use std::sync::Arc;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use askama::Template;
use futures::StreamExt;
use tracing::trace;
use tracing::warn;

use super::Session;
use super::TurnContext;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::protocol::AgentMessageEvent;
use crate::protocol::BackgroundEventEvent;
use crate::protocol::Event;
use crate::protocol::EventMsg;
use crate::protocol::TaskStartedEvent;
use crate::state::TaskKind;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;

mod history;
mod removal;
mod response;

use history::HistoryView;
use removal::apply_removals;
use removal::format_removed_summary;
use response::build_output_schema;
use response::message_text_from_item;
use response::normalize_summary;
use response::parse_cleaner_response;

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

fn usage_below_threshold(usage_percent: Option<f64>, minimum: f32) -> bool {
    match usage_percent {
        Some(percent) => percent < f64::from(minimum),
        None => minimum > 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
