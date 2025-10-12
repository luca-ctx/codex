use async_trait::async_trait;
use std::sync::Arc;

use crate::client::ModelClient;
use crate::codex::TurnContext;
use crate::codex::run_task;
use crate::function_tool::FunctionCallError;
use crate::model_family::find_family_for_model;
use crate::openai_model_info::get_model_info;
use crate::openai_tools::ToolsConfig;
use crate::openai_tools::ToolsConfigParams;
use crate::protocol::InputItem;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::registry::ToolHandler;
use crate::tools::registry::ToolKind;

pub struct DelegateWorkerHandler;

#[async_trait]
impl ToolHandler for DelegateWorkerHandler {
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
        let args = match payload {
            ToolPayload::Function { arguments } => arguments,
            _ => {
                return Err(FunctionCallError::RespondToModel(
                    "delegate_to_worker received unsupported payload".to_string(),
                ));
            }
        };

        let value: serde_json::Value = serde_json::from_str(&args)
            .map_err(|e| FunctionCallError::RespondToModel(format!("invalid arguments: {e}")))?;
        let worker_plan = value
            .get("worker_plan")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                FunctionCallError::RespondToModel("worker_plan is required".to_string())
            })?
            .to_string();
        let worker_model = value
            .get("worker_model")
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string);

        // Build per-turn worker context with possibly different model.
        let mut per_turn_config = (**turn.client.get_config()).clone();
        if let Some(model) = worker_model.clone() {
            per_turn_config.model = model.clone();
            per_turn_config.model_family =
                find_family_for_model(&model).unwrap_or_else(|| turn.client.get_model_family());
            if let Some(info) = get_model_info(&per_turn_config.model_family) {
                per_turn_config.model_context_window = Some(info.context_window);
            }
        }
        let per_turn_config = Arc::new(per_turn_config);
        let client = ModelClient::new(
            Arc::clone(&per_turn_config),
            turn.client.get_auth_manager(),
            turn.client.get_otel_event_manager(),
            turn.client.get_provider(),
            turn.client.get_reasoning_effort(),
            turn.client.get_reasoning_summary(),
            turn.client.get_conversation_id(),
        );
        let tools_config = ToolsConfig::new(&ToolsConfigParams {
            model_family: &client.get_model_family(),
            include_plan_tool: turn.tools_config.plan_tool,
            include_apply_patch_tool: per_turn_config.include_apply_patch_tool,
            include_web_search_request: false,
            use_streamable_shell_tool: false,
            include_view_image_tool: per_turn_config.include_view_image_tool,
            experimental_unified_exec_tool: per_turn_config.use_experimental_unified_exec_tool,
        });
        let worker_turn = Arc::new(TurnContext {
            client,
            tools_config,
            user_instructions: None,
            base_instructions: Some(
                "You are a focused coding worker. Execute the manager's plan precisely."
                    .to_string(),
            ),
            approval_policy: turn.approval_policy,
            sandbox_policy: turn.sandbox_policy.clone(),
            shell_environment_policy: turn.shell_environment_policy.clone(),
            cwd: turn.cwd.clone(),
            is_review_mode: false,
            final_output_json_schema: None,
        });

        // Seed with the worker plan as a user message and run to completion.
        let input = vec![InputItem::Text { text: worker_plan }];
        let worker_sub_id = format!("{sub_id}.worker");
        run_task(session.clone(), worker_turn, worker_sub_id, input).await;

        let content =
            serde_json::json!({"status":"completed","worker_model":worker_model}).to_string();
        Ok(ToolOutput::Function {
            content,
            success: Some(true),
        })
    }
}
