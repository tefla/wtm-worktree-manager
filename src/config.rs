use anyhow::{Context, Result};
use serde::Deserialize;
use std::{fs, path::Path};

#[derive(Clone, Debug)]
pub struct QuickAction {
    pub label: String,
    pub command: String,
}

#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default, rename = "quickAccess")]
    quick_access: Vec<QuickAccessEntry>,
}

#[derive(Deserialize)]
struct QuickAccessEntry {
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "quickCommand")]
    quick_command: Option<String>,
    #[serde(default, rename = "type")]
    entry_type: Option<String>,
}

/// Load quick-action definitions from `.wtm/config.json`.
pub fn load_quick_actions(wtm_dir: &Path) -> Result<Vec<QuickAction>> {
    let config_path = wtm_dir.join("config.json");
    let data = match fs::read_to_string(&config_path) {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(err).with_context(|| format!("failed to read {}", config_path.display()))
        }
    };

    let parsed: ConfigFile = serde_json::from_str(&data)
        .with_context(|| format!("failed to parse {}", config_path.display()))?;

    let mut actions = Vec::new();
    for entry in parsed.quick_access {
        if let Some(command) = entry.quick_command.as_deref() {
            let ty = entry.entry_type.as_deref().unwrap_or("command");
            if ty == "command" {
                let label = entry
                    .label
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| command.to_string());
                actions.push(QuickAction {
                    label,
                    command: command.to_string(),
                });
            }
        }
    }

    Ok(actions)
}
