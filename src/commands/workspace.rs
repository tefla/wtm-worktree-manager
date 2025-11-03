use crate::git::status::{status as git_status, GitStatusSummary};
use crate::git::{
    add_worktree, add_worktree_for_branch, add_worktree_from_upstream, list_worktrees,
    move_worktree, remove_worktree, WorktreeInfo,
};
use crate::wtm_paths::{
    branch_dir_name, ensure_workspace_root, next_available_workspace_path, sanitize_branch_name,
    workspace_root,
};
use anyhow::{anyhow, bail, Context, Result};
use clap::Args;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Args, Debug, Clone, Default)]
pub struct WorkspaceSelector {
    /// Match a workspace by its directory name
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,
    /// Match a workspace by the git branch it is attached to
    #[arg(long, value_name = "BRANCH")]
    pub branch: Option<String>,
    /// Match a workspace by its filesystem path (relative paths resolve within `.wtm/workspaces`)
    #[arg(long, value_name = "PATH")]
    pub path: Option<PathBuf>,
}

impl WorkspaceSelector {
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.branch.is_none() && self.path.is_none()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSummary {
    pub name: String,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_locked: bool,
    pub is_prunable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTelemetry {
    pub summary: WorkspaceSummary,
    pub status: Option<GitStatusSummary>,
    pub status_error: Option<String>,
    pub disk_usage_bytes: Option<u64>,
    pub disk_usage_error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct TelemetryOptions {
    pub include_status: bool,
    pub include_disk_usage: bool,
}

impl Default for TelemetryOptions {
    fn default() -> Self {
        Self {
            include_status: true,
            include_disk_usage: true,
        }
    }
}

pub fn list_workspaces(repo_root: &Path) -> Result<Vec<WorkspaceSummary>> {
    let worktrees = list_worktrees(repo_root)?;
    Ok(worktrees
        .iter()
        .map(WorkspaceSummary::from_worktree)
        .collect())
}

pub fn create_workspace(
    repo_root: &Path,
    branch: &str,
    upstream: Option<&str>,
    explicit_path: Option<&Path>,
) -> Result<WorkspaceSummary> {
    let sanitized_branch = sanitize_branch_name(branch);
    if sanitized_branch.is_empty() {
        bail!("Branch name is required.");
    }

    let workspace_root = ensure_workspace_root(repo_root).with_context(|| {
        format!(
            "unable to prepare workspace root under {}",
            repo_root.display()
        )
    })?;

    let target_path = resolve_target_path(
        &workspace_root,
        explicit_path,
        &branch_dir_name(&sanitized_branch),
    );

    if target_path.exists() {
        bail!(
            "Target workspace directory {} already exists",
            target_path.display()
        );
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create parent directories for workspace at {}",
                target_path.display()
            )
        })?;
    }

    if let Some(upstream) = upstream {
        add_worktree_from_upstream(repo_root, &target_path, &sanitized_branch, upstream)?;
    } else {
        add_worktree(repo_root, &target_path, Some(&sanitized_branch))?;
    }

    locate_workspace_summary(repo_root, &target_path)
}

pub fn attach_workspace(
    repo_root: &Path,
    branch: &str,
    explicit_path: Option<&Path>,
) -> Result<WorkspaceSummary> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        bail!("Branch name is required.");
    }

    let workspace_root = ensure_workspace_root(repo_root).with_context(|| {
        format!(
            "unable to prepare workspace root under {}",
            repo_root.display()
        )
    })?;

    let target_path =
        resolve_target_path(&workspace_root, explicit_path, &branch_dir_name(trimmed));

    if target_path.exists() {
        bail!(
            "Target workspace directory {} already exists",
            target_path.display()
        );
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create parent directories for workspace at {}",
                target_path.display()
            )
        })?;
    }

    add_worktree_for_branch(repo_root, &target_path, trimmed)?;
    locate_workspace_summary(repo_root, &target_path)
}

pub fn delete_workspace(
    repo_root: &Path,
    selector: &WorkspaceSelector,
    force: bool,
) -> Result<WorkspaceSummary> {
    if selector.is_empty() {
        bail!("Provide at least one selector (name, branch or path) to delete a workspace.");
    }

    let worktrees = list_worktrees(repo_root)?;
    let workspace_root = workspace_root(repo_root);
    let worktree = resolve_single_workspace(&worktrees, &workspace_root, selector)?;

    if worktree.path == repo_root {
        bail!("Refusing to delete the primary repository worktree.");
    }

    let summary = WorkspaceSummary::from_worktree(worktree);
    remove_worktree(repo_root, &worktree.path, force)?;
    Ok(summary)
}

pub fn move_workspace(
    repo_root: &Path,
    selector: &WorkspaceSelector,
    destination: &Path,
    force: bool,
) -> Result<WorkspaceSummary> {
    if selector.is_empty() {
        bail!("Provide at least one selector (name, branch or path) to move a workspace.");
    }

    let worktrees = list_worktrees(repo_root)?;
    let workspace_root = workspace_root(repo_root);
    let worktree = resolve_single_workspace(&worktrees, &workspace_root, selector)?;

    if worktree.path == repo_root {
        bail!("Refusing to move the primary repository worktree.");
    }

    let workspace_root = ensure_workspace_root(repo_root).with_context(|| {
        format!(
            "unable to prepare workspace root under {}",
            repo_root.display()
        )
    })?;
    let target_path =
        resolve_target_path(&workspace_root, Some(destination), worktree.name().as_str());

    if target_path.exists() {
        bail!(
            "Destination workspace directory {} already exists",
            target_path.display()
        );
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create parent directories for workspace at {}",
                target_path.display()
            )
        })?;
    }

    move_worktree(repo_root, &worktree.path, &target_path, force)?;
    locate_workspace_summary(repo_root, &target_path)
}

pub fn workspace_telemetry(
    repo_root: &Path,
    selector: &WorkspaceSelector,
    options: TelemetryOptions,
) -> Result<Vec<WorkspaceTelemetry>> {
    let worktrees = list_worktrees(repo_root)?;
    let workspace_root = workspace_root(repo_root);
    let matches = if selector.is_empty() {
        worktrees.iter().collect()
    } else {
        resolve_workspaces(&worktrees, &workspace_root, selector)?
    };

    matches
        .into_iter()
        .map(|worktree| collect_workspace_telemetry(worktree, options))
        .collect()
}

fn collect_workspace_telemetry(
    worktree: &WorktreeInfo,
    options: TelemetryOptions,
) -> Result<WorkspaceTelemetry> {
    let mut telemetry = WorkspaceTelemetry {
        summary: WorkspaceSummary::from_worktree(worktree),
        status: None,
        status_error: None,
        disk_usage_bytes: None,
        disk_usage_error: None,
    };

    if options.include_status {
        match git_status(worktree.path()) {
            Ok(summary) => telemetry.status = Some(summary),
            Err(err) => telemetry.status_error = Some(err.to_string()),
        }
    }

    if options.include_disk_usage {
        match directory_size(worktree.path()) {
            Ok(size) => telemetry.disk_usage_bytes = Some(size),
            Err(err) => telemetry.disk_usage_error = Some(err.to_string()),
        }
    }

    Ok(telemetry)
}

fn resolve_target_path(
    workspace_root: &Path,
    explicit: Option<&Path>,
    fallback_name: &str,
) -> PathBuf {
    match explicit {
        Some(path) => normalise_workspace_path(path, workspace_root),
        None => next_available_workspace_path(workspace_root, fallback_name),
    }
}

fn normalise_workspace_path(path: &Path, workspace_root: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace_root.join(path)
    }
}

fn locate_workspace_summary(repo_root: &Path, path: &Path) -> Result<WorkspaceSummary> {
    let worktrees = list_worktrees(repo_root)?;
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo_root.join(path)
    };

    worktrees
        .iter()
        .find(|wt| wt.path == absolute)
        .map(WorkspaceSummary::from_worktree)
        .ok_or_else(|| anyhow!("unable to locate workspace at {}", absolute.display()))
}

fn resolve_workspaces<'a>(
    worktrees: &'a [WorktreeInfo],
    workspace_root: &Path,
    selector: &WorkspaceSelector,
) -> Result<Vec<&'a WorktreeInfo>> {
    let mut matches: Vec<&WorktreeInfo> = worktrees
        .iter()
        .filter(|worktree| matches_selector(worktree, workspace_root, selector))
        .collect();

    if matches.is_empty() {
        bail!("No workspaces match the provided selector.");
    }

    matches.sort_by_key(|wt| wt.name());
    Ok(matches)
}

fn resolve_single_workspace<'a>(
    worktrees: &'a [WorktreeInfo],
    workspace_root: &Path,
    selector: &WorkspaceSelector,
) -> Result<&'a WorktreeInfo> {
    let matches = resolve_workspaces(worktrees, workspace_root, selector)?;
    if matches.len() > 1 {
        bail!("Multiple workspaces match the provided selector; narrow the query.");
    }
    Ok(matches[0])
}

fn matches_selector(
    worktree: &WorktreeInfo,
    workspace_root: &Path,
    selector: &WorkspaceSelector,
) -> bool {
    if let Some(name) = selector.name.as_deref() {
        if worktree.name() != name {
            return false;
        }
    }

    if let Some(branch) = selector.branch.as_deref() {
        if worktree.branch.as_deref() != Some(branch) {
            return false;
        }
    }

    if let Some(path) = selector.path.as_deref() {
        let target = normalise_workspace_path(path, workspace_root);
        if worktree.path != target {
            return false;
        }
    }

    true
}

fn directory_size(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect metadata for {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if metadata.is_dir() {
        let mut total = 0u64;
        for entry in fs::read_dir(path)
            .with_context(|| format!("failed to enumerate directory {}", path.display()))?
        {
            let entry =
                entry.with_context(|| format!("failed to read entry inside {}", path.display()))?;
            total += directory_size(&entry.path())?;
        }
        return Ok(total);
    }
    Ok(0)
}

impl WorkspaceSummary {
    fn from_worktree(worktree: &WorktreeInfo) -> Self {
        Self {
            name: worktree.name(),
            path: worktree.path.clone(),
            branch: worktree.branch.clone(),
            head: worktree.head.clone(),
            is_locked: worktree.is_locked,
            is_prunable: worktree.is_prunable,
        }
    }
}
