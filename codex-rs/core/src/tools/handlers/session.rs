use async_trait::async_trait;

use crate::function_tool::FunctionCallError;
use crate::protocol::Event;
use crate::protocol::EventMsg;
use crate::protocol::SessionTerminatedEvent;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::registry::ToolHandler;
use crate::tools::registry::ToolKind;

pub struct SessionHandler;

#[async_trait]
impl ToolHandler for SessionHandler {
    fn kind(&self) -> ToolKind {
        ToolKind::Function
    }

    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError> {
        let ToolInvocation {
            session,
            sub_id,
            payload,
            ..
        } = invocation;
        match payload {
            ToolPayload::Function { .. } | ToolPayload::UnifiedExec { .. } => {
                // Emit termination event; frontends should disable keep-going upon receipt.
                session
                    .send_event(Event {
                        id: sub_id,
                        msg: EventMsg::SessionTerminated(SessionTerminatedEvent {
                            message: "Session permanently terminated by the agent".to_string(),
                        }),
                    })
                    .await;
                Ok(ToolOutput::Function {
                    content: "Session terminated".to_string(),
                    success: Some(true),
                })
            }
            _ => Err(FunctionCallError::RespondToModel(
                "permanently_terminate_session received unsupported payload".to_string(),
            )),
        }
    }
}


