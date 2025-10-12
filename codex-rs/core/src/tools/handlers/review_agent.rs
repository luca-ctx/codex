use async_trait::async_trait;

use crate::codex::spawn_review_thread;
use crate::function_tool::FunctionCallError;
// no extra imports needed for JSON schema here
use crate::protocol::ReviewRequest;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::registry::ToolHandler;
use crate::tools::registry::ToolKind;

pub struct ReviewAgentHandler;

#[async_trait]
impl ToolHandler for ReviewAgentHandler {
    fn kind(&self) -> ToolKind {
        ToolKind::Function
    }

    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError> {
        let ToolInvocation {
            session,
            turn,
            sub_id,
            payload,
            ..
        } = invocation;
        let arguments = match payload {
            ToolPayload::Function { arguments } => arguments,
            _ => {
                return Err(FunctionCallError::RespondToModel(
                    "request_code_review received unsupported payload".to_string(),
                ));
            }
        };

        // Parse optional fields but keep schema loose to avoid tight coupling.
        let value: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|e| FunctionCallError::RespondToModel(format!("invalid arguments: {e}")))?;
        let plan = value
            .get("plan")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let scope = value
            .get("scope")
            .cloned()
            .unwrap_or(serde_json::json!({"type":"head_diff"}));
        let _model_override = value
            .get("model")
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string);

        let human_prompt = format!(
            "Please perform a comprehensive code review.\n\nPlan (optional):\n{plan}\n\nScope:\n{scope}"
        );

        let review_request = ReviewRequest {
            prompt: human_prompt,
            user_facing_hint: "Agent-initiated review".to_string(),
        };

        // Spawn review thread (emits EnteredReviewMode; results streamed back).
        spawn_review_thread(
            session.clone(),
            turn.client.get_config().clone(),
            turn.clone(),
            sub_id.clone(),
            review_request.clone(),
        )
        .await;

        // Acknowledge tool call to the model.
        let content = serde_json::json!({"status":"started","review_request": {"prompt":"(omitted)","user_facing_hint":review_request.user_facing_hint}}).to_string();
        Ok(ToolOutput::Function {
            content,
            success: Some(true),
        })
    }
}
