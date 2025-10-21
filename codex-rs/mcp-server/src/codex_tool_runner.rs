//! Asynchronous worker that executes a **Codex** tool-call inside a spawned
//! Tokio task. Separated from `message_processor.rs` to keep that file small
//! and to make future feature-growth easier to manage.

use std::collections::HashMap;
use std::sync::Arc;

use crate::exec_approval::handle_exec_approval_request;
use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::OutgoingNotificationMeta;
use crate::patch_approval::handle_patch_approval_request;
use codex_core::CodexConversation;
use codex_core::ConversationManager;
use codex_core::NewConversation;
use codex_core::config::Config as CodexConfig;
use codex_core::protocol::AgentMessageEvent;
use codex_core::protocol::ApplyPatchApprovalRequestEvent;
use codex_core::protocol::Event;
use codex_core::protocol::EventMsg;
use codex_core::protocol::ExecApprovalRequestEvent;
use codex_core::protocol::InputItem;
use codex_core::protocol::Op;
use codex_core::protocol::Submission;
use codex_core::protocol::TaskCompleteEvent;
use codex_protocol::ConversationId;
use mcp_types::CallToolResult;
use mcp_types::ContentBlock;
use mcp_types::RequestId;
use mcp_types::TextContent;
use serde_json::json;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

pub(crate) const INVALID_PARAMS_ERROR_CODE: i64 = -32602;

#[derive(Debug, Clone)]
pub(crate) struct RequestConversationEntry {
    pub conversation_id: ConversationId,
    pub sub_id: String,
}

impl RequestConversationEntry {
    pub fn new(conversation_id: ConversationId, sub_id: String) -> Self {
        Self {
            conversation_id,
            sub_id,
        }
    }
}

pub(crate) type RequestConversationsMap = HashMap<RequestId, Vec<RequestConversationEntry>>;

pub(crate) async fn add_request_conversation(
    map: &Arc<Mutex<RequestConversationsMap>>,
    request_id: &RequestId,
    entry: RequestConversationEntry,
) {
    let mut guard = map.lock().await;
    guard.entry(request_id.clone()).or_default().push(entry);
}

pub(crate) async fn remove_request_conversation(
    map: &Arc<Mutex<RequestConversationsMap>>,
    request_id: &RequestId,
    conversation_id: ConversationId,
) {
    let mut guard = map.lock().await;
    if let Some(entries) = guard.get_mut(request_id) {
        entries.retain(|entry| entry.conversation_id != conversation_id);
        if entries.is_empty() {
            guard.remove(request_id);
        }
    }
}

pub(crate) async fn clone_request_conversations(
    map: &Arc<Mutex<RequestConversationsMap>>,
    request_id: &RequestId,
) -> Option<Vec<RequestConversationEntry>> {
    let guard = map.lock().await;
    guard.get(request_id).cloned()
}

#[derive(Debug)]
pub(crate) enum ToolCallCompletion {
    Call(CallToolResult),
    Raw(serde_json::Value),
}

/// Run a complete Codex session and stream events back to the client.
///
/// On completion (success or error) the function sends the appropriate
/// `tools/call` response so the LLM can continue the conversation.
pub async fn run_codex_tool_session(
    id: RequestId,
    initial_prompt: String,
    config: CodexConfig,
    outgoing: Arc<OutgoingMessageSender>,
    conversation_manager: Arc<ConversationManager>,
    running_requests_id_to_codex_uuid: Arc<Mutex<RequestConversationsMap>>,
) {
    let NewConversation {
        conversation_id,
        conversation,
        session_configured,
    } = match conversation_manager.new_conversation(config).await {
        Ok(res) => res,
        Err(e) => {
            let result = CallToolResult {
                content: vec![ContentBlock::TextContent(TextContent {
                    r#type: "text".to_string(),
                    text: format!("Failed to start Codex session: {e}"),
                    annotations: None,
                })],
                is_error: Some(true),
                structured_content: None,
            };
            outgoing.send_response(id.clone(), result).await;
            return;
        }
    };

    let session_configured_event = Event {
        // Use a fake id value for now.
        id: "".to_string(),
        msg: EventMsg::SessionConfigured(session_configured.clone()),
    };
    outgoing
        .send_event_as_notification(
            &session_configured_event,
            Some(OutgoingNotificationMeta::new(Some(id.clone()))),
        )
        .await;

    // Use the original MCP request ID as the `sub_id` for the Codex submission so that
    // any events emitted for this tool-call can be correlated with the
    // originating `tools/call` request.
    let sub_id = request_id_to_string(&id);
    add_request_conversation(
        &running_requests_id_to_codex_uuid,
        &id,
        RequestConversationEntry::new(conversation_id, sub_id.clone()),
    )
    .await;
    let submission = Submission {
        id: sub_id.clone(),
        op: Op::UserInput {
            items: vec![InputItem::Text {
                text: initial_prompt.clone(),
            }],
        },
    };

    if let Err(e) = conversation.submit_with_id(submission).await {
        tracing::error!("Failed to submit initial prompt: {e}");
        remove_request_conversation(&running_requests_id_to_codex_uuid, &id, conversation_id).await;
        return;
    }

    let completion = run_codex_tool_session_inner(
        conversation,
        outgoing.clone(),
        id.clone(),
        running_requests_id_to_codex_uuid,
        conversation_id,
        sub_id,
    )
    .await;

    match completion {
        ToolCallCompletion::Call(result) => {
            outgoing.send_response(id, result).await;
        }
        ToolCallCompletion::Raw(value) => {
            outgoing.send_response(id, value).await;
        }
    }
}

pub async fn run_codex_tool_session_reply(
    conversation: Arc<CodexConversation>,
    outgoing: Arc<OutgoingMessageSender>,
    request_id: RequestId,
    prompt: String,
    running_requests_id_to_codex_uuid: Arc<Mutex<RequestConversationsMap>>,
    conversation_id: ConversationId,
) {
    let sub_id = request_id_to_string(&request_id);
    add_request_conversation(
        &running_requests_id_to_codex_uuid,
        &request_id,
        RequestConversationEntry::new(conversation_id, sub_id.clone()),
    )
    .await;
    if let Err(e) = conversation
        .submit(Op::UserInput {
            items: vec![InputItem::Text { text: prompt }],
        })
        .await
    {
        tracing::error!("Failed to submit user input: {e}");
        // unregister the id so we don't keep it in the map
        remove_request_conversation(
            &running_requests_id_to_codex_uuid,
            &request_id,
            conversation_id,
        )
        .await;
        return;
    }

    let completion = run_codex_tool_session_inner(
        conversation,
        outgoing.clone(),
        request_id.clone(),
        running_requests_id_to_codex_uuid,
        conversation_id,
        sub_id,
    )
    .await;

    match completion {
        ToolCallCompletion::Call(result) => {
            outgoing.send_response(request_id, result).await;
        }
        ToolCallCompletion::Raw(value) => {
            outgoing.send_response(request_id, value).await;
        }
    }
}

pub(crate) async fn run_codex_tool_session_inner(
    codex: Arc<CodexConversation>,
    outgoing: Arc<OutgoingMessageSender>,
    request_id: RequestId,
    running_requests_id_to_codex_uuid: Arc<Mutex<RequestConversationsMap>>,
    conversation_id: ConversationId,
    tool_call_id: String,
) -> ToolCallCompletion {
    // Stream events until the task needs to pause for user interaction or
    // completes.
    loop {
        match codex.next_event().await {
            Ok(event) => {
                outgoing
                    .send_event_as_notification(
                        &event,
                        Some(OutgoingNotificationMeta::new(Some(request_id.clone()))),
                    )
                    .await;

                match event.msg {
                    EventMsg::ExecApprovalRequest(ExecApprovalRequestEvent {
                        command,
                        cwd,
                        call_id,
                        reason: _,
                        parsed_cmd,
                    }) => {
                        handle_exec_approval_request(
                            command,
                            cwd,
                            outgoing.clone(),
                            codex.clone(),
                            request_id.clone(),
                            tool_call_id.clone(),
                            event.id.clone(),
                            call_id,
                            parsed_cmd,
                        )
                        .await;
                        continue;
                    }
                    EventMsg::Error(err_event) => {
                        // Return a response to conclude the tool call when the Codex session reports an error (e.g., interruption).
                        let result = json!({
                            "error": err_event.message,
                        });
                        remove_request_conversation(
                            &running_requests_id_to_codex_uuid,
                            &request_id,
                            conversation_id,
                        )
                        .await;
                        return ToolCallCompletion::Raw(result);
                    }
                    EventMsg::ApplyPatchApprovalRequest(ApplyPatchApprovalRequestEvent {
                        call_id,
                        reason,
                        grant_root,
                        changes,
                    }) => {
                        handle_patch_approval_request(
                            call_id,
                            reason,
                            grant_root,
                            changes,
                            outgoing.clone(),
                            codex.clone(),
                            request_id.clone(),
                            tool_call_id.clone(),
                            event.id.clone(),
                        )
                        .await;
                        continue;
                    }
                    EventMsg::TaskComplete(TaskCompleteEvent { last_agent_message }) => {
                        let text = match last_agent_message {
                            Some(msg) => msg,
                            None => "".to_string(),
                        };
                        let result = CallToolResult {
                            content: vec![ContentBlock::TextContent(TextContent {
                                r#type: "text".to_string(),
                                text,
                                annotations: None,
                            })],
                            is_error: None,
                            structured_content: None,
                        };
                        remove_request_conversation(
                            &running_requests_id_to_codex_uuid,
                            &request_id,
                            conversation_id,
                        )
                        .await;
                        return ToolCallCompletion::Call(result);
                    }
                    EventMsg::SessionConfigured(_) => {
                        tracing::error!("unexpected SessionConfigured event");
                    }
                    EventMsg::AgentMessageDelta(_) => {
                        // TODO: think how we want to support this in the MCP
                    }
                    EventMsg::AgentReasoningDelta(_) => {
                        // TODO: think how we want to support this in the MCP
                    }
                    EventMsg::AgentMessage(AgentMessageEvent { .. }) => {
                        // TODO: think how we want to support this in the MCP
                    }
                    EventMsg::SessionTerminated(_) => {
                        // Return a response indicating termination.
                        let result = json!({
                            "terminated": true
                        });
                        remove_request_conversation(
                            &running_requests_id_to_codex_uuid,
                            &request_id,
                            conversation_id,
                        )
                        .await;
                        return ToolCallCompletion::Raw(result);
                    }
                    EventMsg::AgentReasoningRawContent(_)
                    | EventMsg::AgentReasoningRawContentDelta(_)
                    | EventMsg::TaskStarted(_)
                    | EventMsg::TokenCount(_)
                    | EventMsg::AgentReasoning(_)
                    | EventMsg::AgentReasoningSectionBreak(_)
                    | EventMsg::McpToolCallBegin(_)
                    | EventMsg::McpToolCallEnd(_)
                    | EventMsg::McpListToolsResponse(_)
                    | EventMsg::ListCustomPromptsResponse(_)
                    | EventMsg::ExecCommandBegin(_)
                    | EventMsg::ExecCommandOutputDelta(_)
                    | EventMsg::ExecCommandEnd(_)
                    | EventMsg::BackgroundEvent(_)
                    | EventMsg::StreamError(_)
                    | EventMsg::PatchApplyBegin(_)
                    | EventMsg::PatchApplyEnd(_)
                    | EventMsg::TurnDiff(_)
                    | EventMsg::WebSearchBegin(_)
                    | EventMsg::WebSearchEnd(_)
                    | EventMsg::GetHistoryEntryResponse(_)
                    | EventMsg::PlanUpdate(_)
                    | EventMsg::TurnAborted(_)
                    | EventMsg::SessionRenamed(_)
                    | EventMsg::ConversationPath(_)
                    | EventMsg::UserMessage(_)
                    | EventMsg::ShutdownComplete
                    | EventMsg::ViewImageToolCall(_)
                    | EventMsg::EnteredReviewMode(_)
                    | EventMsg::ExitedReviewMode(_) => {
                        // For now, we do not do anything extra for these
                        // events. Note that
                        // send(codex_event_to_notification(&event)) above has
                        // already dispatched these events as notifications,
                        // though we may want to do give different treatment to
                        // individual events in the future.
                    }
                }
            }
            Err(e) => {
                let result = CallToolResult {
                    content: vec![ContentBlock::TextContent(TextContent {
                        r#type: "text".to_string(),
                        text: format!("Codex runtime error: {e}"),
                        annotations: None,
                    })],
                    is_error: Some(true),
                    // TODO(mbolin): Could present the error in a more
                    // structured way.
                    structured_content: None,
                };
                remove_request_conversation(
                    &running_requests_id_to_codex_uuid,
                    &request_id,
                    conversation_id,
                )
                .await;
                return ToolCallCompletion::Call(result);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct BatchSessionConfig {
    pub index: usize,
    pub label: Option<String>,
    pub prompt: String,
    pub config: CodexConfig,
}

#[derive(Debug)]
pub struct BatchSessionResult {
    pub index: usize,
    pub label: Option<String>,
    pub conversation_id: Option<ConversationId>,
    pub completion: ToolCallCompletion,
}

pub async fn run_codex_batch_sessions(
    request_id: RequestId,
    outgoing: Arc<OutgoingMessageSender>,
    conversation_manager: Arc<ConversationManager>,
    running_requests_id_to_codex_uuid: Arc<Mutex<RequestConversationsMap>>,
    sessions: Vec<BatchSessionConfig>,
) -> Vec<BatchSessionResult> {
    let mut join_set = JoinSet::new();

    for session in sessions {
        let outgoing = outgoing.clone();
        let conversation_manager = conversation_manager.clone();
        let running_requests_id_to_codex_uuid = running_requests_id_to_codex_uuid.clone();
        let request_id = request_id.clone();
        join_set.spawn(run_single_batch_session(
            request_id,
            outgoing,
            conversation_manager,
            running_requests_id_to_codex_uuid,
            session,
        ));
    }

    let mut results = Vec::new();
    while let Some(result) = join_set.join_next().await {
        match result {
            Ok(value) => results.push(value),
            Err(err) => {
                tracing::error!("batch session task failed: {err}");
            }
        }
    }

    results.sort_by_key(|res| res.index);
    results
}

#[allow(clippy::too_many_arguments)]
async fn run_single_batch_session(
    request_id: RequestId,
    outgoing: Arc<OutgoingMessageSender>,
    conversation_manager: Arc<ConversationManager>,
    running_requests_id_to_codex_uuid: Arc<Mutex<RequestConversationsMap>>,
    session: BatchSessionConfig,
) -> BatchSessionResult {
    let BatchSessionConfig {
        index,
        label,
        prompt,
        config,
    } = session;

    let sub_id = format!("{}:{}", request_id_to_string(&request_id), index);

    let new_conversation = match conversation_manager.new_conversation(config).await {
        Ok(conv) => conv,
        Err(e) => {
            let result = CallToolResult {
                content: vec![ContentBlock::TextContent(TextContent {
                    r#type: "text".to_string(),
                    text: format!("Failed to start Codex session: {e}"),
                    annotations: None,
                })],
                is_error: Some(true),
                structured_content: None,
            };
            return BatchSessionResult {
                index,
                label,
                conversation_id: None,
                completion: ToolCallCompletion::Call(result),
            };
        }
    };

    let NewConversation {
        conversation_id,
        conversation,
        session_configured,
    } = new_conversation;

    let session_configured_event = Event {
        id: "".to_string(),
        msg: EventMsg::SessionConfigured(session_configured.clone()),
    };
    outgoing
        .send_event_as_notification(
            &session_configured_event,
            Some(OutgoingNotificationMeta::new(Some(request_id.clone()))),
        )
        .await;

    add_request_conversation(
        &running_requests_id_to_codex_uuid,
        &request_id,
        RequestConversationEntry::new(conversation_id, sub_id.clone()),
    )
    .await;

    let submission = Submission {
        id: sub_id.clone(),
        op: Op::UserInput {
            items: vec![InputItem::Text {
                text: prompt.clone(),
            }],
        },
    };

    if let Err(e) = conversation.submit_with_id(submission).await {
        tracing::error!("Failed to submit initial prompt: {e}");
        remove_request_conversation(
            &running_requests_id_to_codex_uuid,
            &request_id,
            conversation_id,
        )
        .await;
        let result = CallToolResult {
            content: vec![ContentBlock::TextContent(TextContent {
                r#type: "text".to_string(),
                text: format!("Failed to submit initial prompt: {e}"),
                annotations: None,
            })],
            is_error: Some(true),
            structured_content: None,
        };
        return BatchSessionResult {
            index,
            label,
            conversation_id: Some(conversation_id),
            completion: ToolCallCompletion::Call(result),
        };
    }

    let completion = run_codex_tool_session_inner(
        conversation,
        outgoing,
        request_id,
        running_requests_id_to_codex_uuid,
        conversation_id,
        sub_id,
    )
    .await;

    BatchSessionResult {
        index,
        label,
        conversation_id: Some(conversation_id),
        completion,
    }
}

pub(crate) fn request_id_to_string(id: &RequestId) -> String {
    match id {
        RequestId::String(s) => s.clone(),
        RequestId::Integer(n) => n.to_string(),
    }
}
