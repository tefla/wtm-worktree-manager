use crate::{
    docker,
    git::{status, WorktreeInfo},
};
use status::GitStatusSummary;

#[derive(Debug, Default, Clone)]
pub(super) struct WorkspaceContext {
    pub(super) git: Vec<String>,
    pub(super) docker: Vec<String>,
    pub(super) errors: Vec<String>,
}

impl WorkspaceContext {
    pub(super) fn add_error(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }
}

pub(super) fn gather_workspace_context(info: &WorktreeInfo) -> WorkspaceContext {
    let mut context = WorkspaceContext::default();
    context.git.push(format!("Path: {}", info.path.display()));

    if let Some(branch) = info.branch.as_deref() {
        context.git.push(format!("Branch: {branch}"));
    } else {
        context.git.push("Branch: (detached)".into());
    }

    if let Some(head) = info.head.as_deref() {
        let short = head.chars().take(7).collect::<String>();
        context.git.push(format!("HEAD: {short}"));
    }

    if info.is_locked || info.is_prunable {
        let mut flags = Vec::new();
        if info.is_locked {
            flags.push("locked");
        }
        if info.is_prunable {
            flags.push("prunable");
        }
        if !flags.is_empty() {
            context.git.push(format!("Flags: {}", flags.join(", ")));
        }
    }

    match status::status(info.path()) {
        Ok(summary) => append_git_status(&mut context, &summary),
        Err(err) => context.add_error(format!("git status unavailable: {err}")),
    }

    match docker::compose_ps(info.path()) {
        Ok(containers) => {
            if containers.is_empty() {
                context
                    .docker
                    .push("No docker compose services detected.".into());
            } else {
                for container in containers {
                    let label = if container.service.is_empty() {
                        container.name.clone()
                    } else if container.name.is_empty() || container.service == container.name {
                        container.service.clone()
                    } else {
                        format!("{} ({})", container.service, container.name)
                    };
                    let status = if container.status.is_empty() {
                        "unknown".to_string()
                    } else {
                        container.status
                    };
                    context.docker.push(format!("{label} — {status}"));
                }
            }
        }
        Err(err) => context.add_error(format!("docker compose unavailable: {err}")),
    }

    context
}

fn append_git_status(context: &mut WorkspaceContext, summary: &GitStatusSummary) {
    if let Some(upstream) = summary.upstream.as_deref() {
        context.git.push(format!("Upstream: {upstream}"));
    }

    if summary.ahead > 0 || summary.behind > 0 {
        context.git.push(format!(
            "Ahead {} • Behind {}",
            summary.ahead, summary.behind
        ));
    } else {
        context.git.push("In sync with upstream".into());
    }

    context.git.push(format!(
        "Changes — staged: {0}, unstaged: {1}, untracked: {2}, conflicts: {3}",
        summary.staged, summary.unstaged, summary.untracked, summary.conflicts
    ));
}
