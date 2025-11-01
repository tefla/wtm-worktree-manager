mod add_worktree;
mod input;
mod ui;
mod workspace;

use add_worktree::AddWorktreeState;
use input::handle_key;
use workspace::{QuickActionState, RemoveWorktreeState, WorkspaceState};

use super::size::TerminalSize;
use crate::{
    config::QuickAction,
    git::{self, WorktreeInfo},
    wtm_paths::ensure_workspace_root,
};
use anyhow::Result;
use crossterm::event::{Event, KeyEventKind};
use ratatui::Frame;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Navigation,
    TerminalInput,
    Adding,
    Removing,
    QuickActions,
    Help,
}

pub(super) struct App {
    repo_root: PathBuf,
    workspace_root: PathBuf,
    workspaces: Vec<WorkspaceState>,
    selected_workspace: usize,
    mode: Mode,
    add_state: Option<AddWorktreeState>,
    remove_state: Option<RemoveWorktreeState>,
    quick_actions: Vec<QuickAction>,
    quick_action_state: Option<QuickActionState>,
    next_tab_id: usize,
    should_quit: bool,
    terminal_size: TerminalSize,
    terminal_view_size: Option<TerminalSize>,
    status_message: Option<String>,
}

impl App {
    pub fn new(
        repo_root: PathBuf,
        worktrees: Vec<WorktreeInfo>,
        quick_actions: Vec<QuickAction>,
        size: TerminalSize,
    ) -> Result<Self> {
        let workspace_root = ensure_workspace_root(&repo_root)?;
        let mut next_tab_id = 1;
        let mut workspace_states = Vec::with_capacity(worktrees.len());
        for info in worktrees {
            workspace_states.push(WorkspaceState::new(info, size, &mut next_tab_id)?);
        }

        Ok(Self {
            repo_root,
            workspace_root,
            workspaces: workspace_states,
            selected_workspace: 0,
            mode: Mode::Navigation,
            add_state: None,
            remove_state: None,
            quick_actions,
            quick_action_state: None,
            next_tab_id,
            should_quit: false,
            terminal_size: size,
            terminal_view_size: None,
            status_message: None,
        })
    }

    pub fn draw(&mut self, frame: &mut Frame<'_>) {
        ui::draw(self, frame);
    }

    pub fn handle_event(&mut self, event: Event) -> Result<()> {
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => handle_key(self, key)?,
            Event::Resize(width, height) => {
                self.terminal_size = TerminalSize::new(height, width);
            }
            _ => {}
        }
        Ok(())
    }

    pub fn should_quit(&self) -> bool {
        self.should_quit
    }

    pub fn reap_finished_children(&mut self) {
        for workspace in &mut self.workspaces {
            workspace.reap_finished_children();
        }
    }

    pub(super) fn refresh_worktrees(&mut self) -> Result<()> {
        self.workspace_root = ensure_workspace_root(&self.repo_root)?;
        let updated = git::list_worktrees(&self.repo_root)?;
        let mut existing: HashMap<PathBuf, WorkspaceState> = self
            .workspaces
            .drain(..)
            .map(|ws| (ws.path().to_path_buf(), ws))
            .collect();

        let mut rebuilt = Vec::with_capacity(updated.len());
        for info in updated {
            let path_key = info.path().to_path_buf();
            if let Some(mut ws) = existing.remove(&path_key) {
                ws.update_info(info);
                rebuilt.push(ws);
            } else {
                rebuilt.push(WorkspaceState::new(
                    info,
                    self.terminal_size,
                    &mut self.next_tab_id,
                )?);
            }
        }

        self.workspaces = rebuilt;
        if self.workspaces.is_empty() {
            self.selected_workspace = 0;
        } else if self.selected_workspace >= self.workspaces.len() {
            self.selected_workspace = self.workspaces.len() - 1;
        }
        Ok(())
    }

    pub(super) fn index_of_path(&self, path: &Path) -> Option<usize> {
        self.workspaces.iter().position(|ws| ws.path() == path)
    }

    pub(super) fn set_status<S: Into<String>>(&mut self, message: S) {
        self.status_message = Some(message.into());
    }

    pub(super) fn clear_status(&mut self) {
        self.status_message = None;
    }
}
