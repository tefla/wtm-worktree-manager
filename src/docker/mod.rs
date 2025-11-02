use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::{path::Path, process::Command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerContainer {
    pub service: String,
    pub name: String,
    pub status: String,
}

pub fn compose_ps(worktree_path: &Path) -> Result<Vec<DockerContainer>> {
    let output = Command::new("docker")
        .current_dir(worktree_path)
        .args(["compose", "ps", "--format", "json"])
        .output()
        .with_context(|| {
            format!(
                "failed to execute docker compose ps in {}",
                worktree_path.display()
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(stderr.trim().to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ps_output(&stdout)
}

fn parse_ps_output(output: &str) -> Result<Vec<DockerContainer>> {
    let mut containers = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let entry: ComposePsEntry = serde_json::from_str(line)
            .with_context(|| format!("failed to parse docker compose ps entry: {line}"))?;
        let label = entry
            .service
            .clone()
            .filter(|service| !service.is_empty())
            .or_else(|| entry.name.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let mut status = entry.state.unwrap_or_default();
        if let Some(health) = entry
            .health
            .and_then(|h| if h.is_empty() { None } else { Some(h) })
        {
            if !status.is_empty() {
                status.push(' ');
            }
            status.push('(');
            status.push_str(&health);
            status.push(')');
        }
        containers.push(DockerContainer {
            service: label,
            name: entry.name.unwrap_or_default(),
            status,
        });
    }
    Ok(containers)
}

#[derive(Debug, Deserialize)]
struct ComposePsEntry {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Service")]
    service: Option<String>,
    #[serde(rename = "State")]
    state: Option<String>,
    #[serde(rename = "Health")]
    health: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_output_extracts_name_and_status() {
        let sample = r#"
{"Service":"web","Name":"project-web-1","State":"running","Health":"healthy"}
{"Service":"db","Name":"project-db-1","State":"exited","Health":""}
"#;

        let containers = parse_ps_output(sample).expect("parse should succeed");
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].service, "web");
        assert_eq!(containers[0].name, "project-web-1");
        assert_eq!(containers[0].status, "running (healthy)");
        assert_eq!(containers[1].service, "db");
        assert_eq!(containers[1].status, "exited");
    }

    #[test]
    fn parse_ps_output_handles_missing_fields() {
        let sample = r#"{"Name":"orphan","State":"running"}"#;
        let containers = parse_ps_output(sample).expect("parse should succeed");
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].service, "orphan");
        assert_eq!(containers[0].status, "running");
    }
}
