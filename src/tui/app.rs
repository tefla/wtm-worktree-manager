use super::{pty_tab::PtyTab, size::TerminalSize};
use crate::{
    config::QuickAction,
    git::{self, WorktreeInfo},
    jira::{self, JiraTicket},
    wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path},
};
use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
    Frame,
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tui_term::widget::{Cursor, PseudoTerminal};

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
        let area = frame.area();
        self.terminal_size = TerminalSize::from_rect(area);

        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(area);

        let body_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(26), Constraint::Min(10)])
            .split(root[0]);

        self.draw_sidebar(frame, body_chunks[0]);
        self.draw_main(frame, body_chunks[1]);
        if matches!(self.mode, Mode::Help) {
            self.draw_help_overlay(frame, root[0]);
        }
        self.draw_status(frame, root[1]);
    }

    pub fn handle_event(&mut self, event: Event) -> Result<()> {
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => self.handle_key(key)?,
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

    fn draw_sidebar(&self, frame: &mut Frame<'_>, area: Rect) {
        let mut state = ListState::default();
        if !self.workspaces.is_empty() {
            state.select(Some(self.selected_workspace));
        }

        let items: Vec<ListItem> = self
            .workspaces
            .iter()
            .map(|ws| ListItem::new(Line::from(ws.sidebar_label(&self.repo_root))))
            .collect();

        let list = List::new(items)
            .block(Block::default().title("Worktrees").borders(Borders::ALL))
            .highlight_style(
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            );

        frame.render_stateful_widget(list, area, &mut state);
    }

    fn draw_main(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if matches!(self.mode, Mode::QuickActions) {
            self.draw_quick_actions(frame, area);
            return;
        }

        let Some(workspace) = self.workspaces.get_mut(self.selected_workspace) else {
            frame.render_widget(
                Block::default()
                    .title("No worktree selected")
                    .borders(Borders::ALL),
                area,
            );
            return;
        };

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(1)])
            .split(area);

        let titles: Vec<Line> = workspace
            .tabs
            .iter()
            .map(|tab| Line::from(tab.title().to_string()))
            .collect();

        let tabs = Tabs::new(titles)
            .block(
                Block::default()
                    .title(workspace.display_path())
                    .borders(Borders::ALL),
            )
            .highlight_style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )
            .select(workspace.active_tab);

        frame.render_widget(tabs, chunks[0]);

        self.terminal_view_size = Some(TerminalSize::from_rect(chunks[1]));

        if let Some(tab) = workspace.tabs.get_mut(workspace.active_tab) {
            let area_size = TerminalSize::from_rect(chunks[1]);
            tab.resize_to(area_size);
            let parser = tab.parser_handle();
            let screen_guard = parser.read().expect("terminal parser poisoned");
            let cursor = Cursor::default().visibility(matches!(self.mode, Mode::TerminalInput));
            let terminal_widget = PseudoTerminal::new(screen_guard.screen())
                .block(Block::default().borders(Borders::ALL))
                .cursor(cursor);
            frame.render_widget(terminal_widget, chunks[1]);
        } else {
            frame.render_widget(
                Paragraph::new("No tabs open. Press `n` to create one.")
                    .block(Block::default().borders(Borders::ALL)),
                chunks[1],
            );
        }

        if matches!(self.mode, Mode::Adding) {
            if let Some(state) = self.add_state.as_ref() {
                if state.overlay_visible() {
                    let overlay_area = centered_rect(60, 50, chunks[1]);
                    frame.render_widget(Clear, overlay_area);

                    let items: Vec<ListItem> = state
                        .filtered_tickets()
                        .map(|ticket| {
                            let slug = ticket.slug();
                            let text = format!("{}  {}  [{}]", ticket.key, ticket.summary, slug);
                            ListItem::new(Line::from(text))
                        })
                        .collect();

                    let mut list_state = ListState::default();
                    list_state.select(state.selected_filtered_index());

                    let list = List::new(items).block(
                        Block::default()
                            .title("Jira tickets (Tab: insert • Ctrl+R: refresh • Ctrl+Shift+R: clear)")
                            .borders(Borders::ALL),
                    );

                    frame.render_stateful_widget(list, overlay_area, &mut list_state);
                }
            }
        }
    }

    fn draw_quick_actions(&self, frame: &mut Frame<'_>, area: Rect) {
        if self.quick_actions.is_empty() {
            frame.render_widget(
                Paragraph::new("No quick actions configured").block(
                    Block::default()
                        .title("Quick Actions")
                        .borders(Borders::ALL),
                ),
                area,
            );
            return;
        }

        let items: Vec<ListItem> = self
            .quick_actions
            .iter()
            .map(|action| {
                let text = format!("{} — {}", action.label, action.command);
                ListItem::new(text)
            })
            .collect();

        let mut state = ListState::default();
        if let Some(selection) = self.quick_action_state.as_ref() {
            if !self.quick_actions.is_empty() {
                let idx = selection.selected.min(self.quick_actions.len() - 1);
                state.select(Some(idx));
            }
        }

        let list = List::new(items)
            .block(
                Block::default()
                    .title("Quick Actions")
                    .borders(Borders::ALL),
            )
            .highlight_style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            );

        frame.render_stateful_widget(list, area, &mut state);
    }

    fn draw_status(&self, frame: &mut Frame<'_>, area: Rect) {
        let mut status = match self.mode {
            Mode::Navigation => "Press ? for help".to_string(),
            Mode::TerminalInput => "[TTY] Ctrl+Space (or Esc) to exit terminal input".to_string(),
            Mode::Adding => self
                .add_state
                .as_ref()
                .map(|state| {
                    let preview = state.target_preview(&self.workspace_root);
                    let mut text = format!(
                        "[ADD] Branch: {} ⇒ {}  (Enter: confirm • Esc: cancel • Tab: insert suggestion • Ctrl+R: refresh)",
                        state.branch_display(),
                        preview.display()
                    );
                    if state.branch_exists() {
                        text.push_str(" • Warning: branch already exists");
                    }
                    text
                })
                .unwrap_or_else(|| "[ADD] Enter branch name (Enter: confirm • Esc: cancel)".into()),
            Mode::Removing => {
                let state = self
                    .remove_state
                    .as_ref()
                    .expect("Remove state should exist while removing");
                format!(
                    "[PRUNE] Remove {}? y: confirm • n/Esc: cancel • f: toggle force ({})",
                    state.target.display(),
                    if state.force { "ON" } else { "off" }
                )
            }
            Mode::QuickActions => "[QUICK] ↑/↓: select • Enter: run • Esc: cancel".to_string(),
            Mode::Help => "[HELP] Esc or ? to close".to_string(),
        };

        if let Some(msg) = &self.status_message {
            if !msg.is_empty() {
                status.push_str("  |  ");
                status.push_str(msg);
            }
        }

        frame.render_widget(
            Paragraph::new(status).style(Style::default().fg(Color::Gray)),
            area,
        );
    }

    fn draw_help_overlay(&self, frame: &mut Frame<'_>, body_area: Rect) {
        let overlay_area = centered_rect(70, 80, body_area);
        frame.render_widget(Clear, overlay_area);
        frame.render_widget(
            Paragraph::new(self.help_text())
                .wrap(Wrap { trim: false })
                .block(Block::default().title("Help").borders(Borders::ALL)),
            overlay_area,
        );
    }

    fn help_text(&self) -> String {
        let mut lines = vec![
            "Controls".to_string(),
            "  q: quit".into(),
            "  ↑/↓: switch worktree".into(),
            "  ←/→: switch tab".into(),
            "  n: new tab".into(),
            "  x: close tab".into(),
            "  Enter: focus terminal".into(),
            "  Ctrl+Space (while focused): exit terminal".into(),
            "  a: add worktree".into(),
            "    ↳ Tab (adding): insert highlighted Jira suggestion".into(),
            "    ↳ Ctrl+R (adding): refresh Jira suggestions".into(),
            "    ↳ Ctrl+Shift+R (adding): clear Jira cache".into(),
            "    ↳ Ctrl+Space (adding): toggle suggestions".into(),
            "    ↳ ↑/↓ (adding): navigate suggestions".into(),
            "  p: prune worktree".into(),
            "  c: open quick actions".into(),
            "  ?: toggle this help".into(),
        ];
        if !self.quick_actions.is_empty() {
            lines.push(String::new());
            lines.push("Quick Actions:".into());
            for action in &self.quick_actions {
                lines.push(format!("  {} — {}", action.label, action.command));
            }
        }
        lines.join("\n")
    }

    fn handle_key(&mut self, key: KeyEvent) -> Result<()> {
        match self.mode {
            Mode::Navigation => self.handle_navigation_key(key),
            Mode::TerminalInput => self.handle_terminal_key(key),
            Mode::Adding => self.handle_add_worktree_key(key),
            Mode::Removing => self.handle_remove_worktree_key(key),
            Mode::QuickActions => self.handle_quick_actions_key(key),
            Mode::Help => {
                if matches!(key.code, KeyCode::Esc | KeyCode::Char('?')) {
                    self.mode = Mode::Navigation;
                }
                Ok(())
            }
        }
    }

    fn handle_navigation_key(&mut self, key: KeyEvent) -> Result<()> {
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Up => {
                if !self.workspaces.is_empty() {
                    if self.selected_workspace == 0 {
                        self.selected_workspace = self.workspaces.len() - 1;
                    } else {
                        self.selected_workspace -= 1;
                    }
                }
            }
            KeyCode::Down => {
                if !self.workspaces.is_empty() {
                    self.selected_workspace = (self.selected_workspace + 1) % self.workspaces.len();
                }
            }
            KeyCode::Left => {
                if let Some(ws) = self.workspaces.get_mut(self.selected_workspace) {
                    ws.select_prev_tab();
                }
            }
            KeyCode::Right => {
                if let Some(ws) = self.workspaces.get_mut(self.selected_workspace) {
                    ws.select_next_tab();
                }
            }
            KeyCode::Char('n') => {
                if let Some(ws) = self.workspaces.get_mut(self.selected_workspace) {
                    let size = self.terminal_view_size.unwrap_or(self.terminal_size);
                    ws.spawn_tab(&mut self.next_tab_id, size)?;
                    self.clear_status();
                }
            }
            KeyCode::Char('x') => {
                if let Some(ws) = self.workspaces.get_mut(self.selected_workspace) {
                    ws.close_active_tab()?;
                    self.clear_status();
                }
            }
            KeyCode::Enter => {
                if let Some(ws) = self.workspaces.get(self.selected_workspace) {
                    if ws.has_tabs() {
                        self.mode = Mode::TerminalInput;
                        self.clear_status();
                    }
                }
            }
            KeyCode::Char('a') => match AddWorktreeState::new(&self.repo_root) {
                Ok((state, warning)) => {
                    self.mode = Mode::Adding;
                    self.add_state = Some(state);
                    if let Some(message) = warning {
                        self.set_status(message);
                    } else {
                        self.clear_status();
                    }
                }
                Err(err) => {
                    self.set_status(format!("Failed to prepare add workflow: {err}"));
                }
            },
            KeyCode::Char('p') => {
                if let Some(ws) = self.workspaces.get(self.selected_workspace) {
                    if ws.is_primary(&self.repo_root) {
                        self.set_status("Cannot prune the primary worktree.");
                    } else {
                        self.mode = Mode::Removing;
                        self.remove_state = Some(RemoveWorktreeState::new(ws.path()));
                        self.clear_status();
                    }
                }
            }
            KeyCode::Char('?') => {
                self.mode = Mode::Help;
                self.clear_status();
            }
            KeyCode::Char('c') => {
                if self.quick_actions.is_empty() {
                    self.set_status("No quick actions configured.");
                } else {
                    let mut state = self.quick_action_state.take().unwrap_or_default();
                    state.clamp(self.quick_actions.len());
                    self.quick_action_state = Some(state);
                    self.mode = Mode::QuickActions;
                    self.clear_status();
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_terminal_key(&mut self, key: KeyEvent) -> Result<()> {
        if key.code == KeyCode::Char(' ') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.mode = Mode::Navigation;
            return Ok(());
        }

        if matches!(key.code, KeyCode::Esc) {
            self.mode = Mode::Navigation;
            return Ok(());
        }

        let Some(ws) = self.workspaces.get_mut(self.selected_workspace) else {
            return Ok(());
        };
        let Some(tab) = ws.tabs.get_mut(ws.active_tab) else {
            return Ok(());
        };
        tab.handle_key_event(key)?;
        Ok(())
    }

    fn handle_add_worktree_key(&mut self, key: KeyEvent) -> Result<()> {
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('r') | KeyCode::Char('R') => {
                    if let Some(state) = self.add_state.as_mut() {
                        if key.modifiers.contains(KeyModifiers::SHIFT) {
                            match state.clear_cache(&self.repo_root) {
                                Ok(_) => self.set_status("Cleared Jira ticket cache."),
                                Err(err) => {
                                    self.set_status(format!("Failed to clear Jira cache: {err}"))
                                }
                            }
                        } else {
                            match state.refresh_data(&self.repo_root) {
                                Ok(count) => {
                                    self.set_status(format!("Refreshed Jira tickets ({count})"))
                                }
                                Err(err) => self
                                    .set_status(format!("Failed to refresh Jira tickets: {err}")),
                            }
                        }
                    }
                    return Ok(());
                }
                KeyCode::Char(' ') => {
                    if let Some(state) = self.add_state.as_mut() {
                        state.toggle_overlay();
                    }
                    return Ok(());
                }
                _ => {}
            }
        }

        match key.code {
            KeyCode::Esc => {
                self.add_state = None;
                self.mode = Mode::Navigation;
            }
            KeyCode::Enter => {
                let Some(state) = self.add_state.take() else {
                    self.mode = Mode::Navigation;
                    return Ok(());
                };
                let branch_name = state.branch_trimmed().to_string();
                if branch_name.is_empty() {
                    self.set_status("Branch name is required.");
                    self.add_state = Some(state);
                    return Ok(());
                }
                self.workspace_root = ensure_workspace_root(&self.repo_root)?;
                let dir_name = branch_dir_name(&branch_name);
                let worktree_path = next_available_workspace_path(&self.workspace_root, &dir_name);
                let branch_exists = state.branch_exists();
                let result = if branch_exists {
                    git::add_worktree_for_branch(
                        &self.repo_root,
                        &worktree_path,
                        branch_name.as_str(),
                    )
                } else {
                    git::add_worktree(&self.repo_root, &worktree_path, Some(branch_name.as_str()))
                };
                match result {
                    Ok(_) => {
                        if branch_exists {
                            self.set_status(format!(
                                "Added worktree {} for existing branch {}",
                                worktree_path.display(),
                                branch_name
                            ));
                        } else {
                            self.set_status(format!(
                                "Created worktree {} for new branch {}",
                                worktree_path.display(),
                                branch_name
                            ));
                        }
                        self.refresh_worktrees()?;
                        if let Some(idx) = self.index_of_path(&worktree_path) {
                            self.selected_workspace = idx;
                        }
                    }
                    Err(err) => {
                        self.set_status(format!("Failed to create worktree: {err}"));
                    }
                }
                self.mode = Mode::Navigation;
            }
            KeyCode::Up => {
                if let Some(state) = self.add_state.as_mut() {
                    state.move_selection_up();
                }
            }
            KeyCode::Down => {
                if let Some(state) = self.add_state.as_mut() {
                    state.move_selection_down();
                }
            }
            KeyCode::Tab => {
                if let Some(state) = self.add_state.as_mut() {
                    if !state.accept_selection() {
                        self.set_status("No suggestion selected.");
                    }
                }
            }
            KeyCode::Backspace => {
                if let Some(state) = self.add_state.as_mut() {
                    state.backspace();
                }
            }
            KeyCode::Char(c) => {
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
                {
                    if let Some(state) = self.add_state.as_mut() {
                        state.push_char(c);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_remove_worktree_key(&mut self, key: KeyEvent) -> Result<()> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('n') => {
                self.remove_state = None;
                self.mode = Mode::Navigation;
            }
            KeyCode::Char('f') => {
                if let Some(state) = self.remove_state.as_mut() {
                    state.force = !state.force;
                }
            }
            KeyCode::Char('y') => {
                let Some(state) = self.remove_state.take() else {
                    self.mode = Mode::Navigation;
                    return Ok(());
                };
                match git::remove_worktree(&self.repo_root, &state.target, state.force) {
                    Ok(_) => {
                        self.set_status(format!("Removed worktree {}", state.target.display()));
                        self.refresh_worktrees()?;
                    }
                    Err(err) => {
                        self.set_status(format!("Failed to remove worktree: {err}"));
                    }
                }
                self.mode = Mode::Navigation;
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_quick_actions_key(&mut self, key: KeyEvent) -> Result<()> {
        let len = self.quick_actions.len();
        if len == 0 {
            self.mode = Mode::Navigation;
            self.quick_action_state = None;
            return Ok(());
        }

        let state = self
            .quick_action_state
            .get_or_insert_with(QuickActionState::default);
        state.clamp(len);

        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Navigation;
            }
            KeyCode::Up => {
                state.move_up(len);
            }
            KeyCode::Down => {
                state.move_down(len);
            }
            KeyCode::Enter => {
                let idx = state.selected.min(len - 1);
                let action = &self.quick_actions[idx];
                if let Some(ws) = self.workspaces.get_mut(self.selected_workspace) {
                    let size = self.terminal_view_size.unwrap_or(self.terminal_size);
                    ws.spawn_quick_action_tab(&mut self.next_tab_id, size, action)?;
                    self.clear_status();
                } else {
                    self.set_status("No workspace selected.");
                }
                self.mode = Mode::Navigation;
            }
            _ => {}
        }
        Ok(())
    }

    fn refresh_worktrees(&mut self) -> Result<()> {
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

    fn index_of_path(&self, path: &Path) -> Option<usize> {
        self.workspaces.iter().position(|ws| ws.path() == path)
    }

    fn set_status<S: Into<String>>(&mut self, message: S) {
        self.status_message = Some(message.into());
    }

    fn clear_status(&mut self) {
        self.status_message = None;
    }
}

struct WorkspaceState {
    info: WorktreeInfo,
    tabs: Vec<PtyTab>,
    active_tab: usize,
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Percentage((100 - percent_y) / 2),
                Constraint::Percentage(percent_y),
                Constraint::Percentage((100 - percent_y) / 2),
            ]
            .as_ref(),
        )
        .split(area);

    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage((100 - percent_x) / 2),
                Constraint::Percentage(percent_x),
                Constraint::Percentage((100 - percent_x) / 2),
            ]
            .as_ref(),
        )
        .split(vertical[1]);

    horizontal[1]
}

impl WorkspaceState {
    fn new(info: WorktreeInfo, size: TerminalSize, next_tab_id: &mut usize) -> Result<Self> {
        let mut workspace = Self {
            info,
            tabs: Vec::new(),
            active_tab: 0,
        };
        workspace.ensure_tab(next_tab_id, size)?;
        Ok(workspace)
    }

    fn update_info(&mut self, info: WorktreeInfo) {
        self.info = info;
    }

    fn sidebar_label(&self, repo_root: &Path) -> String {
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

    fn display_path(&self) -> String {
        self.info.path.display().to_string()
    }

    fn ensure_tab(&mut self, next_tab_id: &mut usize, size: TerminalSize) -> Result<()> {
        if self.tabs.is_empty() {
            self.spawn_tab(next_tab_id, size)?;
        }
        Ok(())
    }

    fn spawn_tab(&mut self, next_tab_id: &mut usize, size: TerminalSize) -> Result<()> {
        let tab_id = *next_tab_id;
        *next_tab_id += 1;
        let title = format!("Tab {tab_id}");
        let tab = PtyTab::new(&title, &self.info.path, size)?;
        self.tabs.push(tab);
        self.active_tab = self.tabs.len().saturating_sub(1);
        Ok(())
    }

    fn spawn_quick_action_tab(
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

    fn select_prev_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        if self.active_tab == 0 {
            self.active_tab = self.tabs.len() - 1;
        } else {
            self.active_tab -= 1;
        }
    }

    fn select_next_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        self.active_tab = (self.active_tab + 1) % self.tabs.len();
    }

    fn close_active_tab(&mut self) -> Result<()> {
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

    fn has_tabs(&self) -> bool {
        !self.tabs.is_empty()
    }

    fn reap_finished_children(&mut self) {
        self.tabs.retain(|tab| !tab.is_terminated());
        if self.active_tab >= self.tabs.len() && !self.tabs.is_empty() {
            self.active_tab = self.tabs.len() - 1;
        }
    }

    fn path(&self) -> &Path {
        &self.info.path
    }

    fn is_primary(&self, repo_root: &Path) -> bool {
        self.info.path == repo_root
    }
}

#[derive(Debug)]
struct AddWorktreeState {
    branch: String,
    tickets: Vec<JiraTicket>,
    filtered: Vec<usize>,
    selection: Option<usize>,
    show_overlay: bool,
    existing_branches: HashSet<String>,
    branch_exists: bool,
}

impl AddWorktreeState {
    fn new(repo_root: &Path) -> Result<(Self, Option<String>)> {
        let mut warnings = Vec::new();

        let tickets = match jira::cached_tickets(repo_root) {
            Ok(tickets) => tickets,
            Err(err) => {
                warnings.push(format!("Failed to load Jira cache: {err}"));
                Vec::new()
            }
        };

        let branches = match git::list_branches(repo_root) {
            Ok(branches) => branches.into_iter().collect::<HashSet<_>>(),
            Err(err) => {
                warnings.push(format!("Failed to list git branches: {err}"));
                HashSet::new()
            }
        };

        let mut state = Self {
            branch: String::new(),
            tickets,
            filtered: Vec::new(),
            selection: None,
            show_overlay: true,
            existing_branches: branches,
            branch_exists: false,
        };
        state.recompute_filters();
        let warning = if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" | "))
        };
        Ok((state, warning))
    }

    fn refresh_data(&mut self, repo_root: &Path) -> Result<usize> {
        let tickets = jira::refresh_cache(repo_root)?;
        let branches = git::list_branches(repo_root)?;
        self.tickets = tickets;
        self.existing_branches = branches.into_iter().collect();
        self.show_overlay = true;
        self.recompute_filters();
        Ok(self.tickets.len())
    }

    fn clear_cache(&mut self, repo_root: &Path) -> Result<()> {
        jira::invalidate_cache(repo_root)?;
        self.tickets.clear();
        self.filtered.clear();
        self.selection = None;
        self.show_overlay = false;
        self.recompute_filters();
        Ok(())
    }

    fn recompute_filters(&mut self) {
        let trimmed = self.branch.trim();
        self.branch_exists = !trimmed.is_empty() && self.existing_branches.contains(trimmed);
        if trimmed.is_empty() {
            self.filtered = (0..self.tickets.len()).collect();
        } else {
            let query = trimmed.to_lowercase();
            self.filtered = self
                .tickets
                .iter()
                .enumerate()
                .filter_map(|(idx, ticket)| {
                    let key = ticket.key.to_lowercase();
                    let summary = ticket.summary.to_lowercase();
                    let slug = ticket.slug().to_lowercase();
                    if key.contains(&query) || summary.contains(&query) || slug.contains(&query) {
                        Some(idx)
                    } else {
                        None
                    }
                })
                .collect();
        }
        if self.filtered.is_empty() {
            self.selection = None;
        } else {
            let idx = self.selection.unwrap_or(0).min(self.filtered.len() - 1);
            self.selection = Some(idx);
        }
    }

    fn branch_trimmed(&self) -> &str {
        self.branch.trim()
    }

    fn branch_display(&self) -> &str {
        if self.branch.is_empty() {
            "<branch>"
        } else {
            &self.branch
        }
    }

    fn branch_exists(&self) -> bool {
        self.branch_exists
    }

    fn target_preview(&self, workspace_root: &Path) -> PathBuf {
        let dir_name = branch_dir_name(self.branch_trimmed());
        next_available_workspace_path(workspace_root, &dir_name)
    }

    fn overlay_visible(&self) -> bool {
        self.show_overlay && !self.filtered.is_empty()
    }

    fn filtered_tickets(&self) -> impl Iterator<Item = &JiraTicket> {
        self.filtered
            .iter()
            .filter_map(|&idx| self.tickets.get(idx))
    }

    fn selected_filtered_index(&self) -> Option<usize> {
        self.selection
    }

    fn selected_ticket(&self) -> Option<&JiraTicket> {
        self.selection
            .and_then(|idx| self.filtered.get(idx))
            .and_then(|&orig| self.tickets.get(orig))
    }

    fn move_selection_up(&mut self) {
        if self.filtered.is_empty() {
            self.selection = None;
            return;
        }
        let len = self.filtered.len();
        let current = self.selection.unwrap_or(0);
        let next = if current == 0 { len - 1 } else { current - 1 };
        self.selection = Some(next);
    }

    fn move_selection_down(&mut self) {
        if self.filtered.is_empty() {
            self.selection = None;
            return;
        }
        let len = self.filtered.len();
        let current = self.selection.unwrap_or(0);
        self.selection = Some((current + 1) % len);
    }

    fn accept_selection(&mut self) -> bool {
        if let Some(ticket) = self.selected_ticket() {
            self.branch = ticket.slug();
            self.show_overlay = false;
            self.recompute_filters();
            true
        } else {
            false
        }
    }

    fn backspace(&mut self) {
        self.branch.pop();
        self.recompute_filters();
    }

    fn push_char(&mut self, c: char) {
        self.branch.push(c);
        self.recompute_filters();
    }

    fn toggle_overlay(&mut self) {
        if self.filtered.is_empty() {
            self.show_overlay = false;
        } else {
            self.show_overlay = !self.show_overlay;
        }
    }
}

#[derive(Debug)]
struct RemoveWorktreeState {
    target: PathBuf,
    force: bool,
}

#[derive(Debug, Default)]
struct QuickActionState {
    selected: usize,
}

impl QuickActionState {
    fn clamp(&mut self, len: usize) {
        if len == 0 {
            self.selected = 0;
        } else if self.selected >= len {
            self.selected = len - 1;
        }
    }

    fn move_up(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        if self.selected == 0 {
            self.selected = len - 1;
        } else {
            self.selected -= 1;
        }
    }

    fn move_down(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        self.selected = (self.selected + 1) % len;
    }
}

impl RemoveWorktreeState {
    fn new(target: &Path) -> Self {
        Self {
            target: target.to_path_buf(),
            force: false,
        }
    }
}
