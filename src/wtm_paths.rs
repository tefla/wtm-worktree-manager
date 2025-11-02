use std::{
    fs,
    path::{Path, PathBuf},
};

/// Return the `.wtm/workspaces` directory under the supplied repo root.
pub fn workspace_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".wtm/workspaces")
}

/// Create the workspaces folder if it does not already exist.
pub fn ensure_workspace_root(repo_root: &Path) -> std::io::Result<PathBuf> {
    let root = workspace_root(repo_root);
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// Generate a filesystem-safe directory name for the provided branch.
pub fn branch_dir_name(branch: &str) -> String {
    let mut slug: String = branch
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => c,
            _ => '-',
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "worktree".to_string()
    } else {
        slug
    }
}

/// Find the first available workspace path (appending numeric suffixes if needed).
pub fn next_available_workspace_path(root: &Path, base_name: &str) -> PathBuf {
    let candidate = root.join(base_name);
    if !candidate.exists() {
        return candidate;
    }
    let mut counter = 1;
    loop {
        let attempt = root.join(format!("{base_name}-{counter}"));
        if !attempt.exists() {
            return attempt;
        }
        counter += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_dir_name_preserves_hyphen_and_underscore() {
        assert_eq!(branch_dir_name("feature-branch"), "feature-branch");
        assert_eq!(branch_dir_name("feature_branch"), "feature_branch");
    }

    #[test]
    fn branch_dir_name_replaces_spaces_with_single_hyphen() {
        assert_eq!(branch_dir_name("feature branch"), "feature-branch");
        assert_eq!(branch_dir_name("feature  branch"), "feature-branch");
    }
}
