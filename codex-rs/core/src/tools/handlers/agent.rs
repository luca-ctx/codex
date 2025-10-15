use async_trait::async_trait;
use std::sync::Arc;

use crate::agent::AgentRegistry;
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

#[derive(serde::Deserialize)]
struct AgentArgs {
    task: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

pub struct AgentHandler;

#[async_trait]
impl ToolHandler for AgentHandler {
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
                    "agent tool received unsupported payload".to_string(),
                ));
            }
        };

        let args: AgentArgs = serde_json::from_str(&args).map_err(|e| {
            FunctionCallError::RespondToModel(format!("invalid agent arguments: {e}"))
        })?;

        let registry = AgentRegistry::global();
        let agent_prompt = registry.system_prompt(args.agent.as_deref());

        // Customize per-turn configuration (model overrides allowed).
        let mut per_turn_config = (**turn.client.get_config()).clone();
        if let Some(model) = args.model.as_ref() {
            per_turn_config.model = model.clone();
            per_turn_config.model_family =
                find_family_for_model(model).unwrap_or_else(|| turn.client.get_model_family());
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

        let mut tools_config = ToolsConfig::new(&ToolsConfigParams {
            model_family: &client.get_model_family(),
            include_plan_tool: turn.tools_config.plan_tool,
            include_apply_patch_tool: per_turn_config.include_apply_patch_tool,
            include_web_search_request: false,
            use_streamable_shell_tool: false,
            include_view_image_tool: per_turn_config.include_view_image_tool,
            experimental_unified_exec_tool: per_turn_config.use_experimental_unified_exec_tool,
            include_agent_tool: false,
        });
        // Preserve experimental tools from parent context.
        tools_config.experimental_supported_tools =
            turn.tools_config.experimental_supported_tools.clone();

        let agent_turn = Arc::new(TurnContext {
            client,
            tools_config,
            user_instructions: Some(agent_prompt),
            base_instructions: None,
            approval_policy: turn.approval_policy,
            sandbox_policy: turn.sandbox_policy.clone(),
            shell_environment_policy: turn.shell_environment_policy.clone(),
            cwd: turn.cwd.clone(),
            is_review_mode: false,
            final_output_json_schema: None,
        });

        let task_message = if let Some(context) = args.context {
            format!(
                "{task}\n\nAdditional context:\n{context}",
                task = args.task.trim()
            )
        } else {
            args.task.trim().to_string()
        };
        let input = vec![InputItem::Text { text: task_message }];
        let agent_sub_id = format!("{sub_id}.agent");
        run_task(session.clone(), agent_turn, agent_sub_id, input).await;

        let response = serde_json::json!({
            "status": "completed",
            "agent": args.agent,
        })
        .to_string();

        Ok(ToolOutput::Function {
            content: response,
            success: Some(true),
        })
    }
}
