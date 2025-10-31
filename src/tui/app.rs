use super::{pty_tab::PtyTab, size::TerminalSize};
use crate::{
    config::QuickAction,
    git::{self, WorktreeInfo},
    wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path},
};
use anyhow::Result;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
    Frame,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tui_term::widget::{Cursor, PseudoTerminal};

const TAB_PADDING_WIDTH: u16 = 1;
const TAB_DIVIDER_WIDTH: u16 = 1;

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
    sidebar_area: Option<Rect>,
    tab_inner_area: Option<Rect>,
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
            sidebar_area: None,
            tab_inner_area: None,
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
            Event::Mouse(mouse) => self.handle_mouse(mouse)?,
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

    fn draw_sidebar(&mut self, frame: &mut Frame<'_>, area: Rect) {
        self.sidebar_area = Some(area);

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
        self.tab_inner_area = None;

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

        let inner = chunks[0].inner(Margin::new(1, 1));
        if !inner.is_empty() {
            self.tab_inner_area = Some(inner);
        }

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
                    format!(
                        "[ADD] Branch: {} ⇒ {}  (Enter: confirm • Esc: cancel)",
                        state.branch_display(),
                        preview.display()
                    )
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

    fn handle_mouse(&mut self, event: MouseEvent) -> Result<()> {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left) => {
                if matches!(self.mode, Mode::Help) {
                    self.mode = Mode::Navigation;
                    return Ok(());
                }

                if !matches!(self.mode, Mode::Navigation | Mode::TerminalInput) {
                    return Ok(());
                }

                let column = event.column;
                let row = event.row;

                let mut interacted = false;
                if self.handle_sidebar_click(column, row) {
                    interacted = true;
                } else if self.handle_tab_bar_click(column, row) {
                    interacted = true;
                }

                if interacted {
                    if matches!(self.mode, Mode::TerminalInput) {
                        self.mode = Mode::Navigation;
                    }
                    self.clear_status();
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_sidebar_click(&mut self, column: u16, row: u16) -> bool {
        let Some(area) = self.sidebar_area else {
            return false;
        };
        let inner = area.inner(Margin::new(1, 1));
        if inner.is_empty() {
            return false;
        }
        if column < inner.left() || column >= inner.right() {
            return false;
        }
        if row < inner.top() || row >= inner.bottom() {
            return false;
        }

        let index = usize::from(row - inner.top());
        if index >= self.workspaces.len() {
            return false;
        }

        if self.selected_workspace != index {
            self.selected_workspace = index;
        }
        true
    }

    fn handle_tab_bar_click(&mut self, column: u16, row: u16) -> bool {
        let Some(tab_area) = self.tab_inner_area else {
            return false;
        };

        if tab_area.is_empty()
            || column < tab_area.left()
            || column >= tab_area.right()
            || row < tab_area.top()
            || row >= tab_area.bottom()
        {
            return false;
        }

        let target = {
            let Some(workspace) = self.workspaces.get(self.selected_workspace) else {
                return false;
            };
            Self::tab_index_at(workspace, tab_area, column)
        };

        if let Some(idx) = target {
            if let Some(workspace) = self.workspaces.get_mut(self.selected_workspace) {
                if workspace.active_tab != idx {
                    workspace.active_tab = idx;
                }
            }
            return true;
        }

        false
    }

    fn tab_index_at(workspace: &WorkspaceState, area: Rect, column: u16) -> Option<usize> {
        if workspace.tabs.is_empty() || area.is_empty() {
            return None;
        }

        let mut x = area.left();
        let len = workspace.tabs.len();
        for (idx, tab) in workspace.tabs.iter().enumerate() {
            let last = idx == len - 1;
            let mut remaining_width = area.right().saturating_sub(x);
            if remaining_width == 0 {
                break;
            }

            let left_pad = TAB_PADDING_WIDTH.min(remaining_width);
            let left_pad_end = x.saturating_add(left_pad);
            if column < left_pad_end {
                return Some(idx);
            }
            x = left_pad_end;
            remaining_width = area.right().saturating_sub(x);
            if remaining_width == 0 {
                break;
            }

            let title_width = Line::from(tab.title().to_string())
                .width()
                .min(u16::MAX as usize) as u16;
            let title_width = title_width.min(remaining_width);
            let title_end = x.saturating_add(title_width);
            if column < title_end {
                return Some(idx);
            }
            x = title_end;
            remaining_width = area.right().saturating_sub(x);
            if remaining_width == 0 {
                break;
            }

            let right_pad = TAB_PADDING_WIDTH.min(remaining_width);
            let right_pad_end = x.saturating_add(right_pad);
            if column < right_pad_end {
                return Some(idx);
            }
            x = right_pad_end;

            if last {
                break;
            }

            remaining_width = area.right().saturating_sub(x);
            if remaining_width == 0 {
                break;
            }
            let divider_width = TAB_DIVIDER_WIDTH.min(remaining_width);
            let divider_end = x.saturating_add(divider_width);
            if column < divider_end {
                return None;
            }
            x = divider_end;
        }
        None
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
            KeyCode::Char('a') => {
                self.mode = Mode::Adding;
                self.add_state = Some(AddWorktreeState::default());
                self.clear_status();
            }
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
                if state.branch.trim().is_empty() {
                    self.set_status("Branch name is required.");
                    self.add_state = Some(state);
                    return Ok(());
                }
                self.workspace_root = ensure_workspace_root(&self.repo_root)?;
                let branch_name = state.branch.trim().to_string();
                let dir_name = branch_dir_name(&branch_name);
                let worktree_path = next_available_workspace_path(&self.workspace_root, &dir_name);
                match git::add_worktree(&self.repo_root, &worktree_path, Some(branch_name.as_str()))
                {
                    Ok(_) => {
                        self.set_status(format!("Created worktree {}", worktree_path.display()));
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

#[derive(Debug, Default)]
struct AddWorktreeState {
    branch: String,
}

impl AddWorktreeState {
    fn backspace(&mut self) {
        self.branch.pop();
    }

    fn push_char(&mut self, c: char) {
        self.branch.push(c);
    }

    fn branch_display(&self) -> &str {
        if self.branch.is_empty() {
            "<branch>"
        } else {
            &self.branch
        }
    }

    fn target_preview(&self, workspace_root: &Path) -> PathBuf {
        let dir_name = branch_dir_name(&self.branch);
        next_available_workspace_path(workspace_root, &dir_name)
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
