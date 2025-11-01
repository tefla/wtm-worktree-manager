//! Git helpers that leverage the `git worktree` command line interface.

use anyhow::{anyhow, Context, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
};

/// Metadata describing a git worktree.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_locked: bool,
    pub is_prunable: bool,
}

impl WorktreeInfo {
    pub fn name(&self) -> String {
        self.path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Locate the repository root directory starting from the supplied folder.
pub fn find_repo_root(start: &Path) -> Result<PathBuf> {
    let output = run_git(["rev-parse", "--show-toplevel"], start)?;
    let repo = output.trim();
    if repo.is_empty() {
        Err(anyhow!("git rev-parse returned an empty path"))
    } else {
        Ok(PathBuf::from(repo))
    }
}

/// Enumerate the known worktrees using `git worktree list --porcelain`.
pub fn list_worktrees(repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
    let output = run_git(["worktree", "list", "--porcelain"], repo_root)?;
    parse_worktree_list(&output, repo_root)
}

/// Create a new worktree by delegating to `git worktree add`.
pub fn add_worktree(repo_root: &Path, path: &Path, branch: Option<&str>) -> Result<()> {
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if let Some(branch) = branch {
        args.push("-b".into());
        args.push(branch.to_string());
    }
    args.push(path.to_string_lossy().into_owned());
    run_git(args, repo_root).map(|_| ())
}

/// Remove an existing worktree via `git worktree remove`.
pub fn remove_worktree(repo_root: &Path, path: &Path, force: bool) -> Result<()> {
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(path.to_string_lossy().into_owned());
    run_git(args, repo_root).map(|_| ())
}

fn run_git<I, S>(args: I, dir: &Path) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut command = Command::new("git");
    command.current_dir(dir);
    for arg in args {
        command.arg(arg.as_ref());
    }
    let output = command
        .output()
        .with_context(|| format!("failed to execute git command in {}", dir.display()))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!("git command failed: {}", stderr.trim()))
    }
}

fn parse_worktree_list(output: &str, repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
    let mut worktrees = Vec::new();
    let mut current: HashMap<&str, Vec<String>> = HashMap::new();

    for line in output.lines().chain([""].iter().copied()) {
        if line.trim().is_empty() {
            if let Some(worktree) = finalize_worktree(&current, repo_root)? {
                worktrees.push(worktree);
            }
            current.clear();
            continue;
        }

        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default().to_string();
        current.entry(key).or_default().push(value);
    }

    Ok(worktrees)
}

fn finalize_worktree(
    values: &HashMap<&str, Vec<String>>,
    repo_root: &Path,
) -> Result<Option<WorktreeInfo>> {
    let Some(paths) = values.get("worktree") else {
        return Ok(None);
    };
    let worktree_path = PathBuf::from(paths.first().unwrap());

    let mut info = WorktreeInfo {
        path: worktree_path,
        head: values.get("HEAD").and_then(|vals| vals.first().cloned()),
        branch: values
            .get("branch")
            .and_then(|vals| vals.first().cloned())
            .map(|b| b.strip_prefix("refs/heads/").unwrap_or(&b).to_string()),
        is_locked: is_flag_set(values, "locked"),
        is_prunable: is_flag_set(values, "prunable"),
    };

    // Normalise relative paths (git outputs them relative to repo root).
    if info.path.is_relative() {
        info.path = repo_root.join(&info.path);
    }

    Ok(Some(info))
}

fn is_flag_set(values: &HashMap<&str, Vec<String>>, key: &str) -> bool {
    if values
        .get(key)
        .map(|vals| !vals.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    values
        .get("option")
        .map(|vals| vals.iter().any(|v| v == key))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_worktree_output_handles_multiple_entries() -> Result<()> {
        let output = "\
worktree /repo/main
HEAD 1234567890abcdef
branch refs/heads/main

worktree /repo/feature
HEAD fedcba0987654321
branch refs/heads/feature
option locked

";
        let repo = Path::new("/repo");
        let worktrees = parse_worktree_list(output, repo)?;
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[0].is_locked);
        assert!(worktrees[1].is_locked);
        Ok(())
    }

    #[test]
    fn run_git_errors_when_command_fails() {
        let temp = TempDir::new().unwrap();
        let err = run_git(["status"], temp.path()).unwrap_err();
        assert!(err.to_string().contains("git command failed"));
    }
}
