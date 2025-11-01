use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use eframe::{egui, App};

use crate::{
    config::QuickAction,
    git::{self, WorktreeInfo},
    tui::{pty_tab::PtyTab, size::TerminalSize},
    wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path},
};

const INITIAL_TERMINAL_SIZE: TerminalSize = TerminalSize { rows: 24, cols: 90 };
const MIN_TERMINAL_ROWS: u16 = 12;
const MIN_TERMINAL_COLS: u16 = 48;

pub fn run_gui(
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
) -> Result<()> {
    let init = GuiInitState {
        repo_root,
        worktrees,
        quick_actions,
    };
    let native_options = eframe::NativeOptions::default();
    eframe::run_native(
        "WTM Worktree Manager",
        native_options,
        Box::new(move |_cc| Box::new(WtmGui::new(init, DefaultBackend::default()))),
    )
    .map_err(|err| anyhow!("failed to launch GUI: {err}"))
}

struct GuiInitState {
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
}

trait GuiBackend {
    fn list_worktrees(&mut self, repo_root: &Path) -> Result<Vec<WorktreeInfo>>;
    fn add_worktree(&mut self, repo_root: &Path, path: &Path, branch: Option<&str>) -> Result<()>;
    fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()>;
    fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()>;
}

#[derive(Default)]
struct DefaultBackend;

impl GuiBackend for DefaultBackend {
    fn list_worktrees(&mut self, repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
        git::list_worktrees(repo_root)
    }

    fn add_worktree(&mut self, repo_root: &Path, path: &Path, branch: Option<&str>) -> Result<()> {
        git::add_worktree(repo_root, path, branch)
    }

    fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()> {
        git::remove_worktree(repo_root, path, force)
    }

    fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()> {
        spawn_quick_command(repo_root, command)
    }
}

struct GuiWorkspace {
    info: WorktreeInfo,
    tabs: Vec<PtyTab>,
    active_tab: usize,
    next_tab_id: usize,
}

impl GuiWorkspace {
    fn new(info: WorktreeInfo) -> Result<Self> {
        let mut workspace = Self {
            info,
            tabs: Vec::new(),
            active_tab: 0,
            next_tab_id: 1,
        };
        workspace.ensure_primary_tab()?;
        Ok(workspace)
    }

    fn ensure_primary_tab(&mut self) -> Result<()> {
        if self.tabs.is_empty() {
            self.spawn_blank_tab()?;
        }
        Ok(())
    }

    fn spawn_blank_tab(&mut self) -> Result<()> {
        let id = self.next_tab_id;
        self.next_tab_id += 1;
        self.push_tab(format!("Tab {id}"), None)
    }

    #[allow(dead_code)]
    fn spawn_quick_action_tab(&mut self, action: &QuickAction) -> Result<()> {
        let id = self.next_tab_id;
        self.next_tab_id += 1;
        self.push_tab(format!("{} ({id})", action.label), Some(&action.command))
    }

    fn push_tab(&mut self, title: String, bootstrap: Option<&str>) -> Result<()> {
        let tab = PtyTab::new(&title, &self.info.path, INITIAL_TERMINAL_SIZE)?;
        if let Some(command) = bootstrap {
            tab.send_command(command)?;
        }
        self.tabs.push(tab);
        self.active_tab = self.tabs.len().saturating_sub(1);
        Ok(())
    }

    fn tab_titles(&self) -> Vec<String> {
        self.tabs.iter().map(|tab| tab.title()).collect()
    }

    fn tabs_len(&self) -> usize {
        self.tabs.len()
    }

    fn active_tab_index(&self) -> usize {
        self.active_tab
    }

    fn set_active_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.active_tab = index;
        }
    }

    fn active_tab_mut(&mut self) -> Option<&mut PtyTab> {
        self.tabs.get_mut(self.active_tab)
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

    fn info(&self) -> &WorktreeInfo {
        &self.info
    }

    fn update_info(&mut self, info: WorktreeInfo) {
        self.info = info;
    }

    fn path(&self) -> &Path {
        &self.info.path
    }

    fn is_primary(&self, repo_root: &Path) -> bool {
        self.info.path == repo_root
    }

    fn reap_finished(&mut self) {
        self.tabs.retain(|tab| !tab.is_terminated());
        if self.active_tab >= self.tabs.len() && !self.tabs.is_empty() {
            self.active_tab = self.tabs.len() - 1;
        }
    }

    fn needs_repaint(&self) -> bool {
        self.tabs.iter().any(|tab| !tab.is_terminated())
    }
}

#[derive(Clone)]
struct StatusMessage {
    text: String,
    kind: StatusKind,
}

#[derive(Clone)]
enum StatusKind {
    Info,
    Error,
}

impl StatusMessage {
    fn info(message: impl Into<String>) -> Self {
        Self {
            text: message.into(),
            kind: StatusKind::Info,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            text: message.into(),
            kind: StatusKind::Error,
        }
    }
}

impl StatusKind {
    fn color(&self) -> egui::Color32 {
        match self {
            StatusKind::Info => egui::Color32::from_rgb(0, 130, 65),
            StatusKind::Error => egui::Color32::from_rgb(200, 0, 0),
        }
    }
}

struct WtmGui<B: GuiBackend> {
    backend: B,
    repo_root: PathBuf,
    quick_actions: Vec<QuickAction>,
    workspaces: Vec<GuiWorkspace>,
    selected_workspace: usize,
    new_branch: String,
    status: Option<StatusMessage>,
    pending_removal: Option<PathBuf>,
    force_remove: bool,
}

impl<B: GuiBackend> WtmGui<B> {
    fn new(init: GuiInitState, backend: B) -> Self {
        let mut status = None;
        let mut workspaces = Vec::new();
        for info in init.worktrees {
            match GuiWorkspace::new(info) {
                Ok(workspace) => workspaces.push(workspace),
                Err(err) => {
                    status = Some(StatusMessage::error(format!(
                        "Failed to start terminal: {err}"
                    )))
                }
            }
        }
        Self {
            backend,
            repo_root: init.repo_root,
            quick_actions: init.quick_actions,
            workspaces,
            selected_workspace: 0,
            new_branch: String::new(),
            status,
            pending_removal: None,
            force_remove: false,
        }
    }

    fn create_worktree(&mut self) {
        let branch = self.new_branch.trim();
        if branch.is_empty() {
            self.status = Some(StatusMessage::error(
                "Enter a branch name before creating a worktree",
            ));
            return;
        }

        let workspace_root = match ensure_workspace_root(&self.repo_root) {
            Ok(path) => path,
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to prepare workspace: {err}"
                )));
                return;
            }
        };

        let dir_name = branch_dir_name(branch);
        let worktree_path = next_available_workspace_path(&workspace_root, &dir_name);

        match self
            .backend
            .add_worktree(&self.repo_root, &worktree_path, Some(branch))
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!(
                    "Created worktree at {}",
                    worktree_path.display()
                )));
                self.new_branch.clear();
                self.pending_removal = None;
                if let Err(err) = self.reload_worktrees() {
                    self.status = Some(StatusMessage::error(err.to_string()));
                }
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to create worktree: {err}"
                )));
            }
        }
    }

    fn remove_worktree(&mut self, path: &Path) {
        match self
            .backend
            .remove_worktree(&self.repo_root, path, self.force_remove)
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!(
                    "Removed worktree {}",
                    path.display()
                )));
                self.pending_removal = None;
                if let Err(err) = self.reload_worktrees() {
                    self.status = Some(StatusMessage::error(err.to_string()));
                }
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to remove worktree: {err}"
                )));
            }
        }
    }

    fn reload_worktrees(&mut self) -> Result<()> {
        let worktrees = self.backend.list_worktrees(&self.repo_root)?;
        self.sync_workspaces(worktrees);
        Ok(())
    }

    fn sync_workspaces(&mut self, infos: Vec<WorktreeInfo>) {
        let mut updated = Vec::with_capacity(infos.len());
        for info in infos {
            if let Some(index) = self
                .workspaces
                .iter()
                .position(|workspace| workspace.path() == info.path)
            {
                let mut workspace = self.workspaces.remove(index);
                workspace.update_info(info);
                updated.push(workspace);
            } else {
                match GuiWorkspace::new(info) {
                    Ok(workspace) => updated.push(workspace),
                    Err(err) => {
                        self.status = Some(StatusMessage::error(format!(
                            "Failed to start terminal: {err}"
                        )))
                    }
                }
            }
        }

        self.workspaces = updated;
        if self.selected_workspace >= self.workspaces.len() {
            self.selected_workspace = self.workspaces.len().saturating_sub(1);
        }
        if let Some(path) = self.pending_removal.clone() {
            if !self.workspaces.iter().any(|ws| ws.path() == path) {
                self.pending_removal = None;
            }
        }
    }

    fn run_quick_action(&mut self, action: &QuickAction) {
        match self
            .backend
            .spawn_quick_command(&self.repo_root, &action.command)
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!("Started `{}`", action.label)));
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to start `{}`: {err}",
                    action.label
                )));
            }
        }
    }

    fn render_top_panel(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("wtm_gui_top").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("WTM Worktree Manager");
                ui.separator();
                ui.label(self.repo_root.display().to_string());
                if ui.button("Refresh").clicked() {
                    if let Err(err) = self.reload_worktrees() {
                        self.status = Some(StatusMessage::error(err.to_string()));
                    } else {
                        self.status = Some(StatusMessage::info("Refreshed worktrees"));
                    }
                }
            });

            let mut dismiss_status = false;
            if let Some(status) = self.status.clone() {
                ui.horizontal(|ui| {
                    ui.colored_label(status.kind.color(), &status.text);
                    if ui.button("Dismiss").clicked() {
                        dismiss_status = true;
                    }
                });
            }
            if dismiss_status {
                self.status = None;
            }
        });
    }

    fn render_workspace_panel(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("wtm_gui_workspaces")
            .resizable(true)
            .default_width(260.0)
            .show(ctx, |ui| {
                ui.heading("Worktrees");
                if self.workspaces.is_empty() {
                    ui.label("No worktrees available. Create one to start a terminal.");
                    return;
                }

                let mut action = None;

                egui::ScrollArea::vertical()
                    .id_source("workspace_list")
                    .show(ui, |ui| {
                        for (index, workspace) in self.workspaces.iter().enumerate() {
                            let selected = index == self.selected_workspace;
                            let label = workspace.sidebar_label(&self.repo_root);
                            if ui.selectable_label(selected, label).clicked() {
                                action = Some(WorkspaceAction::Select(index));
                            }
                            ui.label(egui::RichText::new(workspace.display_path()).small().weak());

                            ui.horizontal(|row| {
                                let pending = self.pending_removal.as_ref();
                                match pending {
                                    Some(path) if path == workspace.path() => {
                                        if row.button("Confirm removal").clicked() {
                                            action = Some(WorkspaceAction::ConfirmRemoval(
                                                workspace.path().to_path_buf(),
                                            ));
                                        }
                                        if row.button("Cancel").clicked() {
                                            action = Some(WorkspaceAction::CancelRemoval);
                                        }
                                    }
                                    _ => {
                                        if row.button("Remove").clicked() {
                                            action = Some(WorkspaceAction::StageRemoval(
                                                workspace.path().to_path_buf(),
                                                workspace.info().name(),
                                            ));
                                        }
                                    }
                                }
                            });
                            ui.separator();
                        }
                    });

                if let Some(action) = action {
                    self.handle_workspace_action(action);
                }
            });
    }

    fn render_quick_actions(&mut self, ctx: &egui::Context) {
        egui::SidePanel::right("wtm_gui_actions")
            .resizable(false)
            .default_width(220.0)
            .show(ctx, |ui| {
                ui.heading("Quick actions");
                if self.quick_actions.is_empty() {
                    ui.label("No quick actions configured.");
                } else {
                    let mut to_run: Option<QuickAction> = None;
                    for action in &self.quick_actions {
                        if ui.button(&action.label).clicked() && to_run.is_none() {
                            to_run = Some(action.clone());
                        }
                    }
                    if let Some(action) = to_run {
                        self.run_quick_action(&action);
                    }
                }
            });
    }

    fn render_central_panel(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            self.render_terminal_area(ui);
            ui.separator();
            self.render_create_worktree_form(ui);
        });
    }

    fn render_terminal_area(&mut self, ui: &mut egui::Ui) {
        if self.workspaces.is_empty() {
            ui.heading("No workspace selected");
            ui.label("Create or refresh worktrees to launch terminal tabs.");
            return;
        }
        if self.selected_workspace >= self.workspaces.len() {
            self.selected_workspace = self.workspaces.len() - 1;
        }
        let workspace_idx = self.selected_workspace;
        let workspace = &mut self.workspaces[workspace_idx];

        ui.heading(workspace.info().name());
        ui.label(egui::RichText::new(workspace.display_path()).small().weak());

        let mut tab_action = None;
        ui.horizontal(|ui| {
            for (index, title) in workspace.tab_titles().into_iter().enumerate() {
                let selected = index == workspace.active_tab_index();
                if ui.selectable_label(selected, title).clicked() {
                    tab_action = Some(TabAction::Select(index));
                }
            }
            if ui.button("+").clicked() {
                tab_action = Some(TabAction::Spawn);
            }
            if workspace.tabs_len() > 1 && ui.button("Close tab").clicked() {
                tab_action = Some(TabAction::CloseActive);
            }
        });

        if let Some(action) = tab_action {
            match action {
                TabAction::Select(index) => workspace.set_active_tab(index),
                TabAction::Spawn => {
                    if let Err(err) = workspace.spawn_blank_tab() {
                        self.status = Some(StatusMessage::error(err.to_string()));
                    }
                }
                TabAction::CloseActive => {
                    if let Err(err) = workspace.close_active_tab() {
                        self.status = Some(StatusMessage::error(err.to_string()));
                    }
                }
            }
        }

        let active_index = workspace.active_tab_index();
        let Some(tab) = workspace.active_tab_mut() else {
            ui.label("No terminal tabs open.");
            return;
        };

        let available = ui.available_size();
        let (char_width, char_height) = ui.fonts(|fonts| {
            let text_style = egui::TextStyle::Monospace.resolve(ui.style());
            let height = fonts.row_height(&text_style);
            let raw_width = fonts.glyph_width(&text_style, 'W');
            let width = if raw_width <= 0.0 {
                height * 0.6
            } else {
                raw_width
            };
            (width.max(1.0), height.max(1.0))
        });

        let terminal_id = egui::Id::new(("terminal_view", workspace_idx, active_index));
        let desired = egui::vec2(available.x.max(1.0), available.y.max(1.0));
        let (rect, focus_response) = ui.allocate_at_least(desired, egui::Sense::click());
        let area_size = rect.size();
        let rows = (area_size.y / char_height)
            .floor()
            .max(f32::from(MIN_TERMINAL_ROWS)) as u16;
        let cols = (area_size.x / char_width)
            .floor()
            .max(f32::from(MIN_TERMINAL_COLS)) as u16;
        tab.resize_to(TerminalSize::new(rows, cols));

        let text = {
            let parser_handle = tab.parser_handle();
            let text = match parser_handle.read() {
                Ok(parser) => screen_to_string(&parser),
                Err(_) => "[terminal busy]".to_string(),
            };
            text
        };
        let mut child_ui = ui.child_ui(rect, egui::Layout::top_down(egui::Align::LEFT));
        egui::ScrollArea::both()
            .id_source(terminal_id)
            .stick_to_bottom(true)
            .show(&mut child_ui, |ui| {
                ui.add(
                    egui::Label::new(egui::RichText::new(&text).monospace())
                        .sense(egui::Sense::click()),
                );
            });

        if focus_response.clicked() {
            focus_response.request_focus();
        }
        if focus_response.has_focus() {
            if let Err(err) = forward_events_to_tab(&focus_response, tab) {
                self.status = Some(StatusMessage::error(err.to_string()));
            }
        }
    }

    fn render_create_worktree_form(&mut self, ui: &mut egui::Ui) {
        ui.heading("Create worktree");
        ui.horizontal(|ui| {
            ui.label("Branch name");
            ui.text_edit_singleline(&mut self.new_branch);
            if ui.button("Create").clicked() {
                self.create_worktree();
            }
        });
        ui.checkbox(
            &mut self.force_remove,
            "Force removal (discard unmerged changes)",
        );
    }

    fn handle_workspace_action(&mut self, action: WorkspaceAction) {
        match action {
            WorkspaceAction::Select(index) => {
                if index < self.workspaces.len() {
                    self.selected_workspace = index;
                    self.pending_removal = None;
                }
            }
            WorkspaceAction::StageRemoval(path, name) => {
                self.pending_removal = Some(path);
                self.status = Some(StatusMessage::info(format!("Confirm removal of {name}")));
            }
            WorkspaceAction::ConfirmRemoval(path) => {
                self.remove_worktree(&path);
            }
            WorkspaceAction::CancelRemoval => {
                self.pending_removal = None;
                self.status = Some(StatusMessage::info("Cancelled removal"));
            }
        }
    }
}

impl<B> App for WtmGui<B>
where
    B: GuiBackend + 'static,
{
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        for workspace in &mut self.workspaces {
            workspace.reap_finished();
        }
        if self.workspaces.iter().any(|ws| ws.needs_repaint()) {
            ctx.request_repaint();
        }

        self.render_top_panel(ctx);
        self.render_workspace_panel(ctx);
        self.render_quick_actions(ctx);
        self.render_central_panel(ctx);
    }
}

fn screen_to_string(parser: &tui_term::vt100::Parser) -> String {
    let text = parser.screen().contents();
    let trimmed: Vec<String> = text
        .lines()
        .map(|line| line.trim_end_matches(' ').to_string())
        .collect();
    trimmed.join("\n")
}

fn forward_events_to_tab(response: &egui::Response, tab: &mut PtyTab) -> Result<()> {
    let events = response.ctx.input(|input| input.events.clone());
    for event in events {
        match event {
            egui::Event::Text(text) => {
                for ch in text.chars() {
                    let event = KeyEvent::new(KeyCode::Char(ch), KeyModifiers::empty());
                    tab.handle_key_event(event)?;
                }
            }
            egui::Event::Paste(text) => {
                for ch in text.chars() {
                    let event = KeyEvent::new(KeyCode::Char(ch), KeyModifiers::empty());
                    tab.handle_key_event(event)?;
                }
            }
            egui::Event::Key {
                key,
                pressed,
                modifiers,
                ..
            } => {
                if !pressed {
                    continue;
                }
                if let Some(code) = map_special_key(key) {
                    let event = KeyEvent::new(code, map_modifiers(modifiers));
                    tab.handle_key_event(event)?;
                }
            }
            egui::Event::Scroll(delta) => {
                if delta.y.abs() > f32::EPSILON {
                    tab.scroll_scrollback(delta.y.round() as isize);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn map_modifiers(modifiers: egui::Modifiers) -> KeyModifiers {
    let mut result = KeyModifiers::empty();
    if modifiers.shift {
        result.insert(KeyModifiers::SHIFT);
    }
    if modifiers.ctrl {
        result.insert(KeyModifiers::CONTROL);
    }
    if modifiers.alt {
        result.insert(KeyModifiers::ALT);
    }
    if modifiers.mac_cmd || modifiers.command {
        result.insert(KeyModifiers::SUPER);
    }
    result
}

fn map_special_key(key: egui::Key) -> Option<KeyCode> {
    match key {
        egui::Key::Enter => Some(KeyCode::Enter),
        egui::Key::Backspace => Some(KeyCode::Backspace),
        egui::Key::Tab => Some(KeyCode::Tab),
        egui::Key::Escape => Some(KeyCode::Esc),
        egui::Key::ArrowUp => Some(KeyCode::Up),
        egui::Key::ArrowDown => Some(KeyCode::Down),
        egui::Key::ArrowLeft => Some(KeyCode::Left),
        egui::Key::ArrowRight => Some(KeyCode::Right),
        egui::Key::Delete => Some(KeyCode::Delete),
        egui::Key::Home => Some(KeyCode::Home),
        egui::Key::End => Some(KeyCode::End),
        egui::Key::PageUp => Some(KeyCode::PageUp),
        egui::Key::PageDown => Some(KeyCode::PageDown),
        egui::Key::F1 => Some(KeyCode::F(1)),
        egui::Key::F2 => Some(KeyCode::F(2)),
        egui::Key::F3 => Some(KeyCode::F(3)),
        egui::Key::F4 => Some(KeyCode::F(4)),
        egui::Key::F5 => Some(KeyCode::F(5)),
        egui::Key::F6 => Some(KeyCode::F(6)),
        egui::Key::F7 => Some(KeyCode::F(7)),
        egui::Key::F8 => Some(KeyCode::F(8)),
        egui::Key::F9 => Some(KeyCode::F(9)),
        egui::Key::F10 => Some(KeyCode::F(10)),
        egui::Key::F11 => Some(KeyCode::F(11)),
        egui::Key::F12 => Some(KeyCode::F(12)),
        _ => None,
    }
}

enum WorkspaceAction {
    Select(usize),
    StageRemoval(PathBuf, String),
    ConfirmRemoval(PathBuf),
    CancelRemoval,
}

enum TabAction {
    Select(usize),
    Spawn,
    CloseActive,
}

fn spawn_quick_command(repo_root: &Path, command: &str) -> Result<()> {
    if command.trim().is_empty() {
        return Err(anyhow!("quick action command is empty"));
    }

    #[cfg(target_os = "windows")]
    let child = {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C");
        cmd.arg(command);
        cmd.current_dir(repo_root);
        cmd.spawn()
            .with_context(|| format!("failed to run quick action `{command}`"))?
    };

    #[cfg(not(target_os = "windows"))]
    let child = {
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c");
        cmd.arg(command);
        cmd.current_dir(repo_root);
        cmd.spawn()
            .with_context(|| format!("failed to run quick action `{command}`"))?
    };

    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, path::PathBuf};
    use tempfile::tempdir;

    #[derive(Default)]
    struct MockBackend {
        list_results: VecDeque<Result<Vec<WorktreeInfo>>>,
        add_results: VecDeque<Result<()>>,
        remove_results: VecDeque<Result<()>>,
        quick_results: VecDeque<Result<()>>,
        add_calls: Vec<AddCall>,
        remove_calls: Vec<RemoveCall>,
        quick_calls: Vec<QuickCall>,
    }

    struct AddCall {
        repo_root: PathBuf,
        path: PathBuf,
        branch: Option<String>,
    }

    struct RemoveCall {
        _repo_root: PathBuf,
        _path: PathBuf,
        _force: bool,
    }

    struct QuickCall {
        repo_root: PathBuf,
        command: String,
    }

    impl GuiBackend for MockBackend {
        fn list_worktrees(&mut self, _repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
            self.list_results
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        fn add_worktree(
            &mut self,
            repo_root: &Path,
            path: &Path,
            branch: Option<&str>,
        ) -> Result<()> {
            self.add_calls.push(AddCall {
                repo_root: repo_root.to_path_buf(),
                path: path.to_path_buf(),
                branch: branch.map(|b| b.to_string()),
            });
            self.add_results.pop_front().unwrap_or_else(|| Ok(()))
        }

        fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()> {
            self.remove_calls.push(RemoveCall {
                _repo_root: repo_root.to_path_buf(),
                _path: path.to_path_buf(),
                _force: force,
            });
            self.remove_results.pop_front().unwrap_or_else(|| Ok(()))
        }

        fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()> {
            self.quick_calls.push(QuickCall {
                repo_root: repo_root.to_path_buf(),
                command: command.to_string(),
            });
            self.quick_results.pop_front().unwrap_or_else(|| Ok(()))
        }
    }

    fn build_gui(backend: MockBackend, repo_root: PathBuf) -> WtmGui<MockBackend> {
        WtmGui::new(
            GuiInitState {
                repo_root,
                worktrees: Vec::new(),
                quick_actions: Vec::new(),
            },
            backend,
        )
    }

    #[test]
    fn create_worktree_rejects_empty_branch() {
        let temp_repo = tempdir().unwrap();
        let backend = MockBackend::default();
        let mut gui = build_gui(backend, temp_repo.path().to_path_buf());

        gui.create_worktree();

        let status = gui.status.expect("status set");
        assert!(status.text.contains("Enter a branch name"));
        assert!(matches!(status.kind, StatusKind::Error));
        assert!(gui.backend.add_calls.is_empty());
    }

    #[test]
    fn create_worktree_invokes_backend_and_resets_state() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let expected_path = repo_root.join(".wtm/workspaces/feature-test");

        let mut backend = MockBackend::default();
        backend.add_results.push_back(Ok(()));
        backend.list_results.push_back(Ok(Vec::new()));

        let mut gui = build_gui(backend, repo_root.clone());
        gui.new_branch = "feature/test".into();

        gui.create_worktree();

        assert!(matches!(
            gui.status.as_ref().map(|s| &s.kind),
            Some(StatusKind::Info)
        ));
        assert!(gui.new_branch.is_empty());
        assert!(gui.pending_removal.is_none());

        assert_eq!(gui.backend.add_calls.len(), 1);
        let call = &gui.backend.add_calls[0];
        assert_eq!(call.repo_root, repo_root);
        assert_eq!(call.path, expected_path);
        assert_eq!(call.branch.as_deref(), Some("feature/test"));
    }

    #[test]
    fn handle_workspace_actions_update_state() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let mut gui = build_gui(MockBackend::default(), repo_root.clone());
        gui.pending_removal = Some(PathBuf::from("/tmp/worktree"));
        gui.status = None;

        gui.handle_workspace_action(WorkspaceAction::CancelRemoval);
        assert!(gui.pending_removal.is_none());
        assert!(gui
            .status
            .as_ref()
            .map(|s| s.text == "Cancelled removal")
            .unwrap_or(false));
    }

    #[test]
    fn run_quick_action_records_backend_invocation() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let mut backend = MockBackend::default();
        backend.quick_results.push_back(Ok(()));

        let mut gui = build_gui(backend, repo_root.clone());
        let action = QuickAction {
            label: "Deploy".into(),
            command: "echo ok".into(),
        };

        gui.run_quick_action(&action);

        assert_eq!(gui.backend.quick_calls.len(), 1);
        let call = &gui.backend.quick_calls[0];
        assert_eq!(call.repo_root, repo_root);
        assert_eq!(call.command, "echo ok");
        assert!(matches!(
            gui.status.as_ref().map(|s| &s.kind),
            Some(StatusKind::Info)
        ));
    }
}
