use anyhow::Result;
use anyhow::anyhow;
use serde::Deserialize;
use serde::Serialize;

use crate::codex::compact::content_items_to_text;
use crate::config_types::ContextCleanerConfig;
use codex_protocol::models::ResponseItem;

pub(super) fn build_output_schema(cfg: &ContextCleanerConfig) -> serde_json::Value {
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

pub(super) fn parse_cleaner_response(raw: &str) -> Result<CleanerModelResponse> {
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

pub(super) fn message_text_from_item(item: &ResponseItem) -> Option<String> {
    if let ResponseItem::Message { content, .. } = item {
        content_items_to_text(content)
    } else {
        None
    }
}

pub(super) fn normalize_summary(summary: String) -> Option<String> {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.len() == summary.len() {
        Some(summary)
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CleanerRemoval {
    pub(super) entry_id: usize,
    #[serde(default)]
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CleanerModelResponse {
    pub(super) removals: Vec<CleanerRemoval>,
    #[serde(default)]
    pub(super) summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn extracts_embedded_json_response() {
        let raw = "Helper note: {\"removals\":[{\"entry_id\":42,\"reason\":\"junk\"}],\"summary\":\"trimmed logs\"}";

        let parsed = parse_cleaner_response(raw).expect("parse fallback");

        assert_eq!(parsed.removals.len(), 1);
        assert_eq!(parsed.removals[0].entry_id, 42);
        assert_eq!(parsed.removals[0].reason.as_deref(), Some("junk"));
        assert_eq!(parsed.summary.as_deref(), Some("trimmed logs"));
    }

    #[test]
    fn rejects_non_json_response() {
        let err = parse_cleaner_response("no removals today").expect_err("invalid response");

        assert!(
            err.to_string()
                .contains("context cleaner returned non-JSON output")
        );
    }

    #[test]
    fn normalizes_empty_or_padded_summary() {
        assert_eq!(
            normalize_summary("  trimmed logs  ".to_string()).as_deref(),
            Some("trimmed logs")
        );
        assert_eq!(normalize_summary("  ".to_string()), None);
    }
}
