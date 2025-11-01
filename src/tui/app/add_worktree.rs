use crate::{
    git,
    jira::{self, JiraTicket},
    wtm_paths::{branch_dir_name, next_available_workspace_path},
};
use anyhow::Result;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub(super) enum Suggestion {
    Ticket(JiraTicket),
    LocalBranch(String),
    RemoteBranch {
        remote: String,
        branch: String,
        upstream: String,
    },
}

impl Suggestion {
    fn matches(&self, query: &str) -> bool {
        match self {
            Suggestion::Ticket(ticket) => {
                let key = ticket.key.to_lowercase();
                let summary = ticket.summary.to_lowercase();
                let slug = ticket.slug().to_lowercase();
                key.contains(query) || summary.contains(query) || slug.contains(query)
            }
            Suggestion::LocalBranch(branch) => branch.to_lowercase().contains(query),
            Suggestion::RemoteBranch {
                remote,
                branch,
                upstream,
            } => {
                remote.to_lowercase().contains(query)
                    || branch.to_lowercase().contains(query)
                    || upstream.to_lowercase().contains(query)
            }
        }
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

#[derive(Debug)]
pub(super) struct AddWorktreeState {
    branch: String,
    tickets: Vec<JiraTicket>,
    local_branches: Vec<String>,
    remote_branches: Vec<String>,
    suggestions: Vec<Suggestion>,
    filtered: Vec<usize>,
    selection: Option<usize>,
    show_overlay: bool,
    existing_branches: HashSet<String>,
    branch_exists: bool,
    branch_upstream: Option<String>,
}

impl AddWorktreeState {
    pub(super) fn new(repo_root: &Path) -> Result<(Self, Option<String>)> {
        let mut warnings = Vec::new();

        let tickets = match jira::cached_tickets(repo_root) {
            Ok(tickets) => tickets,
            Err(err) => {
                warnings.push(format!("Failed to load Jira cache: {err}"));
                Vec::new()
            }
        };

        let local_branches = match git::list_branches(repo_root) {
            Ok(branches) => branches,
            Err(err) => {
                warnings.push(format!("Failed to list git branches: {err}"));
                Vec::new()
            }
        };

        let remote_branches = match git::list_remote_branches(repo_root) {
            Ok(branches) => branches,
            Err(err) => {
                warnings.push(format!("Failed to list remote branches: {err}"));
                Vec::new()
            }
        };

        let existing_branches = local_branches.iter().cloned().collect::<HashSet<_>>();

        let mut state = Self {
            branch: String::new(),
            tickets,
            local_branches,
            remote_branches,
            suggestions: Vec::new(),
            filtered: Vec::new(),
            selection: None,
            show_overlay: true,
            existing_branches,
            branch_exists: false,
            branch_upstream: None,
        };
        state.rebuild_suggestions();
        state.recompute_filters();
        let warning = if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" | "))
        };
        Ok((state, warning))
    }

    pub(super) fn refresh_data(&mut self, repo_root: &Path) -> Result<usize> {
        let tickets = jira::refresh_cache(repo_root)?;
        let local_branches = git::list_branches(repo_root)?;
        let remote_branches = git::list_remote_branches(repo_root)?;
        self.tickets = tickets;
        self.local_branches = local_branches;
        self.remote_branches = remote_branches;
        self.existing_branches = self.local_branches.iter().cloned().collect();
        self.show_overlay = true;
        self.rebuild_suggestions();
        self.recompute_filters();
        Ok(self.tickets.len())
    }

    pub(super) fn clear_cache(&mut self, repo_root: &Path) -> Result<()> {
        jira::invalidate_cache(repo_root)?;
        self.tickets.clear();
        self.rebuild_suggestions();
        self.selection = None;
        self.show_overlay = false;
        self.recompute_filters();
        Ok(())
    }

    pub(super) fn branch_trimmed(&self) -> &str {
        self.branch.trim()
    }

    pub(super) fn branch_display(&self) -> &str {
        if self.branch.is_empty() {
            "<branch>"
        } else {
            self.branch_trimmed()
        }
    }

    pub(super) fn branch_exists(&self) -> bool {
        self.branch_exists
    }

    pub(super) fn status_line(&self, workspace_root: &Path) -> String {
        let branch = self.branch_display();
        let target = self.target_preview(workspace_root);
        let mut status = format!("[ADD] Branch: {branch} ⇒ {}", target.display());
        if self.branch_exists() {
            status.push_str(" • existing branch");
        } else if self.branch_trimmed().is_empty() {
            status.push_str(" • enter a branch name");
        }
        if let Some(upstream) = self.branch_upstream() {
            status.push_str(&format!(" • upstream: {upstream}"));
        }
        status.push_str(" • Enter: confirm • Esc: cancel • Tab: insert suggestion");
        status
    }

    pub(super) fn normalized_branch(&self) -> String {
        if self.branch_exists {
            self.branch_trimmed().to_string()
        } else {
            branch_dir_name(self.branch_trimmed())
        }
    }

    pub(super) fn workspace_dir_name(&self) -> String {
        branch_dir_name(self.branch_trimmed())
    }

    pub(super) fn target_preview(&self, workspace_root: &Path) -> PathBuf {
        next_available_workspace_path(workspace_root, &self.workspace_dir_name())
    }

    pub(super) fn overlay_visible(&self) -> bool {
        self.show_overlay && !self.filtered.is_empty()
    }

    pub(super) fn filtered_suggestions(&self) -> impl Iterator<Item = &Suggestion> {
        self.filtered
            .iter()
            .filter_map(|&idx| self.suggestions.get(idx))
    }

    pub(super) fn selected_filtered_index(&self) -> Option<usize> {
        self.selection
    }

    pub(super) fn move_selection_up(&mut self) {
        if self.filtered.is_empty() {
            self.selection = None;
            return;
        }
        let len = self.filtered.len();
        let current = self.selection.unwrap_or(0);
        let next = if current == 0 { len - 1 } else { current - 1 };
        self.selection = Some(next);
    }

    pub(super) fn move_selection_down(&mut self) {
        if self.filtered.is_empty() {
            self.selection = None;
            return;
        }
        let len = self.filtered.len();
        let current = self.selection.unwrap_or(0);
        self.selection = Some((current + 1) % len);
    }

    pub(super) fn accept_selection(&mut self) -> bool {
        let Some((branch, upstream)) =
            self.selected_suggestion()
                .map(|suggestion| match suggestion {
                    Suggestion::Ticket(ticket) => (ticket.slug(), None),
                    Suggestion::LocalBranch(branch) => (branch.clone(), None),
                    Suggestion::RemoteBranch {
                        branch, upstream, ..
                    } => (branch_dir_name(branch), Some(upstream.clone())),
                })
        else {
            return false;
        };

        self.branch = branch;
        self.branch_upstream = upstream;
        self.show_overlay = false;
        self.recompute_filters();
        true
    }

    pub(super) fn backspace(&mut self) {
        self.branch_upstream = None;
        self.branch.pop();
        self.recompute_filters();
    }

    pub(super) fn push_char(&mut self, c: char) {
        self.branch_upstream = None;
        self.branch.push(c);
        self.branch = sanitize_branch_input(&self.branch);
        self.recompute_filters();
    }

    pub(super) fn toggle_overlay(&mut self) {
        if self.filtered.is_empty() {
            self.show_overlay = false;
        } else {
            self.show_overlay = !self.show_overlay;
        }
    }

    pub(super) fn branch_upstream(&self) -> Option<&str> {
        self.branch_upstream.as_deref()
    }

    fn rebuild_suggestions(&mut self) {
        self.suggestions.clear();
        self.suggestions
            .extend(self.tickets.iter().cloned().map(Suggestion::Ticket));
        self.suggestions.extend(
            self.local_branches
                .iter()
                .cloned()
                .map(Suggestion::LocalBranch),
        );
        for remote in &self.remote_branches {
            if let Some((remote_name, branch_name)) = split_remote_branch(remote) {
                self.suggestions.push(Suggestion::RemoteBranch {
                    remote: remote_name,
                    branch: branch_name,
                    upstream: remote.clone(),
                });
            }
        }
    }

    fn selected_suggestion(&self) -> Option<&Suggestion> {
        self.selection
            .and_then(|idx| self.filtered.get(idx))
            .and_then(|&orig| self.suggestions.get(orig))
    }

    fn recompute_filters(&mut self) {
        let trimmed = self.branch.trim();
        self.branch_exists = !trimmed.is_empty() && self.existing_branches.contains(trimmed);
        if trimmed.is_empty() {
            self.filtered = (0..self.suggestions.len()).collect();
        } else {
            let query = trimmed.to_lowercase();
            self.filtered = self
                .suggestions
                .iter()
                .enumerate()
                .filter_map(|(idx, suggestion)| suggestion.matches(&query).then_some(idx))
                .collect();
        }
        if self.filtered.is_empty() {
            self.selection = None;
        } else {
            let idx = self.selection.unwrap_or(0).min(self.filtered.len() - 1);
            self.selection = Some(idx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wtm_paths::branch_dir_name;

    fn sample_state() -> AddWorktreeState {
        let tickets = vec![JiraTicket {
            key: "PROJ-1".into(),
            summary: "Implement feature".into(),
        }];
        let local_branches = vec!["feature/local".into()];
        let remote_branches = vec!["origin/feature/widget".into()];
        let existing_branches = local_branches.iter().cloned().collect::<HashSet<_>>();

        let mut state = AddWorktreeState {
            branch: String::new(),
            tickets,
            local_branches,
            remote_branches,
            suggestions: Vec::new(),
            filtered: Vec::new(),
            selection: None,
            show_overlay: true,
            existing_branches,
            branch_exists: false,
            branch_upstream: None,
        };
        state.rebuild_suggestions();
        state.recompute_filters();
        state
    }

    #[test]
    fn split_remote_branch_extracts_remote_and_branch() {
        let result = split_remote_branch("origin/feature/foo");
        assert_eq!(result, Some(("origin".into(), "feature/foo".into())));
    }

    #[test]
    fn split_remote_branch_returns_none_without_branch() {
        assert_eq!(split_remote_branch("origin"), None);
        assert_eq!(split_remote_branch("origin/"), None);
    }

    #[test]
    fn suggestion_matches_ticket_fields() {
        let ticket = JiraTicket {
            key: "ABC-42".into(),
            summary: "Improve performance".into(),
        };
        let suggestion = Suggestion::Ticket(ticket);
        assert!(suggestion.matches("abc"));
        assert!(suggestion.matches("performance"));
    }

    #[test]
    fn suggestion_matches_remote_branch_components() {
        let suggestion = Suggestion::RemoteBranch {
            remote: "origin".into(),
            branch: "feature/widget".into(),
            upstream: "origin/feature/widget".into(),
        };
        assert!(suggestion.matches("origin"));
        assert!(suggestion.matches("widget"));
        assert!(suggestion.matches("origin/feature"));
    }

    #[test]
    fn accept_selection_for_remote_branch_sets_upstream() {
        let mut state = sample_state();
        state.selection = Some(2);
        assert!(state.accept_selection());
        assert_eq!(state.branch_trimmed(), "feature-widget");
        assert_eq!(state.branch_upstream(), Some("origin/feature/widget"));
    }

    #[test]
    fn accept_selection_for_ticket_generates_slug() {
        let mut state = sample_state();
        state.selection = Some(0);
        assert!(state.accept_selection());
        let expected = branch_dir_name("PROJ-1 Implement feature");
        assert_eq!(state.branch_trimmed(), expected);
        assert_eq!(state.branch_upstream(), None);
    }

    #[test]
    fn recompute_filters_filters_by_query() {
        let mut state = sample_state();
        state.branch = "widget".into();
        state.recompute_filters();
        assert_eq!(state.filtered_suggestions().count(), 1);
        state.selection = Some(0);
        assert!(state.accept_selection());
        assert_eq!(state.branch_trimmed(), "feature-widget");
    }

    #[test]
    fn toggle_overlay_disables_when_no_results() {
        let mut state = sample_state();
        state.suggestions.clear();
        state.filtered.clear();
        state.show_overlay = true;
        state.toggle_overlay();
        assert!(!state.overlay_visible());
    }

    #[test]
    fn backspace_clears_branch_upstream() {
        let mut state = sample_state();
        state.selection = Some(2);
        assert!(state.accept_selection());
        assert!(state.branch_upstream().is_some());
        state.backspace();
        assert!(state.branch_upstream().is_none());
    }

    #[test]
    fn move_selection_wraps_around() {
        let mut state = sample_state();
        state
            .suggestions
            .push(Suggestion::LocalBranch("feature/extra".into()));
        state.filtered = vec![0, 1, 2, 3];
        state.selection = Some(3);
        state.move_selection_down();
        assert_eq!(state.selected_filtered_index(), Some(0));
        state.move_selection_up();
        assert_eq!(state.selected_filtered_index(), Some(3));
    }

    #[test]
    fn branch_exists_detects_local_match() {
        let mut state = sample_state();
        state.branch = "feature/local".into();
        state.recompute_filters();
        assert!(state.branch_exists());
    }
}
fn sanitize_branch_input(value: &str) -> String {
    let mut slug: String = value
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => c,
            _ => '-',
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug.trim_matches('-').to_string()
}
