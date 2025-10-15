use std::sync::OnceLock;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const DEFAULT_AGENT_NAME: &str = "general";
const DEFAULT_AGENT_PROMPT: &str = "You are a helpful autonomous coding assistant. Follow the assigned task precisely and report results clearly.";

static REGISTRY: OnceLock<AgentRegistry> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
struct AgentConfig {
    prompt: Option<String>,
    prompt_file: Option<String>,
}

#[derive(Default)]
pub struct AgentRegistry {
    agents: HashMap<String, String>,
}

impl AgentRegistry {
    fn new() -> Self {
        let mut map = HashMap::new();
        map.insert(
            DEFAULT_AGENT_NAME.to_string(),
            DEFAULT_AGENT_PROMPT.to_string(),
        );

        if let Some(path) = Self::agents_file()
            && let Ok(contents) = fs::read_to_string(&path) {
                match toml::from_str::<HashMap<String, AgentConfig>>(&contents) {
                    Ok(mut configs) => {
                        for (name, mut cfg) in configs.drain() {
                            if let Some(prompt) = cfg.prompt.take() {
                                map.insert(name, prompt);
                                continue;
                            }
                            if let Some(prompt_file) = cfg.prompt_file.take()
                                && let Some(prompt_path) =
                                    Self::resolve_prompt_path(&path, &prompt_file)
                                    && let Ok(prompt_contents) = fs::read_to_string(prompt_path) {
                                        map.insert(name, prompt_contents);
                                    }
                        }
                    }
                    Err(err) => {
                        tracing::warn!("Failed to parse agents.toml: {err}");
                    }
                }
            }

        Self { agents: map }
    }

    fn agents_file() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".codex").join("agents.toml"))
    }

    fn resolve_prompt_path(base_file: &Path, prompt_file: &str) -> Option<PathBuf> {
        let base_dir = base_file.parent()?;
        let path = Path::new(prompt_file);
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else {
            base_dir.join(path)
        };
        Some(full)
    }

    pub fn global() -> &'static Self {
        REGISTRY.get_or_init(Self::new)
    }

    pub fn system_prompt(&self, name: Option<&str>) -> String {
        let name = name.unwrap_or(DEFAULT_AGENT_NAME);
        self.agents
            .get(name)
            .cloned()
            .unwrap_or_else(|| self.agents[DEFAULT_AGENT_NAME].clone())
    }

    pub fn agent_names(&self) -> Vec<String> {
        let mut keys = self.agents.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        keys
    }
}
