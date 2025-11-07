use crate::git::{find_repo_root, list_branches, list_remote_branches};
use crate::jira;
use crate::wtm_paths::branch_dir_name;
use anyhow::{Context, Result};
use clap::ValueEnum;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct CompletionSuggestion {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum SuggestionDomain {
    Branches,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum CompletionShell {
    Bash,
    Zsh,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum SuggestionShellFormat {
    Bash,
    Zsh,
}

pub fn generate_shell_completion(shell: CompletionShell) -> Result<String> {
    let script = match shell {
        CompletionShell::Bash => include_str!("../../scripts/completions/wtm.bash"),
        CompletionShell::Zsh => include_str!("../../scripts/completions/wtm.zsh"),
    };
    Ok(script.to_string())
}

pub fn collect_suggestions(
    domain: SuggestionDomain,
    repo_root: &Path,
) -> Result<Vec<CompletionSuggestion>> {
    match domain {
        SuggestionDomain::Branches => branch_suggestions(repo_root),
    }
}

pub fn format_suggestions(
    suggestions: &[CompletionSuggestion],
    query: Option<&str>,
    shell: Option<SuggestionShellFormat>,
) -> Vec<String> {
    let filtered = filter_suggestions(suggestions, query);
    match shell {
        Some(SuggestionShellFormat::Bash) => filtered
            .into_iter()
            .map(|suggestion| format_for_bash(&suggestion))
            .collect(),
        Some(SuggestionShellFormat::Zsh) => filtered
            .into_iter()
            .map(|suggestion| format_for_zsh(&suggestion))
            .collect(),
        None => filtered.into_iter().map(|s| s.value).collect(),
    }
}

pub fn current_repo_root() -> Result<std::path::PathBuf> {
    let cwd = std::env::current_dir().context("unable to determine current directory")?;
    find_repo_root(&cwd)
}

fn branch_suggestions(repo_root: &Path) -> Result<Vec<CompletionSuggestion>> {
    let mut seen = HashSet::new();
    let mut suggestions = Vec::new();

    if let Ok(tickets) = jira::cached_tickets(repo_root) {
        for ticket in tickets {
            let slug = ticket.slug();
            if seen.insert(slug.clone()) {
                suggestions.push(CompletionSuggestion {
                    value: slug,
                    description: Some(format!("{} {}", ticket.key, ticket.summary)),
                    upstream: None,
                    source: Some("ticket".into()),
                });
            }
        }
    }

    if let Ok(local_branches) = list_branches(repo_root) {
        for branch in local_branches {
            if seen.insert(branch.clone()) {
                suggestions.push(CompletionSuggestion {
                    value: branch,
                    description: Some("local branch".into()),
                    upstream: None,
                    source: Some("local".into()),
                });
            }
        }
    }

    if let Ok(remote_branches) = list_remote_branches(repo_root) {
        for remote in remote_branches {
            if let Some((remote_name, branch_name)) = split_remote_branch(&remote) {
                let sanitized = branch_dir_name(&branch_name);
                if seen.insert(sanitized.clone()) {
                    let description = if sanitized == branch_name {
                        format!("remote branch {remote}")
                    } else {
                        format!("remote branch {remote} ⇒ {sanitized}")
                    };
                    suggestions.push(CompletionSuggestion {
                        value: sanitized,
                        description: Some(description),
                        upstream: Some(remote),
                        source: Some(format!("remote:{remote_name}")),
                    });
                }
            }
        }
    }

    Ok(suggestions)
}

fn filter_suggestions(
    suggestions: &[CompletionSuggestion],
    query: Option<&str>,
) -> Vec<CompletionSuggestion> {
    if let Some(query) = query {
        let needle = query.to_lowercase();
        suggestions
            .iter()
            .filter(|suggestion| {
                let mut haystacks = vec![suggestion.value.to_lowercase()];
                if let Some(description) = &suggestion.description {
                    haystacks.push(description.to_lowercase());
                }
                if let Some(upstream) = &suggestion.upstream {
                    haystacks.push(upstream.to_lowercase());
                }
                haystacks.iter().any(|text| text.contains(&needle))
            })
            .cloned()
            .collect()
    } else {
        suggestions.to_vec()
    }
}

fn format_for_bash(suggestion: &CompletionSuggestion) -> String {
    if let Some(description) = suggestion.description.as_deref() {
        format!("{}\t{}", suggestion.value, description)
    } else {
        suggestion.value.clone()
    }
}

fn format_for_zsh(suggestion: &CompletionSuggestion) -> String {
    if let Some(description) = suggestion.description.as_deref() {
        format!("{}:{}", suggestion.value, description)
    } else {
        suggestion.value.clone()
    }
}

fn split_remote_branch(reference: &str) -> Option<(String, String)> {
    let mut parts = reference.splitn(2, '/');
    let remote = parts.next().unwrap_or_default();
    let branch = parts.next().unwrap_or("");
    if branch.is_empty() {
        None
    } else {
        Some((remote.to_string(), branch.to_string()))
    }
}
