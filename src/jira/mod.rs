use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::wtm_paths::branch_dir_name;

const CACHE_FILE: &str = "jira_cache.json";
const DEFAULT_JQL: &str = "assignee = currentUser() AND statusCategory != Done";
const DEFAULT_FIELDS: &str = "key,summary";
const DEFAULT_LIMIT: &str = "200";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JiraTicket {
    pub key: String,
    pub summary: String,
}

impl JiraTicket {
    pub fn slug(&self) -> String {
        branch_dir_name(&format!("{} {}", self.key, self.summary))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct JiraCacheFile {
    tickets: Vec<JiraTicket>,
}

pub fn cached_tickets(repo_root: &Path) -> Result<Vec<JiraTicket>> {
    if let Some(tickets) = load_cache(repo_root)? {
        return Ok(tickets);
    }
    refresh_cache(repo_root)
}

pub fn refresh_cache(repo_root: &Path) -> Result<Vec<JiraTicket>> {
    let tickets = fetch_tickets()?;
    write_cache(repo_root, &tickets)?;
    Ok(tickets)
}

pub fn invalidate_cache(repo_root: &Path) -> Result<()> {
    let cache_path = cache_path(repo_root);
    if cache_path.exists() {
        fs::remove_file(&cache_path)
            .with_context(|| format!("failed to remove Jira cache at {}", cache_path.display()))?;
    }
    Ok(())
}

fn load_cache(repo_root: &Path) -> Result<Option<Vec<JiraTicket>>> {
    let cache_path = cache_path(repo_root);
    if !cache_path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&cache_path)
        .with_context(|| format!("failed to read Jira cache from {}", cache_path.display()))?;
    let cache: JiraCacheFile = serde_json::from_str(&data).with_context(|| {
        format!(
            "failed to parse Jira cache stored at {}",
            cache_path.display()
        )
    })?;
    Ok(Some(cache.tickets))
}

fn write_cache(repo_root: &Path, tickets: &[JiraTicket]) -> Result<()> {
    let cache_dir = cache_path(repo_root)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo_root.join(".wtm"));
    fs::create_dir_all(&cache_dir).with_context(|| {
        format!(
            "failed to create Jira cache directory at {}",
            cache_dir.display()
        )
    })?;
    let cache = JiraCacheFile {
        tickets: tickets.to_vec(),
    };
    let data = serde_json::to_string_pretty(&cache).context("failed to serialize Jira cache")?;
    fs::write(cache_path(repo_root), data).with_context(|| {
        format!(
            "failed to write Jira cache to {}",
            cache_path(repo_root).display()
        )
    })?;
    Ok(())
}

fn cache_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".wtm").join(CACHE_FILE)
}

fn fetch_tickets() -> Result<Vec<JiraTicket>> {
    fetch_tickets_new_cli().or_else(|primary_err| {
        fetch_tickets_legacy_cli().map_err(|legacy_err| {
            anyhow!(
                "failed to fetch Jira tickets via acli: {primary_err} (legacy fallback error: {legacy_err})"
            )
        })
    })
}

fn fetch_tickets_new_cli() -> Result<Vec<JiraTicket>> {
    let output = Command::new("acli")
        .args([
            "jira",
            "workitem",
            "search",
            "--jql",
            DEFAULT_JQL,
            "--fields",
            DEFAULT_FIELDS,
            "--limit",
            DEFAULT_LIMIT,
            "--json",
        ])
        .output()
        .context("failed to execute acli workitem search for Jira tickets")?;
    if !output.status.success() {
        return Err(anyhow!(
            "acli workitem search command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_acli_output(stdout.trim())
}

fn fetch_tickets_legacy_cli() -> Result<Vec<JiraTicket>> {
    let output = Command::new("acli")
        .args(["jira", "issues", "--format", "json"])
        .output()
        .context("failed to execute legacy acli issues command for Jira tickets")?;
    if !output.status.success() {
        return Err(anyhow!(
            "legacy acli issues command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_acli_output(stdout.trim())
}

fn parse_acli_output(output: &str) -> Result<Vec<JiraTicket>> {
    if output.is_empty() {
        return Ok(Vec::new());
    }

    if let Ok(value) = serde_json::from_str::<Value>(output) {
        if let Some(array) = value.as_array() {
            return Ok(array.iter().filter_map(value_to_ticket).collect());
        }
        if let Some(array) = value.get("issues").and_then(|v| v.as_array()) {
            return Ok(array.iter().filter_map(value_to_ticket).collect());
        }
    }

    let mut tickets = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };
        let summary = parts.collect::<Vec<_>>().join(" ");
        tickets.push(JiraTicket {
            key: key.to_string(),
            summary,
        });
    }
    Ok(tickets)
}

fn value_to_ticket(value: &Value) -> Option<JiraTicket> {
    let key = value.get("key").and_then(Value::as_str)?;
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("fields")
                .and_then(|fields| fields.get("summary"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    Some(JiraTicket {
        key: key.to_string(),
        summary: summary.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_acli_output_handles_json_array() {
        let output = r#"[
            {"key":"ABC-1","summary":"Build automation"},
            {"key":"ABC-2","summary":"Write docs"}
        ]"#;
        let tickets = parse_acli_output(output).unwrap();
        assert_eq!(tickets.len(), 2);
        assert_eq!(tickets[0].key, "ABC-1");
        assert_eq!(tickets[0].summary, "Build automation");
    }

    #[test]
    fn parse_acli_output_handles_nested_fields() {
        let output = json!({
            "issues": [
                {
                    "key": "ABC-3",
                    "fields": {"summary": "Nested summary"}
                }
            ]
        })
        .to_string();
        let tickets = parse_acli_output(&output).unwrap();
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].key, "ABC-3");
        assert_eq!(tickets[0].summary, "Nested summary");
    }

    #[test]
    fn parse_acli_output_handles_plain_text() {
        let output = "ABC-4 implement endpoint";
        let tickets = parse_acli_output(output).unwrap();
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].key, "ABC-4");
        assert_eq!(tickets[0].summary, "implement endpoint");
    }

    #[test]
    fn value_to_ticket_returns_empty_summary_when_missing() {
        let value = json!({"key": "ABC-5"});
        let ticket = value_to_ticket(&value).unwrap();
        assert_eq!(ticket.key, "ABC-5");
        assert_eq!(ticket.summary, "");
    }
}
