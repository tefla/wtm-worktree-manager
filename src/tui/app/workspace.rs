use super::super::{pty_tab::PtyTab, size::TerminalSize};
use crate::{config::QuickAction, git::WorktreeInfo};
use anyhow::Result;
use std::path::{Path, PathBuf};

pub(super) struct WorkspaceState {
    info: WorktreeInfo,
    tabs: Vec<PtyTab>,
    active_tab: usize,
}

impl WorkspaceState {
    pub(super) fn new(
        info: WorktreeInfo,
        size: TerminalSize,
        next_tab_id: &mut usize,
    ) -> Result<Self> {
        let mut workspace = Self {
            info,
            tabs: Vec::new(),
            active_tab: 0,
        };
        workspace.ensure_tab(next_tab_id, size)?;
        Ok(workspace)
    }

    pub(super) fn update_info(&mut self, info: WorktreeInfo) {
        self.info = info;
    }

    pub(super) fn sidebar_label(&self, repo_root: &Path) -> String {
        let mut label = self.info.name();
        if let Some(branch) = self.info.branch.as_deref() {
            label.push_str(" [");
            label.push_str(branch);
            label.push(']');
        }
        if self.is_primary(repo_root) {
            label.push_str(" (primary)");
        } else if self.info.is_prunable {
            label.push_str(" (prunable)");
        } else if self.info.is_locked {
            label.push_str(" (locked)");
        }
        label
    }

    pub(super) fn display_path(&self) -> String {
        self.info.path.display().to_string()
    }

    pub(super) fn info(&self) -> &WorktreeInfo {
        &self.info
    }

    pub(super) fn tab_titles(&self) -> Vec<String> {
        self.tabs
            .iter()
            .map(|tab| tab.title().to_string())
            .collect()
    }

    pub(super) fn tabs_len(&self) -> usize {
        self.tabs.len()
    }

    pub(super) fn active_tab_index(&self) -> usize {
        self.active_tab
    }

    pub(super) fn active_tab_mut(&mut self) -> Option<&mut PtyTab> {
        self.tabs.get_mut(self.active_tab)
    }

    pub(super) fn set_active_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.active_tab = index;
        }
    }

    pub(super) fn has_tabs(&self) -> bool {
        !self.tabs.is_empty()
    }

    pub(super) fn ensure_tab(&mut self, next_tab_id: &mut usize, size: TerminalSize) -> Result<()> {
        if self.tabs.is_empty() {
            self.spawn_tab(next_tab_id, size)?;
        }
        Ok(())
    }

    pub(super) fn spawn_tab(&mut self, next_tab_id: &mut usize, size: TerminalSize) -> Result<()> {
        let tab_id = *next_tab_id;
        *next_tab_id += 1;
        let title = format!("Tab {tab_id}");
        let tab = PtyTab::new(&title, &self.info.path, size)?;
        self.tabs.push(tab);
        self.active_tab = self.tabs.len().saturating_sub(1);
        Ok(())
    }

    pub(super) fn spawn_quick_action_tab(
        &mut self,
        next_tab_id: &mut usize,
        size: TerminalSize,
        action: &QuickAction,
    ) -> Result<()> {
        let tab_id = *next_tab_id;
        *next_tab_id += 1;
        let title = format!("{} ({tab_id})", action.label);
        let tab = PtyTab::new(&title, &self.info.path, size)?;
        tab.send_command(&action.command)?;
        self.tabs.push(tab);
        self.active_tab = self.tabs.len().saturating_sub(1);
        Ok(())
    }

    pub(super) fn select_prev_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        if self.active_tab == 0 {
            self.active_tab = self.tabs.len() - 1;
        } else {
            self.active_tab -= 1;
        }
    }

    pub(super) fn select_next_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        self.active_tab = (self.active_tab + 1) % self.tabs.len();
    }

    pub(super) fn close_active_tab(&mut self) -> Result<()> {
        if self.tabs.len() <= 1 {
            return Ok(());
        }
        if self.active_tab < self.tabs.len() {
            let _ = self.tabs.remove(self.active_tab);
            if self.active_tab >= self.tabs.len() && !self.tabs.is_empty() {
                self.active_tab = self.tabs.len() - 1;
            }
        }
        Ok(())
    }

    pub(super) fn reap_finished_children(&mut self) {
        self.tabs.retain(|tab| !tab.is_terminated());
        if self.active_tab >= self.tabs.len() && !self.tabs.is_empty() {
            self.active_tab = self.tabs.len() - 1;
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.info.path
    }

    pub(super) fn is_primary(&self, repo_root: &Path) -> bool {
        self.info.path == repo_root
    }
}

#[derive(Debug)]
pub(super) struct RemoveWorktreeState {
    target: PathBuf,
    force: bool,
}

impl RemoveWorktreeState {
    pub(super) fn new(target: &Path) -> Self {
        Self {
            target: target.to_path_buf(),
            force: false,
        }
    }

    pub(super) fn target(&self) -> &Path {
        &self.target
    }

    pub(super) fn toggle_force(&mut self) {
        self.force = !self.force;
    }

    pub(super) fn force(&self) -> bool {
        self.force
    }
}

#[derive(Debug, Default)]
pub(super) struct QuickActionState {
    pub(super) selected: usize,
}

impl QuickActionState {
    pub(super) fn clamp(&mut self, len: usize) {
        if len == 0 {
            self.selected = 0;
        } else if self.selected >= len {
            self.selected = len - 1;
        }
    }

    pub(super) fn move_up(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        if self.selected == 0 {
            self.selected = len - 1;
        } else {
            self.selected -= 1;
        }
    }

    pub(super) fn move_down(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        self.selected = (self.selected + 1) % len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_action_state_wraps_navigation() {
        let mut state = QuickActionState::default();
        state.selected = 0;
        state.move_up(5);
        assert_eq!(state.selected, 4);
        state.move_down(5);
        assert_eq!(state.selected, 0);
        state.selected = 10;
        state.clamp(3);
        assert_eq!(state.selected, 2);
    }
}
