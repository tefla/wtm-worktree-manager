use super::run_git;
use anyhow::Result;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct GitStatusSummary {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicts: usize,
}

pub fn status(worktree_path: &Path) -> Result<GitStatusSummary> {
    let output = run_git(["status", "--porcelain=v2", "--branch"], worktree_path)?;
    Ok(parse_status_output(&output))
}

pub fn parse_status_output(output: &str) -> GitStatusSummary {
    let mut summary = GitStatusSummary::default();

    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            parse_branch_line(rest, &mut summary);
            continue;
        }

        if line.starts_with('1') || line.starts_with('2') {
            if let Some(status) = line.split_whitespace().nth(1) {
                let mut chars = status.chars();
                if let Some(x) = chars.next() {
                    if x != '.' {
                        summary.staged += 1;
                    }
                }
                if let Some(y) = chars.next() {
                    if y != '.' {
                        summary.unstaged += 1;
                    }
                }
            }
            continue;
        }

        if line.starts_with('u') {
            summary.conflicts += 1;
            continue;
        }

        if line.starts_with('?') {
            summary.untracked += 1;
            continue;
        }
    }

    summary
}

fn parse_branch_line(line: &str, summary: &mut GitStatusSummary) {
    let mut parts = line.split_whitespace();
    let key = parts.next().unwrap_or_default();
    match key {
        "branch.head" => {
            summary.branch = parts.next().map(|value| value.to_string());
        }
        "branch.upstream" => {
            summary.upstream = parts.next().map(|value| value.to_string());
        }
        "branch.ab" => {
            if let Some(ahead) = parts.next() {
                summary.ahead = ahead.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(behind) = parts.next() {
                summary.behind = behind.trim_start_matches('-').parse().unwrap_or(0);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_output_tracks_branch_metadata() {
        let sample =
            "# branch.head feature/context\n# branch.upstream origin/main\n# branch.ab +2 -1\n";
        let summary = parse_status_output(sample);
        assert_eq!(summary.branch.as_deref(), Some("feature/context"));
        assert_eq!(summary.upstream.as_deref(), Some("origin/main"));
        assert_eq!(summary.ahead, 2);
        assert_eq!(summary.behind, 1);
    }

    #[test]
    fn parse_status_output_counts_file_states() {
        let sample = "\
# branch.head main\n\
1 M. N... 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 file1\n\
1 .M N... 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 file2\n\
2 AA N... 100644 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 file3\n\
? new_file\n\
u UU N... 100644 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 file4\n";
        let summary = parse_status_output(sample);
        assert_eq!(summary.staged, 2);
        assert_eq!(summary.unstaged, 2);
        assert_eq!(summary.untracked, 1);
        assert_eq!(summary.conflicts, 1);
    }
}
